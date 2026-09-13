import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedClusterBootstrap } from '../../base/bench/compare/methodology.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../..');
const base = path.join(workspace, 'base/dist/keyframes/index.js');
const candidate = path.join(workspace, 'candidate/dist/keyframes/index.js');
const setupChild = path.join(workspace, 'v4carrier/research/implicit-identity-v4/measure-child.mjs');
const seekChild = path.join(workspace, 'v5carrier/research/implicit-identity-v5/measure-pair.mjs');
const evidence = path.join(workspace, 'evidence');
const rawSetup = path.join(evidence, 'v6-setup');
const rawSeek = path.join(evidence, 'v6-seek');
fs.mkdirSync(rawSetup, { recursive: true });
fs.mkdirSync(rawSeek, { recursive: true });

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedHashes = {
  base: '8f3ef89364b35b9fb8fb4277e99709a26cefa827f88611587265d3fb40465ff7',
  candidate: '4f58d7f47bc7767d336b2771990f64fa52e4dd1df0f550fff30bdfc7ff1035be',
};
assert.equal(hash(base), expectedHashes.base);
assert.equal(hash(candidate), expectedHashes.candidate);

const seed = 20260913;
const clusters = 24;
const iterations = 20_000;
const margin = 0.05;
const setupProfiles = [
  ['setup', 3, 'default'],
  ['setup', 1025, 'default'],
  ['setup', 1025, 'custom'],
];
const seekProfiles = [
  ['seek', 3, 'default'],
  ['seek', 3, 'custom'],
  ['seek', 1025, 'default'],
];

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
  assert.equal(values.length, clusters);
  assert(values.every((value) => Number.isFinite(value) && value > 0));
  const observed = { p50: median(values), p95: quantile(values, 0.95) };
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const bootP50 = [];
  const bootP95 = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sampled = [];
    for (let i = 0; i < values.length; i++) sampled.push(values[Math.floor(random() * values.length)]);
    bootP50.push(median(sampled));
    bootP95.push(quantile(sampled, 0.95));
  }
  return {
    clusters: values.length,
    p50: { ratio: observed.p50, low: quantile(bootP50, 0.025), high: quantile(bootP50, 0.975) },
    p95: { ratio: observed.p95, low: quantile(bootP95, 0.025), high: quantile(bootP95, 0.975) },
  };
}

function setupMeasure(entry, profile, run, side) {
  const name = `ab-${profile.join('-')}-${run}-${side}`;
  const proc = spawnSync(
    'taskset',
    ['-c', '0', process.execPath, setupChild, entry, ...profile.map(String), '1'],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(rawSetup, `${name}.stderr`), proc.stderr ?? '');
  fs.writeFileSync(path.join(rawSetup, `${name}.json`), proc.stdout ?? '');
  assert.equal(proc.status, 0, JSON.stringify({ name, status: proc.status, error: proc.error, stderr: proc.stderr }));
  const data = JSON.parse(proc.stdout);
  assert.equal(data.node, 'v24.20.0');
  assert.equal(data.factor, 1);
  assert.equal(data.samples.length, 4);
  assert.equal(data.sourceHash, hash(entry));
  assert.equal(data.warmCallbackCount, data.warmCalls * 2);
  for (const sample of data.samples) {
    assert(Number.isFinite(sample.nsPerCall) && sample.nsPerCall > 0);
    assert(Number.isFinite(sample.cpuNsPerCall) && sample.cpuNsPerCall > 0);
  }
  return data;
}

function setupSeries(profile) {
  const a = [];
  const b = [];
  for (let run = 0; run < clusters; run++) {
    const order = run % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
    const rows = {};
    for (const side of order) {
      rows[side] = setupMeasure(side === 'a' ? base : candidate, profile, run, side);
    }
    a.push({ run, semantic: true, samples: rows.a.samples.map((sample) => sample.nsPerCall) });
    b.push({ run, semantic: true, samples: rows.b.samples.map((sample) => sample.nsPerCall) });
  }
  const wall = pairedClusterBootstrap(b, a, { seed, iterations: 10_000 });

  const cpuA = [];
  const cpuB = [];
  for (let run = 0; run < clusters; run++) {
    const aData = JSON.parse(fs.readFileSync(path.join(rawSetup, `ab-${profile.join('-')}-${run}-a.json`), 'utf8'));
    const bData = JSON.parse(fs.readFileSync(path.join(rawSetup, `ab-${profile.join('-')}-${run}-b.json`), 'utf8'));
    cpuA.push({ run, semantic: true, samples: aData.samples.map((sample) => sample.cpuNsPerCall) });
    cpuB.push({ run, semantic: true, samples: bData.samples.map((sample) => sample.cpuNsPerCall) });
  }
  const cpu = pairedClusterBootstrap(cpuB, cpuA, { seed, iterations: 10_000 });
  const output = { harness: 'v4-fresh-process-long-window', profile, wall, cpu };
  console.log('setup', JSON.stringify(output));
  return output;
}

function seekMeasure(profile, run) {
  const name = `ab-${profile.join('-')}-${run}`;
  const proc = spawnSync(
    'taskset',
    ['-c', '0', process.execPath, seekChild, base, candidate, ...profile.map(String), String(run), '0'],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(rawSeek, `${name}.stderr`), proc.stderr ?? '');
  fs.writeFileSync(path.join(rawSeek, `${name}.json`), proc.stdout ?? '');
  assert.equal(proc.status, 0, JSON.stringify({ name, status: proc.status, error: proc.error, stderr: proc.stderr }));
  const data = JSON.parse(proc.stdout);
  assert.equal(data.node, 'v24.20.0');
  assert.equal(data.cluster, run);
  assert.equal(data.positive, false);
  assert.equal(data.warmPhases, 4);
  assert.equal(data.measuredPhases, 4);
  assert.deepEqual(data.measuredOrders, (
    run % 2 === 0
      ? [[0, 1], [1, 0], [1, 0], [0, 1]]
      : [[1, 0], [0, 1], [0, 1], [1, 0]]
  ));
  assert.deepEqual(data.sourceHashes, [expectedHashes.base, expectedHashes.candidate]);
  assert.equal(data.samples[0].length, 4);
  assert.equal(data.samples[1].length, 4);
  assert(Number.isFinite(data.wallRatio) && data.wallRatio > 0);
  assert(Number.isFinite(data.cpuRatio) && data.cpuRatio > 0);
  return data;
}

function seekSeries(profile) {
  const rows = [];
  for (let run = 0; run < clusters; run++) rows.push(seekMeasure(profile, run));
  const wall = summarize(rows.map((row) => row.wallRatio));
  const cpu = summarize(rows.map((row) => row.cpuRatio));
  const output = { harness: 'v5-same-runtime-paired-block', profile, wall, cpu };
  console.log('seek', JSON.stringify(output));
  return output;
}

const report = {
  startedAt: new Date().toISOString(),
  baseSha: '93278bf9b540f93521c7bd4c02f68db458e5db7a',
  candidateSha: '0b01ae2b34db2b78c11acf9c4242e73538717c95',
  candidateTree: '69fc191b8f7c9e3503e1c1b64b280c00eb219311',
  expectedHashes,
  calibrationReceipts: {
    setup: { run: 34736671801, carrier: 'bc3f6e114d25910d7ec94d457e1080af1e018238', artifact: 10311440832 },
    seek: { run: 34739060286, carrier: '52a5d84234af620c6a167516e665933321c863ef', artifact: 10311433272 },
  },
  protocolHashes: {
    setupChild: hash(setupChild),
    seekChild: hash(seekChild),
    stats: hash(path.join(workspace, 'base/bench/compare/methodology.mjs')),
    runner: hash(fileURLToPath(import.meta.url)),
  },
  seed,
  clusters,
  iterations,
  margin,
  setupProfiles,
  seekProfiles,
  candidate: [],
};
const reportPath = path.join(evidence, 'composite-v6-result.json');
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
save();

for (const profile of setupProfiles) {
  report.candidate.push(setupSeries(profile));
  save();
}
for (const profile of seekProfiles) {
  report.candidate.push(seekSeries(profile));
  save();
}

const nonInferior = (metric) =>
  metric.semantic !== false && metric.p50.high <= 1 + margin && metric.p95.high <= 1 + margin;
report.admitted =
  report.candidate.length === 6 &&
  report.candidate.every((row) => nonInferior(row.wall) && nonInferior(row.cpu));
report.finishedAt = new Date().toISOString();
report.verdict = report.admitted ? 'ADMITTED' : 'NO-GO';
save();
console.log('VERDICT', report.verdict);
