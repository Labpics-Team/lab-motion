import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../..');
const child = path.join(here, 'measure-pair.mjs');
const base = path.join(workspace, 'base/dist/keyframes/index.js');
const candidate = path.join(workspace, 'candidate/dist/keyframes/index.js');
const evidence = path.join(workspace, 'evidence');
const rawDir = path.join(evidence, 'paired-block-v5');
fs.mkdirSync(rawDir, { recursive: true });

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
const profiles = [
  ['setup', 3, 'default'],
  ['setup', 1025, 'default'],
  ['setup', 1025, 'custom'],
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

function measure(entryA, entryB, profile, run, positive, label) {
  const proc = spawnSync(
    'taskset',
    ['-c', '0', process.execPath, child, entryA, entryB, ...profile.map(String), String(run), positive ? '1' : '0'],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(rawDir, `${label}-${run}.stderr`), proc.stderr ?? '');
  fs.writeFileSync(path.join(rawDir, `${label}-${run}.json`), proc.stdout ?? '');
  assert.equal(proc.status, 0, JSON.stringify({ label, run, status: proc.status, error: proc.error, stderr: proc.stderr }));
  const data = JSON.parse(proc.stdout);
  assert.equal(data.node, 'v24.20.0');
  assert.equal(data.cluster, run);
  assert.equal(data.positive, positive);
  assert.equal(data.warmPhases, 4);
  assert.equal(data.measuredPhases, 4);
  assert.deepEqual(data.measuredOrders, (
    run % 2 === 0
      ? [[0, 1], [1, 0], [1, 0], [0, 1]]
      : [[1, 0], [0, 1], [0, 1], [1, 0]]
  ));
  const expectedSourceHashes = [hash(entryA), hash(entryB)];
  assert.deepEqual(data.sourceHashes, expectedSourceHashes);
  assert.equal(data.samples[0].length, 4);
  assert.equal(data.samples[1].length, 4);
  assert(Number.isFinite(data.wallRatio) && data.wallRatio > 0);
  assert(Number.isFinite(data.cpuRatio) && data.cpuRatio > 0);
  return data;
}

function series(label, profile, { candidateB = false, positiveB = false } = {}) {
  const rows = [];
  const entryB = candidateB ? candidate : base;
  for (let run = 0; run < clusters; run++) {
    rows.push(measure(base, entryB, profile, run, positiveB, label));
  }
  const wall = summarize(rows.map((row) => row.wallRatio));
  const cpu = summarize(rows.map((row) => row.cpuRatio));
  const output = { label, profile, wall, cpu };
  console.log(label, JSON.stringify(output));
  return output;
}

const report = {
  startedAt: new Date().toISOString(),
  baseSha: '93278bf9b540f93521c7bd4c02f68db458e5db7a',
  candidateSha: '0b01ae2b34db2b78c11acf9c4242e73538717c95',
  candidateTree: '69fc191b8f7c9e3503e1c1b64b280c00eb219311',
  expectedHashes,
  protocolHashes: { child: hash(child), runner: hash(fileURLToPath(import.meta.url)) },
  seed,
  clusters,
  iterations,
  margin,
  profiles,
  statistic: 'per-independent-process ratio of four ABBA-balanced same-runtime block totals; cluster bootstrap over ratios',
  calibration: [],
  candidate: [],
  candidateClusters: 0,
};
const reportPath = path.join(evidence, 'paired-block-v5-result.json');
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
save();

for (const profile of profiles) {
  report.calibration.push(series(`aa-${profile.join('-')}`, profile));
  save();
}
report.positive = series('positive', ['setup', 3, 'default'], { positiveB: true });
save();

const containsOne = (ci) => ci.low <= 1 && ci.high >= 1;
const nullMetricPass = (metric) =>
  containsOne(metric.p50) &&
  metric.p95.low >= 1 - margin &&
  metric.p95.high <= 1 + margin;
const positiveMetricPass = (metric) => metric.p50.low > 1.5 && metric.p95.low > 1.5;
report.calibrationPassed =
  report.calibration.every((row) => nullMetricPass(row.wall) && nullMetricPass(row.cpu)) &&
  positiveMetricPass(report.positive.wall) &&
  positiveMetricPass(report.positive.cpu);
save();

if (report.calibrationPassed) {
  for (const profile of profiles) {
    report.candidate.push(series(`ab-${profile.join('-')}`, profile, { candidateB: true }));
    report.candidateClusters += clusters;
    save();
  }
}

const nonInferior = (metric) => metric.p50.high <= 1 + margin && metric.p95.high <= 1 + margin;
report.admitted =
  report.calibrationPassed &&
  report.candidate.length === profiles.length &&
  report.candidate.every((row) => nonInferior(row.wall) && nonInferior(row.cpu));
report.finishedAt = new Date().toISOString();
report.verdict = report.calibrationPassed ? (report.admitted ? 'ADMITTED' : 'NO-GO') : 'UNPROVEN-CALIBRATION';
save();
console.log('VERDICT', report.verdict, 'candidateClusters', report.candidateClusters);
