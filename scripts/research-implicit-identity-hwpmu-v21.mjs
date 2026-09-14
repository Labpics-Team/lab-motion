import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const CORPUS = Object.freeze([0.125, 0.25, 0.375, 0.625, 0.75, 0.875]);
const WARM = 120_000;
const ONE_X = 1_000_000;
const TWO_X = 2_000_000;
const NULL_PAIRS = 6;
const POSITIVE_PAIRS = 6;
const AB_PAIRS = 8;
const LIMIT = 1.05;
const POSITIVE_MIN = 1.5;
const OPT_BIT = 16;
const METRICS = Object.freeze(['instructions', 'cycles']);

function calls(fn, n, phase) {
  for (let i = 0; i < n; i++) fn(CORPUS[(i + phase) % CORPUS.length]);
}

async function childMain() {
  const [entry, label, factorRaw, phaseRaw, token] = process.argv.slice(3);
  const factor = Number(factorRaw);
  const phase = Number(phaseRaw);
  if (!entry || !label || !token || !(factor === 1 || factor === 2) || !Number.isInteger(phase)) {
    throw new Error('bad child arguments');
  }

  const mod = await import(pathToFileURL(entry).href + `?hwpmu21=${encodeURIComponent(token)}`);
  let sink = 0;
  const control = mod.keyframes({
    values: [0, 1, 2],
    times: [0, 0.5, 1],
    requestFrame: () => 1,
    onStep: (value) => { sink += value; },
  });
  control.pause();
  const fn = control.seek;

  %PrepareFunctionForOptimization(fn);
  calls(fn, WARM, 0);
  %OptimizeFunctionOnNextCall(fn);
  fn(CORPUS[0]);
  calls(fn, WARM, 1);
  const before = %GetOptimizationStatus(fn);
  if ((before & OPT_BIT) === 0) throw new Error(`not optimized before: ${before}`);

  process.kill(process.pid, 'SIGSTOP');
  calls(fn, factor === 1 ? ONE_X : TWO_X, phase);
  process.kill(process.pid, 'SIGSTOP');

  const after = %GetOptimizationStatus(fn);
  if ((after & OPT_BIT) === 0) throw new Error(`not optimized after: ${after}`);
  process.stdout.write(JSON.stringify({ token, label, factor, phase, before, after, sink }) + '\n');
}

function collect(proc) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.once('error', rejectPromise);
    proc.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

async function sample(side, phase, cpu, helper) {
  const token = `${side.key}-${side.factor}-${phase}`;
  const proc = spawn(helper, [
    cpu,
    process.execPath,
    SELF,
    side.entry,
    side.label,
    String(side.factor),
    String(phase),
    token,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  const receipt = await collect(proc);
  if (receipt.code !== 0) throw new Error(`helper failed ${receipt.code}/${receipt.signal}: ${receipt.stderr}`);

  const lines = receipt.stdout.trim().split('\n').filter(Boolean);
  const jsonLines = lines.filter((line) => line.startsWith('{'));
  const countLines = lines.filter((line) => line.startsWith('HW_INSTRUCTIONS='));
  if (jsonLines.length !== 1 || countLines.length !== 1 || lines.length !== 2) {
    throw new Error(`unexpected helper receipt: ${receipt.stdout} stderr=${receipt.stderr}`);
  }
  const meta = JSON.parse(jsonLines[0]);
  if (meta.token !== token || (meta.before & OPT_BIT) === 0 || (meta.after & OPT_BIT) === 0) {
    throw new Error(`invalid child receipt: ${jsonLines[0]}`);
  }
  const match = /^HW_INSTRUCTIONS=(\d+) HW_CYCLES=(\d+) TIME_ENABLED=(\d+) TIME_RUNNING=(\d+) TOKEN=(\S+)$/.exec(countLines[0]);
  if (!match || match[5] !== token) throw new Error(`invalid counter receipt: ${countLines[0]}`);
  const instructions = Number(match[1]);
  const cycles = Number(match[2]);
  const timeEnabled = Number(match[3]);
  const timeRunning = Number(match[4]);
  for (const [name, value] of Object.entries({ instructions, cycles, timeEnabled, timeRunning })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name}: ${value}`);
  }
  if (timeRunning !== timeEnabled) throw new Error(`multiplexed PMU receipt: ${timeRunning}/${timeEnabled}`);

  return {
    key: side.key,
    label: side.label,
    factor: side.factor,
    phase,
    token,
    instructions,
    cycles,
    timeEnabled,
    timeRunning,
    statusBefore: meta.before,
    statusAfter: meta.after,
    sink: meta.sink,
    helperStderr: receipt.stderr,
  };
}

async function paired(left, right, count, phaseBase, cpu, helper) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const order = (i & 1) === 0 ? [left, right] : [right, left];
    const observed = new Map();
    for (let slot = 0; slot < 2; slot++) {
      const side = order[slot];
      observed.set(side.key, await sample(side, phaseBase + i * 4 + slot, cpu, helper));
    }
    out.push({ index: i, first: order[0].key, left: observed.get(left.key), right: observed.get(right.key) });
  }
  return out;
}

const ratioMetric = (p, metric) => p.right[metric] / p.left[metric];
const symmetricMetric = (p, metric) => {
  const r = ratioMetric(p, metric);
  return Math.max(r, 1 / r);
};
const geometricMean = (xs) => Math.exp(xs.reduce((sum, value) => sum + Math.log(value), 0) / xs.length);
const perMetric = (pairs, fn) => Object.fromEntries(METRICS.map((metric) => [metric, pairs.map((p) => fn(p, metric))]));
const allMetrics = (table, predicate) => METRICS.every((metric) => table[metric].every(predicate));

async function parentMain() {
  const [baseRaw, candidateRaw, outRaw = 'evidence-hwpmu-v21'] = process.argv.slice(2);
  const helper = process.env.HWPMU_HELPER;
  const cpu = process.env.RESEARCH_CPU ?? '0';
  if (!baseRaw || !candidateRaw || !helper) throw new Error('expected base, candidate, HWPMU_HELPER');
  const baseEntry = resolve(baseRaw);
  const candidateEntry = resolve(candidateRaw);
  const outDir = resolve(outRaw);
  mkdirSync(outDir, { recursive: true });

  const side = (key, entry, factor = 1) => ({ key, label: key, entry, factor });
  const baseA = side('baseA', baseEntry);
  const baseB = side('baseB', baseEntry);
  const candidateA = side('candidateA', candidateEntry);
  const candidateB = side('candidateB', candidateEntry);
  const positive1 = side('positive1x', baseEntry, 1);
  const positive2 = side('positive2x', baseEntry, 2);

  const raw = { nullBase: [], nullCandidate: [], positive: [], candidate: [] };
  let controls = null;
  let comparison = null;
  let verdict = 'UNPROVEN-CALIBRATION';
  let toolingError = null;

  try {
    raw.nullBase = await paired(baseA, baseB, NULL_PAIRS, 10_000, cpu, helper);
    raw.nullCandidate = await paired(candidateA, candidateB, NULL_PAIRS, 20_000, cpu, helper);
    raw.positive = await paired(positive1, positive2, POSITIVE_PAIRS, 30_000, cpu, helper);

    const baseNull = perMetric(raw.nullBase, symmetricMetric);
    const candidateNull = perMetric(raw.nullCandidate, symmetricMetric);
    const positive = perMetric(raw.positive, ratioMetric);
    controls = {
      baseNull,
      candidateNull,
      positive,
      basePass: allMetrics(baseNull, (x) => x <= LIMIT),
      candidatePass: allMetrics(candidateNull, (x) => x <= LIMIT),
      positivePass: allMetrics(positive, (x) => x > POSITIVE_MIN),
    };
    controls.pass = controls.basePass && controls.candidatePass && controls.positivePass;

    if (controls.pass) {
      raw.candidate = await paired(baseA, candidateA, AB_PAIRS, 40_000, cpu, helper);
      const ratios = perMetric(raw.candidate, ratioMetric);
      comparison = {
        ratios,
        geometricMean: Object.fromEntries(METRICS.map((metric) => [metric, geometricMean(ratios[metric])])),
        max: Object.fromEntries(METRICS.map((metric) => [metric, Math.max(...ratios[metric])])),
      };
      comparison.pass = METRICS.every((metric) =>
        ratios[metric].every((x) => x <= LIMIT) && comparison.geometricMean[metric] <= LIMIT);
      verdict = comparison.pass ? 'PASS-HW-PMU' : 'FAIL-HW-PMU';
    }
  } catch (error) {
    verdict = 'UNPROVEN-TOOLING';
    toolingError = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
  }

  const result = {
    schema: 1,
    method: 'grouped-hardware-pmu-user-instructions-cycles-post-warm-turbofan-v21',
    node: process.version,
    v8: process.versions.v8,
    verdict,
    toolingError,
    metrics: METRICS,
    constants: { WARM, ONE_X, TWO_X, NULL_PAIRS, POSITIVE_PAIRS, AB_PAIRS, LIMIT, POSITIVE_MIN, cpu },
    controls,
    comparison,
    candidatePairs: raw.candidate.length,
    raw,
  };
  writeFileSync(resolve(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (verdict === 'UNPROVEN-TOOLING') process.exitCode = 2;
}

if (process.argv[2] === '--child') await childMain();
else await parentMain();
