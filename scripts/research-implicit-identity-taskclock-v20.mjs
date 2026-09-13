import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const CORPUS = Object.freeze([0.125, 0.25, 0.375, 0.625, 0.75, 0.875]);
const WARM = 120_000;
const ONE_X = 1_000_000;
const TWO_X = 2_000_000;
const OPT_BIT = 16;
const NULL_PAIRS = 6;
const POSITIVE_PAIRS = 6;
const AB_PAIRS = 8;
const LIMIT = 1.05;
const POSITIVE_MIN = 1.5;

function runCalls(fn, calls, phase = 0) {
  for (let i = 0; i < calls; i++) fn(CORPUS[(i + phase) % CORPUS.length]);
}

async function childMain() {
  const [entry, label, factorText, phaseText] = process.argv.slice(3);
  if (!entry || !label) throw new Error('child: missing entry/label');
  const factor = Number(factorText);
  const phase = Number(phaseText);
  if (!(factor === 1 || factor === 2) || !Number.isInteger(phase)) {
    throw new Error('child: bad factor/phase');
  }

  const mod = await import(pathToFileURL(entry).href + `?v20=${encodeURIComponent(label)}-${phase}-${factor}`);
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
  runCalls(fn, WARM, 0);
  %OptimizeFunctionOnNextCall(fn);
  fn(CORPUS[0]);
  runCalls(fn, WARM, 1);
  const statusBefore = %GetOptimizationStatus(fn);
  if ((statusBefore & OPT_BIT) === 0) {
    throw new Error(`child: seek not optimized before measurement: ${statusBefore}`);
  }

  process.kill(process.pid, 'SIGSTOP');
  runCalls(fn, factor === 1 ? ONE_X : TWO_X, phase);
  process.kill(process.pid, 'SIGSTOP');

  const statusAfter = %GetOptimizationStatus(fn);
  if ((statusAfter & OPT_BIT) === 0) {
    throw new Error(`child: seek not optimized after measurement: ${statusAfter}`);
  }
  process.stdout.write(JSON.stringify({ label, factor, phase, statusBefore, statusAfter, sink }) + '\n');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function stateOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const line = text.split('\n').find((x) => x.startsWith('State:'));
    return line ? line.split(/\s+/)[1] : null;
  } catch {
    return null;
  }
}

async function waitFor(pid, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = stateOf(pid);
    if (state === null) throw new Error(`${label}: process ${pid} disappeared`);
    if (predicate(state)) return state;
    await sleep(5);
  }
  throw new Error(`${label}: timeout waiting for process ${pid}, state=${stateOf(pid)}`);
}

function collectProcess(proc) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => { stdout += chunk; });
    proc.stderr?.on('data', (chunk) => { stderr += chunk; });
    proc.once('error', rejectPromise);
    proc.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function parseTaskClock(stderr) {
  const lines = stderr.split('\n').map((x) => x.trim()).filter(Boolean);
  const matches = lines.filter((line) => line.includes('task-clock'));
  if (matches.length !== 1) throw new Error(`perf: expected exactly one task-clock line, got ${matches.length}: ${stderr}`);
  const fields = matches[0].split(',');
  const value = Number(fields[0].trim());
  const unit = fields[1]?.trim();
  const event = fields[2]?.trim();
  if (!Number.isFinite(value) || value <= 0 || unit !== 'msec' || !event?.startsWith('task-clock')) {
    throw new Error(`perf: invalid task-clock receipt: ${matches[0]}`);
  }
  return { ms: value, line: matches[0] };
}

async function measure(entry, label, factor, phase, cpu) {
  const child = spawn('taskset', ['-c', cpu, process.execPath, '--allow-natives-syntax', SELF, '--child', entry, label, String(factor), String(phase)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
  });
  const childDone = collectProcess(child);
  await waitFor(child.pid, (s) => s === 'T' || s === 't', `${label}:initial-stop`);

  const perf = spawn('perf', ['stat', '--no-big-num', '-x,', '-e', 'task-clock', '-p', String(child.pid)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
  });
  const perfDone = collectProcess(perf);
  await sleep(120);
  if (perf.exitCode !== null) {
    const receipt = await perfDone;
    process.kill(child.pid, 'SIGCONT');
    throw new Error(`perf exited before measurement: ${receipt.code}/${receipt.signal}\n${receipt.stderr}`);
  }

  process.kill(child.pid, 'SIGCONT');
  await waitFor(child.pid, (s) => s !== 'T' && s !== 't', `${label}:leave-initial-stop`);
  await waitFor(child.pid, (s) => s === 'T' || s === 't', `${label}:measured-stop`, 60_000);

  perf.kill('SIGINT');
  const perfReceipt = await perfDone;
  if (!(perfReceipt.code === 0 || perfReceipt.signal === 'SIGINT')) {
    process.kill(child.pid, 'SIGCONT');
    throw new Error(`perf failed: ${perfReceipt.code}/${perfReceipt.signal}\n${perfReceipt.stderr}`);
  }
  const taskClock = parseTaskClock(perfReceipt.stderr);

  process.kill(child.pid, 'SIGCONT');
  const childReceipt = await childDone;
  if (childReceipt.code !== 0) {
    throw new Error(`child failed: ${childReceipt.code}/${childReceipt.signal}\n${childReceipt.stderr}`);
  }
  const rows = childReceipt.stdout.trim().split('\n').filter(Boolean);
  if (rows.length !== 1) throw new Error(`child: expected one JSON row, got ${rows.length}`);
  const meta = JSON.parse(rows[0]);
  if ((meta.statusBefore & OPT_BIT) === 0 || (meta.statusAfter & OPT_BIT) === 0) {
    throw new Error(`child: lost optimized status: ${rows[0]}`);
  }

  return {
    label,
    factor,
    phase,
    cpu,
    taskClockMs: taskClock.ms,
    perfLine: taskClock.line,
    statusBefore: meta.statusBefore,
    statusAfter: meta.statusAfter,
    sink: meta.sink,
  };
}

async function pair(left, right, index, cpu, phaseBase) {
  const order = (index & 1) === 0 ? [left, right] : [right, left];
  const observed = new Map();
  for (let slot = 0; slot < order.length; slot++) {
    const side = order[slot];
    observed.set(side.key, await measure(side.entry, side.label, side.factor, phaseBase + index * 4 + slot, cpu));
  }
  return { index, first: order[0].key, left: observed.get(left.key), right: observed.get(right.key) };
}

function ratio(right, left) {
  return right.taskClockMs / left.taskClockMs;
}

function symmetric(pairRow) {
  const r = ratio(pairRow.right, pairRow.left);
  return Math.max(r, 1 / r);
}

function geometricMean(values) {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

async function collectPairs(left, right, count, cpu, phaseBase) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(await pair(left, right, i, cpu, phaseBase));
  return rows;
}

async function parentMain() {
  const [baseEntry, candidateEntry, outputDir = 'evidence-v20'] = process.argv.slice(2);
  if (!baseEntry || !candidateEntry) throw new Error('usage: script BASE_ENTRY CANDIDATE_ENTRY [OUTPUT_DIR]');
  mkdirSync(outputDir, { recursive: true });
  const cpu = process.env.RESEARCH_CPU ?? '0';

  const baseA = { key: 'baseA', label: 'baseA', entry: resolve(baseEntry), factor: 1 };
  const baseB = { key: 'baseB', label: 'baseB', entry: resolve(baseEntry), factor: 1 };
  const candidateA = { key: 'candidateA', label: 'candidateA', entry: resolve(candidateEntry), factor: 1 };
  const candidateB = { key: 'candidateB', label: 'candidateB', entry: resolve(candidateEntry), factor: 1 };
  const positive1 = { key: 'positive1x', label: 'positive1x', entry: resolve(baseEntry), factor: 1 };
  const positive2 = { key: 'positive2x', label: 'positive2x', entry: resolve(baseEntry), factor: 2 };

  const raw = { nullBase: [], nullCandidate: [], positive: [], candidate: [] };
  let verdict = 'UNPROVEN-CALIBRATION';
  let controls = null;
  let comparison = null;

  try {
    raw.nullBase = await collectPairs(baseA, baseB, NULL_PAIRS, cpu, 10_000);
    raw.nullCandidate = await collectPairs(candidateA, candidateB, NULL_PAIRS, cpu, 20_000);
    raw.positive = await collectPairs(positive1, positive2, POSITIVE_PAIRS, cpu, 30_000);

    const baseNullRatios = raw.nullBase.map(symmetric);
    const candidateNullRatios = raw.nullCandidate.map(symmetric);
    const positiveRatios = raw.positive.map((p) => ratio(p.right, p.left));
    controls = {
      baseNullRatios,
      candidateNullRatios,
      positiveRatios,
      basePass: baseNullRatios.every((r) => r <= LIMIT),
      candidatePass: candidateNullRatios.every((r) => r <= LIMIT),
      positivePass: positiveRatios.every((r) => r > POSITIVE_MIN),
    };
    controls.pass = controls.basePass && controls.candidatePass && controls.positivePass;

    if (controls.pass) {
      raw.candidate = await collectPairs(baseA, candidateA, AB_PAIRS, cpu, 40_000);
      const ratios = raw.candidate.map((p) => ratio(p.right, p.left));
      const gm = geometricMean(ratios);
      comparison = { ratios, geometricMean: gm, max: Math.max(...ratios), pass: ratios.every((r) => r <= LIMIT) && gm <= LIMIT };
      verdict = comparison.pass ? 'PASS-TASK-CLOCK' : 'FAIL-TASK-CLOCK';
    }
  } catch (error) {
    const result = {
      schema: 1,
      method: 'linux-perf-software-task-clock-post-warm-turbofan-v20',
      verdict: 'UNPROVEN-TOOLING',
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      constants: { WARM, ONE_X, TWO_X, NULL_PAIRS, POSITIVE_PAIRS, AB_PAIRS, LIMIT, POSITIVE_MIN, cpu },
      controls,
      comparison,
      raw,
    };
    writeFileSync(resolve(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  const result = {
    schema: 1,
    method: 'linux-perf-software-task-clock-post-warm-turbofan-v20',
    node: process.version,
    v8: process.versions.v8,
    constants: { WARM, ONE_X, TWO_X, NULL_PAIRS, POSITIVE_PAIRS, AB_PAIRS, LIMIT, POSITIVE_MIN, cpu },
    controls,
    comparison,
    raw,
    candidatePairs: raw.candidate.length,
    verdict,
  };
  writeFileSync(resolve(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[2] === '--child') await childMain();
else await parentMain();
