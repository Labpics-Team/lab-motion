import { Worker } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseRoot = resolve(process.env.BASE_ROOT);
const candidateRoot = resolve(process.env.CANDIDATE_ROOT);
const acornPath = resolve(process.env.ACORN_PATH);
const evidence = resolve(process.env.EVIDENCE_DIR ?? 'evidence');
const workerPath = resolve(process.env.WORKER_PATH ?? '.research/surface-fresh-isolate-worker.mjs');
const { pairedClusterBootstrap } = await import(pathToFileURL(join(baseRoot, 'bench/compare/methodology.mjs')).href);
await mkdir(evidence, { recursive: true });

const BASE = join(baseRoot, 'dist/compiler/vite/index.js');
const CANDIDATE = join(candidateRoot, 'dist/compiler/vite/index.js');
const CLUSTERS = 64;
const definitions = {
  ordinary: ['ordinary-warm', 32, false],
  miss: ['ordinary-miss', 32, false],
  reject: ['reject', 8, false],
  batch: ['batch', 8, false],
  double: ['ordinary-warm', 32, true],
};
function one(data) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(workerPath, { workerData: data });
    let got = false;
    worker.once('message', async message => { got = true; await worker.terminate(); resolvePromise(message); });
    worker.once('error', rejectPromise);
    worker.once('exit', code => { if (!got && code !== 0) rejectPromise(new Error(`worker exit ${code}`)); });
  });
}
async function run(name, mode, defKey) {
  const [scenario, calls, positiveControl] = definitions[defKey];
  const baseline = [], candidate = [], details = [];
  for (let cluster = 0; cluster < CLUSTERS; cluster++) {
    const row = await one({
      cluster,
      sideAPath: BASE,
      sideBPath: mode === 'AA' ? BASE : CANDIDATE,
      acornPath,
      scenario,
      calls,
      positiveControl,
    });
    baseline.push({ run: cluster, samples: row.samples[0], semantic: true });
    candidate.push({ run: cluster, samples: row.samples[1], semantic: true });
    details.push(row);
    if ((cluster + 1) % 16 === 0) console.log(`${name}: ${cluster + 1}/${CLUSTERS}`);
  }
  const stats = pairedClusterBootstrap(candidate, baseline, { seed: 20260912, iterations: 10_000 });
  const row = { name, mode, scenario, calls, positiveControl, stats, baseline, candidate, details };
  console.log('PROFILE', JSON.stringify({ name, stats }));
  return row;
}
const aaValid = row => row.stats.p50.low <= 1 && row.stats.p50.high >= 1
  && row.stats.p95.low <= 1 && row.stats.p95.high >= 1 && row.stats.p95.high <= 1.05;

const controls = [];
for (const key of ['ordinary', 'miss', 'reject', 'batch']) controls.push(await run(`aa-${key}`, 'AA', key));
const positive = await run('positive-two-call', 'AA', 'double');
const calibration = {
  valid: controls.every(aaValid) && positive.stats.p50.low > 1.5,
  controls: controls.map(row => ({ name: row.name, valid: aaValid(row), stats: row.stats })),
  positive: { valid: positive.stats.p50.low > 1.5, stats: positive.stats },
};
await writeFile(join(evidence, 'timing-controls.json'), JSON.stringify({ controls, positive }, null, 2));
await writeFile(join(evidence, 'calibration.json'), JSON.stringify(calibration, null, 2));
if (!calibration.valid) {
  await writeFile(join(evidence, 'timing-verdict.json'), JSON.stringify({
    status: 'UNPROVEN', reason: 'fresh-isolate baseline-only calibration failed; candidate samples=0', candidateSamples: 0,
  }, null, 2));
  console.log('TIMING_UNPROVEN_CALIBRATION');
  process.exit(0);
}

const comparisons = [];
for (const key of ['ordinary', 'miss', 'reject', 'batch']) comparisons.push(await run(`ab-${key}`, 'AB', key));
await writeFile(join(evidence, 'timing-candidate.json'), JSON.stringify(comparisons, null, 2));
const nonInferior = comparisons.every(row => row.stats.p95.high <= 1.05);
await writeFile(join(evidence, 'timing-verdict.json'), JSON.stringify({
  status: nonInferior ? 'PERFORMANCE_ADMISSION' : 'PERFORMANCE_REGRESSION',
  candidateSamples: comparisons.reduce((sum, row) => sum + row.stats.observations, 0),
  cases: comparisons.map(row => ({ name: row.name, p50: row.stats.p50, p95: row.stats.p95 })),
}, null, 2));
console.log(nonInferior ? 'PERFORMANCE_ADMISSION' : 'PERFORMANCE_REGRESSION');
