import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedClusterBootstrap } from '../../base/bench/compare/methodology.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../..');
const child = path.join(here, 'measure-child.mjs');
const base = path.join(workspace, 'base/dist/keyframes/index.js');
const candidate = path.join(workspace, 'candidate/dist/keyframes/index.js');
const evidence = path.join(workspace, 'evidence');
const rawDir = path.join(evidence, 'qualification-v7');
fs.mkdirSync(rawDir, { recursive: true });

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedHashes = { [base]: hash(base), [candidate]: hash(candidate) };
const seed = 20260913;
const clusters = 24;
const iterations = 20_000;
const margin = 0.05;
const profiles = [
  ['setup', 3, 'default'],
  ['seek', 3, 'default'],
  ['seek', 3, 'custom'],
  ['seek', 1025, 'default'],
];
const metricPairs = [
  ['normalizedWall', 'wall'],
  ['normalizedCpu', 'cpu'],
];

function measure(entry, profile, factor, name) {
  const args = ['-c', '0', process.execPath, child, entry, ...profile.map(String), String(factor)];
  const run = spawnSync('taskset', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(rawDir, `${name}.stderr`), run.stderr ?? '');
  assert.equal(run.status, 0, JSON.stringify({ name, status: run.status, error: run.error, stderr: run.stderr }));
  fs.writeFileSync(path.join(rawDir, `${name}.json`), run.stdout);
  const data = JSON.parse(run.stdout);
  assert.equal(data.sourceHash, expectedHashes[entry]);
  assert.equal(data.node, 'v24.20.0');
  assert.equal(data.factor, factor);
  assert.equal(data.samples.length, 4);
  assert.equal(data.referenceIterations, 16_777_216);
  assert.equal(data.referenceWarmRuns, 4);
  assert.equal(data.warmCallbackCount, data.warmCalls * (profile[0] === 'setup' ? 2 : 1));
  for (const sample of data.samples) {
    for (const key of ['nsPerCall', 'cpuNsPerCall', 'normalizedWall', 'normalizedCpu', 'referenceWallNsPerIteration', 'referenceCpuNsPerIteration']) {
      assert(Number.isFinite(sample[key]) && sample[key] > 0, `${name}: invalid ${key}`);
    }
  }
  return data;
}

function bootstrap(rowsB, rowsA, metric) {
  const toClusters = (rows) => rows.map((row) => ({
    run: row.run,
    semantic: true,
    samples: row.data.samples.map((sample) => sample[metric]),
  }));
  return pairedClusterBootstrap(toClusters(rowsB), toClusters(rowsA), { seed, iterations });
}

function series(label, profile, { aEntry = base, bEntry = base, bFactor = 1 } = {}) {
  const a = [];
  const b = [];
  for (let run = 0; run < clusters; run++) {
    const order = run % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
    const rows = {};
    for (const side of order) {
      rows[side] = measure(
        side === 'a' ? aEntry : bEntry,
        profile,
        side === 'b' ? bFactor : 1,
        `${label}-${run}-${side}`,
      );
    }
    a.push({ run, data: rows.a });
    b.push({ run, data: rows.b });
  }
  const measured = {
    normalized: Object.fromEntries(metricPairs.map(([metric, metricLabel]) => [metricLabel, bootstrap(b, a, metric)])),
    raw: {
      wall: bootstrap(b, a, 'nsPerCall'),
      cpu: bootstrap(b, a, 'cpuNsPerCall'),
      referenceWall: bootstrap(b, a, 'referenceWallNsPerIteration'),
      referenceCpu: bootstrap(b, a, 'referenceCpuNsPerIteration'),
    },
  };
  console.log(label, JSON.stringify(measured));
  return { label, profile, aEntry, bEntry, bFactor, a, b, ...measured };
}

const result = {
  startedAt: new Date().toISOString(),
  baseEntry: base,
  candidateEntry: candidate,
  expectedHashes,
  protocolHashes: {
    child: hash(child),
    qualifier: hash(fileURLToPath(import.meta.url)),
    stats: hash(path.join(workspace, 'base/bench/compare/methodology.mjs')),
  },
  seed,
  clusters,
  iterations,
  margin,
  profiles,
  affinity: [0],
  baseNull: [],
  candidateNull: [],
  positives: [],
  candidate: [],
  candidateSamples: 0,
};
const resultPath = path.join(evidence, 'qualification-v7-result.json');
const save = () => fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
save();

// All null controls are complete before the first cross-implementation sample.
for (const profile of profiles) {
  result.baseNull.push(series(`base-null-${profile.join('-')}`, profile));
  save();
}
for (const profile of profiles) {
  result.candidateNull.push(series(`candidate-null-${profile.join('-')}`, profile, {
    aEntry: candidate,
    bEntry: candidate,
  }));
  save();
}
result.positives.push(series('positive-setup-3-default', ['setup', 3, 'default'], { bFactor: 2 }));
result.positives.push(series('positive-seek-1025-default', ['seek', 1025, 'default'], { bFactor: 2 }));
save();

const nullMetricPasses = (metric) =>
  metric.semantic &&
  metric.p50.low >= 1 - margin && metric.p50.high <= 1 + margin &&
  metric.p95.low >= 1 - margin && metric.p95.high <= 1 + margin;
const nullRowPasses = (row) =>
  nullMetricPasses(row.normalized.wall) && nullMetricPasses(row.normalized.cpu);
const positiveMetricPasses = (metric) =>
  metric.semantic && metric.p50.low > 1.5 && metric.p95.low > 1.5;
const positiveRowPasses = (row) =>
  positiveMetricPasses(row.normalized.wall) && positiveMetricPasses(row.normalized.cpu);

const calibrationPassed =
  result.baseNull.every(nullRowPasses) &&
  result.candidateNull.every(nullRowPasses) &&
  result.positives.every(positiveRowPasses);
result.calibrationPassed = calibrationPassed;
save();

if (calibrationPassed) {
  for (const profile of profiles) {
    const row = series(`ab-${profile.join('-')}`, profile, { bEntry: candidate });
    result.candidate.push(row);
    result.candidateSamples += clusters * 4;
    save();
  }
}

const candidateMetricPasses = (metric) =>
  metric.semantic && metric.p50.high <= 1 + margin && metric.p95.high <= 1 + margin;
const candidateRowPasses = (row) =>
  candidateMetricPasses(row.normalized.wall) && candidateMetricPasses(row.normalized.cpu);
const admitted = calibrationPassed && result.candidate.length === profiles.length && result.candidate.every(candidateRowPasses);
result.finishedAt = new Date().toISOString();
result.verdict = calibrationPassed ? (admitted ? 'ADMITTED' : 'NO-GO') : 'UNPROVEN-CALIBRATION';
save();
console.log('VERDICT', result.verdict, 'candidateSamples', result.candidateSamples);