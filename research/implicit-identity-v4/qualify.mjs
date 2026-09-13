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
const rawDir = path.join(evidence, 'qualification-v4');
fs.mkdirSync(rawDir, { recursive: true });

const hash = (file) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedHashes = { [base]: hash(base), [candidate]: hash(candidate) };
const seed = 20260913;
const clusters = 24;
const profiles = [
  ['setup', 3, 'default'],
  ['setup', 1025, 'default'],
  ['setup', 1025, 'custom'],
  ['seek', 3, 'default'],
  ['seek', 3, 'custom'],
  ['seek', 1025, 'default'],
];

function measure(entry, profile, factor, name) {
  const args = [
    '-c',
    '0',
    process.execPath,
    child,
    entry,
    ...profile.map(String),
    String(factor),
  ];
  const run = spawnSync('taskset', args, {
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(rawDir, `${name}.stderr`), run.stderr ?? '');
  assert.equal(
    run.status,
    0,
    JSON.stringify({ name, status: run.status, error: run.error, stderr: run.stderr }),
  );
  fs.writeFileSync(path.join(rawDir, `${name}.json`), run.stdout);
  const data = JSON.parse(run.stdout);
  assert.equal(data.sourceHash, expectedHashes[entry]);
  assert.equal(data.node, 'v24.20.0');
  assert.equal(data.factor, factor);
  assert.equal(data.samples.length, 4);
  const expectedWarm = data.warmCalls * (profile[0] === 'setup' ? 2 : 1);
  assert.equal(data.warmCallbackCount, expectedWarm);
  for (const sample of data.samples) {
    assert(Number.isFinite(sample.nsPerCall) && sample.nsPerCall > 0);
    assert(Number.isFinite(sample.cpuNsPerCall) && sample.cpuNsPerCall >= 0);
  }
  return data;
}

const result = {
  startedAt: new Date().toISOString(),
  baseEntry: base,
  candidateEntry: candidate,
  expectedHashes,
  protocolHashes: {
    child: hash(child),
    stats: hash(path.join(workspace, 'base/bench/compare/methodology.mjs')),
  },
  seed,
  clusters,
  profiles,
  affinity: [0],
  calibration: [],
  candidate: [],
  candidateSamples: 0,
};
const resultPath = path.join(evidence, 'qualification-v4-result.json');
const save = () => fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
save();

function bootstrap(rowsB, rowsA, metric) {
  const b = rowsB.map((row) => ({
    run: row.run,
    semantic: true,
    samples: row.data.samples.map((sample) => sample[metric]),
  }));
  const a = rowsA.map((row) => ({
    run: row.run,
    semantic: true,
    samples: row.data.samples.map((sample) => sample[metric]),
  }));
  return pairedClusterBootstrap(b, a, { seed, iterations: 10_000 });
}

function series(label, profile, { candidateB = false, positiveB = false } = {}) {
  const a = [];
  const b = [];
  for (let run = 0; run < clusters; run++) {
    const order = run % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
    const rows = {};
    for (const side of order) {
      const entry = side === 'b' && candidateB ? candidate : base;
      const factor = side === 'b' && positiveB ? 2 : 1;
      rows[side] = measure(entry, profile, factor, `${label}-${run}-${side}`);
    }
    a.push({ run, data: rows.a });
    b.push({ run, data: rows.b });
  }
  const wall = bootstrap(b, a, 'nsPerCall');
  const cpu = bootstrap(b, a, 'cpuNsPerCall');
  console.log(label, JSON.stringify({ wall, cpu }));
  return { label, profile, a, b, wall, cpu };
}

for (const profile of profiles) {
  result.calibration.push(series(`aa-${profile.join('-')}`, profile));
  save();
}
result.positive = series('positive', ['setup', 3, 'default'], { positiveB: true });
save();

const containsOne = (ci) => ci.low <= 1 && ci.high >= 1;
const calibrationPassed =
  result.calibration.every(
    (row) =>
      row.wall.semantic &&
      containsOne(row.wall.p50) &&
      containsOne(row.wall.p95) &&
      row.wall.p95.high <= 1.05,
  ) &&
  result.positive.wall.semantic &&
  result.positive.wall.p50.low > 1.5;
result.calibrationPassed = calibrationPassed;
save();

if (calibrationPassed) {
  for (const profile of profiles) {
    const row = series(`ab-${profile.join('-')}`, profile, { candidateB: true });
    result.candidate.push(row);
    result.candidateSamples += clusters * 4;
    save();
  }
}

const admitted =
  calibrationPassed &&
  result.candidate.every(
    (row) =>
      row.wall.semantic &&
      row.wall.p50.high <= 1.05 &&
      row.wall.p95.high <= 1.05,
  );
result.finishedAt = new Date().toISOString();
result.verdict = calibrationPassed ? (admitted ? 'ADMITTED' : 'NO-GO') : 'UNPROVEN-CALIBRATION';
save();
console.log('VERDICT', result.verdict, 'candidateSamples', result.candidateSamples);
