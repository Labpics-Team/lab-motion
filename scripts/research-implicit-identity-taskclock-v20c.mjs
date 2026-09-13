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

  const mod = await import(pathToFileURL(entry).href + `?v20c=${encodeURIComponent(token)}`);
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
  const countLines = lines.filter((line) => line.startsWith('TASK_CLOCK_NS='));
  if (jsonLines.length !== 1 || countLines.length !== 1 || lines.length !== 2) {
    throw new Error(`unexpected helper receipt: ${receipt.stdout} stderr=${receipt.stderr}`);
  }
  const meta = JSON.parse(jsonLines[0]);
  if (meta.token !== token || (meta.before & OPT_BIT) === 0 || (meta.after & OPT_BIT) === 0) {
    throw new Error(`invalid child receipt: ${jsonLines[0]}`);
  }
  const match = /^TASK_CLOCK_NS=(\d+) TOKEN=(\S+)$/.exec(countLines[0]);
  if (!match || match[2] !== token) throw new Error(`invalid counter receipt: ${countLines[0]}`);
  const ns = Number(match[1]);
  if (!Number.isSafeInteger(ns) || ns <= 0) throw new Error(`invalid task clock: ${match[1]}`);

  return {
    key: side.key,
    label: side.label,
    factor: side.factor,
    phase,
    token,
    taskClockNs: ns,
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

const ratio = (p) => p.right.taskClockNs / p.left.taskClockNs;
const symmetric = (p) => Math.max(ratio(p), 1 / ratio(p));
const geometricMean = (xs) => Math.exp(xs.reduce((sum, value) => sum + Math.log(value), 0) / xs.length);

async function parentMain() {
  const [baseRaw, candidateRaw, outRaw = 'evidence-v20c'] = process.argv.slice(2);
  const helper = process.env.TASKCLOCK_HELPER;
  const cpu = process.env.RESEARCH_CPU ?? '0';
  if (!baseRaw || !candidateRaw || !helper) throw new Error('expected base, candidate, TASKCLOCK_HELPER');
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

    const baseNull = raw.nullBase.map(symmetric);
    const candidateNull = raw.nullCandidate.map(symmetric);
    const positive = raw.positive.map(ratio);
    controls = {
      baseNull,
      candidateNull,
      positive,
      basePass: baseNull.every((x) => x <= LIMIT),
      candidatePass: candidateNull.every((x) => x <= LIMIT),
      positivePass: positive.every((x) => x > POSITIVE_MIN),
    };
    controls.pass = controls.basePass && controls.candidatePass && controls.positivePass;

    if (controls.pass) {
      raw.candidate = await paired(baseA, candidateA, AB_PAIRS, 40_000, cpu, helper);
      const ratios = raw.candidate.map(ratio);
      comparison = { ratios, geometricMean: geometricMean(ratios), max: Math.max(...ratios) };
      comparison.pass = ratios.every((x) => x <= LIMIT) && comparison.geometricMean <= LIMIT;
      verdict = comparison.pass ? 'PASS-TASK-CLOCK' : 'FAIL-TASK-CLOCK';
    }
  } catch (error) {
    verdict = 'UNPROVEN-TOOLING';
    toolingError = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
  }

  const result = {
    schema: 1,
    method: 'direct-perf-event-open-software-task-clock-post-warm-turbofan-v20',
    transportRevision: 'direct-perf-event-open-v20c',
    node: process.version,
    v8: process.versions.v8,
    verdict,
    toolingError,
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
