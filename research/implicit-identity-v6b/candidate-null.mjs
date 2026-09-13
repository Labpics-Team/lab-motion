import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../..');
const candidate = path.join(workspace, 'candidate/dist/keyframes/index.js');
const child = path.join(workspace, 'v5carrier/research/implicit-identity-v5/measure-pair.mjs');
const evidence = path.join(workspace, 'evidence');
const rawDir = path.join(evidence, 'candidate-null-v6b');
fs.mkdirSync(rawDir, { recursive: true });

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedHash = '4f58d7f47bc7767d336b2771990f64fa52e4dd1df0f550fff30bdfc7ff1035be';
assert.equal(hash(candidate), expectedHash);

const seed = 20260913;
const clusters = 24;
const iterations = 20_000;
const margin = 0.05;
const profiles = [
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

function measure(profile, run) {
  const label = `candidate-null-${profile.join('-')}-${run}`;
  const proc = spawnSync(
    'taskset',
    ['-c', '0', process.execPath, child, candidate, candidate, ...profile.map(String), String(run), '0'],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(rawDir, `${label}.stderr`), proc.stderr ?? '');
  fs.writeFileSync(path.join(rawDir, `${label}.json`), proc.stdout ?? '');
  assert.equal(proc.status, 0, JSON.stringify({ label, run, status: proc.status, error: proc.error, stderr: proc.stderr }));
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
  assert.deepEqual(data.sourceHashes, [expectedHash, expectedHash]);
  assert.equal(data.samples[0].length, 4);
  assert.equal(data.samples[1].length, 4);
  return data;
}

function series(profile) {
  const rows = [];
  for (let run = 0; run < clusters; run++) rows.push(measure(profile, run));
  const wall = summarize(rows.map((row) => row.wallRatio));
  const cpu = summarize(rows.map((row) => row.cpuRatio));
  const parity = {
    wallEven: rows.filter((row) => row.cluster % 2 === 0).map((row) => row.wallRatio),
    wallOdd: rows.filter((row) => row.cluster % 2 === 1).map((row) => row.wallRatio),
    cpuEven: rows.filter((row) => row.cluster % 2 === 0).map((row) => row.cpuRatio),
    cpuOdd: rows.filter((row) => row.cluster % 2 === 1).map((row) => row.cpuRatio),
  };
  const output = { profile, wall, cpu, parity };
  console.log(JSON.stringify(output));
  return output;
}

const report = {
  startedAt: new Date().toISOString(),
  candidateSha: '0b01ae2b34db2b78c11acf9c4242e73538717c95',
  candidateTree: '69fc191b8f7c9e3503e1c1b64b280c00eb219311',
  expectedHash,
  v5Carrier: '52a5d84234af620c6a167516e665933321c863ef',
  protocolHashes: { child: hash(child), runner: hash(fileURLToPath(import.meta.url)) },
  seed,
  clusters,
  iterations,
  margin,
  profiles,
  controls: [],
};
const reportPath = path.join(evidence, 'candidate-null-v6b-result.json');
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
save();

for (const profile of profiles) {
  report.controls.push(series(profile));
  save();
}

const containsOne = (metric) => metric.low <= 1 && metric.high >= 1;
const nullPass = (summary) =>
  containsOne(summary.p50) && summary.p95.low >= 1 - margin && summary.p95.high <= 1 + margin;
report.nullPassed = report.controls.every((row) => nullPass(row.wall) && nullPass(row.cpu));
report.finishedAt = new Date().toISOString();
report.verdict = report.nullPassed ? 'CANDIDATE-NULL-PASS' : 'CANDIDATE-NULL-FAIL';
save();
console.log('VERDICT', report.verdict);
