import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const PERF_TIMEOUT_MS = 1000;

function calls(fn, n, phase) {
  for (let i = 0; i < n; i++) fn(CORPUS[(i + phase) % CORPUS.length]);
}

async function child() {
  const [entry, label, factorRaw, phaseRaw] = process.argv.slice(3);
  const factor = Number(factorRaw);
  const phase = Number(phaseRaw);
  if (!entry || !label || !(factor === 1 || factor === 2) || !Number.isInteger(phase)) {
    throw new Error('bad child arguments');
  }

  const mod = await import(pathToFileURL(entry).href + `?v20b=${encodeURIComponent(label)}-${factor}-${phase}`);
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
  process.stdout.write(JSON.stringify({ label, factor, phase, before, after, sink }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function procState(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const line = status.split('\n').find((x) => x.startsWith('State:'));
    return line?.split(/\s+/)[1] ?? null;
  } catch {
    return null;
  }
}

async function waitStopped(pid, label, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const state = procState(pid);
    if (state === null) throw new Error(`${label}: child disappeared`);
    if (state === 'T' || state === 't') return;
    await sleep(5);
  }
  throw new Error(`${label}: stop timeout, state=${procState(pid)}`);
}

function collect(proc) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c) => { stdout += c; });
    proc.stderr?.on('data', (c) => { stderr += c; });
    proc.once('error', rejectPromise);
    proc.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function parseTaskClock(stderr) {
  const matches = stderr.split('\n').map((x) => x.trim()).filter((x) => x.includes('task-clock'));
  if (matches.length !== 1) throw new Error(`expected one task-clock row, got ${matches.length}: ${stderr}`);
  const fields = matches[0].split(',');
  const value = Number(fields[0]?.trim());
  const unit = fields[1]?.trim();
  const event = fields[2]?.trim();
  if (!Number.isFinite(value) || value <= 0 || unit !== 'msec' || !event?.startsWith('task-clock')) {
    throw new Error(`invalid task-clock row: ${matches[0]}`);
  }
  return { ms: value, row: matches[0] };
}

async function sample(side, phase, cpu) {
  const proc = spawn('taskset', [
    '-c', cpu,
    process.execPath,
    '--allow-natives-syntax',
    SELF,
    '--child',
    side.entry,
    side.label,
    String(side.factor),
    String(phase),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  const childDone = collect(proc);
  await waitStopped(proc.pid, `${side.label}:warm-stop`);

  const perf = spawn('perf', [
    'stat', '--no-big-num', '-x,', '--timeout', String(PERF_TIMEOUT_MS),
    '-e', 'task-clock', '-p', String(proc.pid),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  const perfDone = collect(perf);
  await sleep(120);
  if (perf.exitCode !== null) {
    const receipt = await perfDone;
    process.kill(proc.pid, 'SIGCONT');
    throw new Error(`perf exited before measurement: ${receipt.code}/${receipt.signal}: ${receipt.stderr}`);
  }

  process.kill(proc.pid, 'SIGCONT');
  await sleep(10);
  await waitStopped(proc.pid, `${side.label}:measured-stop`);

  const perfReceipt = await perfDone;
  if (perfReceipt.code !== 0) {
    process.kill(proc.pid, 'SIGCONT');
    throw new Error(`perf failed: ${perfReceipt.code}/${perfReceipt.signal}: ${perfReceipt.stderr}`);
  }
  const taskClock = parseTaskClock(perfReceipt.stderr);

  process.kill(proc.pid, 'SIGCONT');
  const receipt = await childDone;
  if (receipt.code !== 0) throw new Error(`child failed: ${receipt.code}/${receipt.signal}: ${receipt.stderr}`);
  const lines = receipt.stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) throw new Error(`expected one child receipt, got ${lines.length}`);
  const meta = JSON.parse(lines[0]);
  if ((meta.before & OPT_BIT) === 0 || (meta.after & OPT_BIT) === 0) throw new Error(`lost optimized status: ${lines[0]}`);

  return {
    key: side.key,
    label: side.label,
    factor: side.factor,
    phase,
    taskClockMs: taskClock.ms,
    perfRow: taskClock.row,
    statusBefore: meta.before,
    statusAfter: meta.after,
    sink: meta.sink,
  };
}

async function paired(left, right, count, phaseBase, cpu) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const order = (i & 1) === 0 ? [left, right] : [right, left];
    const values = new Map();
    for (let slot = 0; slot < 2; slot++) {
      const side = order[slot];
      values.set(side.key, await sample(side, phaseBase + i * 4 + slot, cpu));
    }
    out.push({ index: i, first: order[0].key, left: values.get(left.key), right: values.get(right.key) });
  }
  return out;
}

const ratio = (pair) => pair.right.taskClockMs / pair.left.taskClockMs;
const symmetric = (pair) => Math.max(ratio(pair), 1 / ratio(pair));
const geometricMean = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);

async function parent() {
  const [baseRaw, candidateRaw, outRaw = 'evidence-v20b'] = process.argv.slice(2);
  if (!baseRaw || !candidateRaw) throw new Error('expected base and candidate entries');
  const baseEntry = resolve(baseRaw);
  const candidateEntry = resolve(candidateRaw);
  const outDir = resolve(outRaw);
  const cpu = process.env.RESEARCH_CPU ?? '0';
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

  try {
    raw.nullBase = await paired(baseA, baseB, NULL_PAIRS, 10_000, cpu);
    raw.nullCandidate = await paired(candidateA, candidateB, NULL_PAIRS, 20_000, cpu);
    raw.positive = await paired(positive1, positive2, POSITIVE_PAIRS, 30_000, cpu);

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
      raw.candidate = await paired(baseA, candidateA, AB_PAIRS, 40_000, cpu);
      const ratios = raw.candidate.map(ratio);
      comparison = {
        ratios,
        geometricMean: geometricMean(ratios),
        max: Math.max(...ratios),
      };
      comparison.pass = comparison.ratios.every((x) => x <= LIMIT) && comparison.geometricMean <= LIMIT;
      verdict = comparison.pass ? 'PASS-TASK-CLOCK' : 'FAIL-TASK-CLOCK';
    }
  } catch (error) {
    verdict = 'UNPROVEN-TOOLING';
    const result = {
      schema: 1,
      method: 'linux-perf-software-task-clock-post-warm-turbofan-v20',
      transportRevision: 'bounded-perf-timeout-v20b',
      verdict,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      constants: { WARM, ONE_X, TWO_X, NULL_PAIRS, POSITIVE_PAIRS, AB_PAIRS, LIMIT, POSITIVE_MIN, PERF_TIMEOUT_MS, cpu },
      controls,
      comparison,
      candidatePairs: raw.candidate.length,
      raw,
    };
    writeFileSync(resolve(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  const result = {
    schema: 1,
    method: 'linux-perf-software-task-clock-post-warm-turbofan-v20',
    transportRevision: 'bounded-perf-timeout-v20b',
    node: process.version,
    v8: process.versions.v8,
    verdict,
    constants: { WARM, ONE_X, TWO_X, NULL_PAIRS, POSITIVE_PAIRS, AB_PAIRS, LIMIT, POSITIVE_MIN, PERF_TIMEOUT_MS, cpu },
    controls,
    comparison,
    candidatePairs: raw.candidate.length,
    raw,
  };
  writeFileSync(resolve(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[2] === '--child') await child();
else await parent();
