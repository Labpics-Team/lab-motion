import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedClusterBootstrap } from '../../base/bench/compare/methodology.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../..');
const child = path.join(workspace, 'v7-proof/research/implicit-identity-v7/measure-child.mjs');
const base = path.join(workspace, 'base/dist/keyframes/index.js');
const candidate = path.join(workspace, 'candidate/dist/keyframes/index.js');
const evidence = path.join(workspace, 'evidence');
const rawDir = path.join(evidence, 'qualification-v8');
fs.mkdirSync(rawDir, { recursive: true });

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedHashes = {
  [base]: '8f3ef89364b35b9fb8fb4277e99709a26cefa827f88611587265d3fb40465ff7',
  [candidate]: '4f58d7f47bc7767d336b2771990f64fa52e4dd1df0f550fff30bdfc7ff1035be',
};
assert.equal(hash(base), expectedHashes[base]);
assert.equal(hash(candidate), expectedHashes[candidate]);
assert.equal(hash(child), '6c0936ff1b53b0c59597bf801766e213ae4879ad5eb72a0b23949b05a70d1cb0');

// v8 is a fresh precision extension of the unchanged v7 setup oracle, not a
// methodology rewrite and not optional stopping. v7's only failed calibration
// was candidate/candidate setup N=3/default p95: wall 1.013781
// [0.982840, 1.064071], CPU 1.014074 [0.983210, 1.061665], 24 clusters.
// Four times as many fresh independent clusters were fixed before collecting a
// v8 sample. The v7 observations are NOT pooled into the v8 estimator.
const seed = 20260914;
const clusters = 96;
const iterations = 20_000;
const margin = 0.05;
const profile = ['setup', 3, 'default'];
const metricPairs = [
  ['normalizedWall', 'wall'],
  ['normalizedCpu', 'cpu'],
];

const reusedV7Calibration = Object.freeze({
  runId: 34743906349,
  artifactId: 10313686607,
  artifactSha256: '0d870cc72e646f2f24fb749c5bae81ed948883d13ca7b41aec6adb82c0e6f38d',
  baseNullSetupPassed: true,
  baseNullSeekPassed: true,
  candidateNullSeekPassed: true,
  positiveSetupPassed: true,
  positiveSeekPassed: true,
  candidateSamples: 0,
});

function measure(entry, factor, name) {
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
  assert.equal(data.calls, 8192);
  assert.equal(data.warmCalls, 8192);
  assert.equal(data.referenceIterations, 16_777_216);
  assert.equal(data.referenceWarmRuns, 4);
  assert.equal(data.warmCallbackCount, data.warmCalls * 2);
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

function series(label, { aEntry, bEntry }) {
  const a = [];
  const b = [];
  for (let run = 0; run < clusters; run++) {
    const order = run % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
    const rows = {};
    for (const side of order) {
      rows[side] = measure(
        side === 'a' ? aEntry : bEntry,
        1,
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
  return { label, profile, aEntry, bEntry, a, b, ...measured };
}

function equivalent(metric) {
  return metric.p50.low >= 1 - margin && metric.p50.high <= 1 + margin &&
    metric.p95.low >= 1 - margin && metric.p95.high <= 1 + margin;
}

function nonInferior(metric) {
  return metric.p50.high <= 1 + margin && metric.p95.high <= 1 + margin;
}

const result = {
  startedAt: new Date().toISOString(),
  exactBase: '93278bf9b540f93521c7bd4c02f68db458e5db7a',
  exactCandidate: '0b01ae2b34db2b78c11acf9c4242e73538717c95',
  candidateTree: '69fc191b8f7c9e3503e1c1b64b280c00eb219311',
  expectedHashes,
  v7ChildSha256: hash(child),
  seed,
  clusters,
  iterations,
  margin,
  profile,
  affinity: 'CPU0 via taskset -c 0',
  reusedV7Calibration,
  candidateNull: null,
  candidate: null,
  candidateSamples: 0,
  calibrationPassed: false,
  candidatePassed: false,
  verdict: 'UNPROVEN-CALIBRATION',
};

result.candidateNull = series('candidate-null-setup-3-default-v8', {
  aEntry: candidate,
  bEntry: candidate,
});
result.calibrationPassed = metricPairs.every(([, label]) => equivalent(result.candidateNull.normalized[label]));

if (result.calibrationPassed) {
  result.candidate = series('candidate-vs-base-setup-3-default-v8', {
    aEntry: base,
    bEntry: candidate,
  });
  result.candidateSamples = clusters * 4;
  result.candidatePassed = metricPairs.every(([, label]) => nonInferior(result.candidate.normalized[label]));
  result.verdict = result.candidatePassed ? 'GO-TIMING' : 'NO-GO-LATENCY';
}

result.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(evidence, 'qualification-v8-result.json'), JSON.stringify(result, null, 2));
console.log('VERDICT', result.verdict, 'candidateSamples', result.candidateSamples);
