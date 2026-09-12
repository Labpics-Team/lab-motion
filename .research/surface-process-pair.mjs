import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.NODE_OPTIONS) throw new Error('NODE_OPTIONS must be empty for the evidence carrier');

const baseRoot = resolve(process.env.BASE_ROOT);
const candidateRoot = resolve(process.env.CANDIDATE_ROOT);
const acornPath = resolve(process.env.ACORN_PATH);
const evidence = resolve(process.env.EVIDENCE_DIR ?? 'evidence');
const sideScript = resolve(process.env.SIDE_SCRIPT ?? '.research/surface-process-side.mjs');
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

function runSide(entryPath, scenario, calls, repeats) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      sideScript, entryPath, acornPath, scenario, String(calls), String(repeats),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', code => {
      if (code !== 0) {
        rejectPromise(new Error(`side process exit ${code}: ${stderr.slice(-4000)}`));
        return;
      }
      if (stderr.trim()) {
        rejectPromise(new Error(`side process wrote stderr: ${stderr.slice(-4000)}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        rejectPromise(new Error(`invalid side JSON: ${error?.message ?? String(error)}`));
      }
    });
  });
}

async function run(name, mode, defKey) {
  const [scenario, calls, positiveControl] = definitions[defKey];
  const baseline = [];
  const candidate = [];
  const details = [];
  for (let cluster = 0; cluster < CLUSTERS; cluster++) {
    const sidePaths = [BASE, mode === 'AA' ? BASE : CANDIDATE];
    const sideRepeats = [1, positiveControl ? 2 : 1];
    const order = cluster % 2 ? [1, 0] : [0, 1];
    const rows = [];
    for (const side of order) {
      rows[side] = await runSide(sidePaths[side], scenario, calls, sideRepeats[side]);
    }
    const expectedBlackhole = positiveControl
      ? rows[0].blackhole * 2
      : rows[0].blackhole;
    if (rows[1].blackhole !== expectedBlackhole) {
      throw new Error(`${name}: cluster ${cluster} blackhole mismatch ${rows[0].blackhole} vs ${rows[1].blackhole}`);
    }
    if (rows.some(row => !Array.isArray(row.samples) || row.samples.length !== 2)) {
      throw new Error(`${name}: cluster ${cluster} expected exactly 2 samples per side`);
    }
    baseline.push({ run: cluster, samples: rows[0].samples, semantic: true });
    candidate.push({ run: cluster, samples: rows[1].samples, semantic: true });
    details.push({ cluster, order, sides: rows });
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
  carrier: 'fresh-process-per-side-v1',
  valid: controls.every(aaValid) && positive.stats.p50.low > 1.5,
  controls: controls.map(row => ({ name: row.name, valid: aaValid(row), stats: row.stats })),
  positive: { valid: positive.stats.p50.low > 1.5, stats: positive.stats },
};
await writeFile(join(evidence, 'timing-controls.json'), JSON.stringify({ controls, positive }, null, 2));
await writeFile(join(evidence, 'calibration.json'), JSON.stringify(calibration, null, 2));
if (!calibration.valid) {
  await writeFile(join(evidence, 'timing-verdict.json'), JSON.stringify({
    status: 'UNPROVEN',
    reason: 'fresh-process-per-side baseline-only calibration failed; candidate samples=0',
    candidateSamples: 0,
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
