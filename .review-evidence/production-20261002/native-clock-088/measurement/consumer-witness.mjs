import assert from 'node:assert/strict';
import { SERVER_PROFILE } from './source/bench/profile/server-profile-registration.mjs';
import { validateServerEngineSample } from './source/bench/profile/server-profile-contract.mjs';

// Synthetic data only. No library operation or registered timing sample is run.
// Independent expectation: duration is subtraction of integer endpoints, and
// each 2x-work batch retains the same registered 2000-call divisor.
const scene = SERVER_PROFILE.engineScenes.find((s) => s.workload === 'stock-c');
const identity = { clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 9001, tid: 9001 };
const base = 9_223_372_030n * 1_000_000_000n + 999_999_000n;
function batch(start, duration, multiplier, timed = true) {
  const calls = 2000 * multiplier;
  const endpoints = timed ? [start, start + duration] : [];
  const cpuReads = endpoints.map((value, sequence) => ({ sequence, ...identity,
    seconds: String(value / 1_000_000_000n), nanoseconds: Number(value % 1_000_000_000n), valueNs: String(value) }));
  const clockReads = endpoints.map((value, sequence) => ({ sequence, metric: 'operationNs', frame: null,
    edge: sequence ? 'after' : 'before', valueNs: String(value) }));
  return { operationNs: timed ? Number(duration) / 2000 : null,
    raw: { schemaVersion: 1, scene: scene.id, phase: timed ? 'timed' : 'warmup',
      calls, denominator: 2000, completed: calls, clockReads, cpuReads,
      outcomes: { encoding: 'runs', count: calls, runs: [{ from: 0, count: calls, value: 100, frames: 47 }] } } };
}
function sample(multiplier = 1) {
  const raw = Array.from({ length: 8 }, (_, index) => batch(base + BigInt(index) * 5_000_000n, 2_000_000n * BigInt(multiplier), multiplier));
  return { operationNs: 1000 * multiplier, semantic: true, repetitions: 8, workMultiplier: multiplier,
    denominator: SERVER_PROFILE.denominator, cpuScope: SERVER_PROFILE.stockCpuScope,
    warmup: [batch(0n, 0n, 1, false), batch(0n, 0n, 1, false)], cpuClock: identity, raw };
}
const results = [];
function check(name, mutate, reject = true, multiplier = 1) {
  const input = structuredClone(sample(multiplier));
  mutate?.(input);
  let error = null;
  try { validateServerEngineSample(input, scene, multiplier); } catch (e) { error = e.message; }
  const outcome = error ? 'REFUSED' : 'ACCEPTED';
  results.push({ name, expected: reject ? 'REFUSED' : 'ACCEPTED', outcome, error });
  assert.equal(Boolean(error), reject, name);
}
check('healthy seconds carry above Number safe absolute range', null, false);
check('healthy double work uses unchanged divisor', null, false, 2);
check('legacy RUSAGE source', (x) => { x.cpuClock.clock = 'process.threadCpuUsage'; });
check('foreign TID', (x) => { x.raw[0].raw.cpuReads[0].tid++; });
check('foreign PID', (x) => { x.raw[0].raw.cpuReads[0].pid++; });
check('negative seconds', (x) => { x.raw[0].raw.cpuReads[0].seconds = '-1'; });
check('leading-zero seconds', (x) => { x.raw[0].raw.cpuReads[0].seconds = '09'; });
check('seconds outside signed time_t', (x) => { x.raw[0].raw.cpuReads[0].seconds = '9223372036854775808'; });
check('negative nanoseconds', (x) => { x.raw[0].raw.cpuReads[0].nanoseconds = -1; });
check('negative-zero nanoseconds', (x) => { x.raw[0].raw.cpuReads[0].nanoseconds = -0; });
check('nanoseconds outside timespec', (x) => { x.raw[0].raw.cpuReads[0].nanoseconds = 1_000_000_000; });
check('fractional nanoseconds', (x) => { x.raw[0].raw.cpuReads[0].nanoseconds = 0.5; });
check('forged acquired value', (x) => { x.raw[0].raw.cpuReads[0].valueNs = String(base + 1n); });
check('wrong endpoint sequence', (x) => { x.raw[0].raw.cpuReads[1].sequence = 0; });
check('missing native endpoint', (x) => { x.raw[0].raw.cpuReads.pop(); });
check('cross-repetition rollback with otherwise internally valid batches', (x) => {
  x.raw[1] = batch(base - 3_000_000n, 2_000_000n, 1);
});
check('Number conversion before endpoint subtraction', (x) => {
  const wrong = Number(base + 2_000_000n) - Number(base);
  assert.notEqual(wrong, 2_000_000);
  x.raw[0].operationNs = wrong / 2000;
  x.operationNs = x.raw.reduce((sum, b) => sum + b.operationNs, 0) / 8;
});
check('double-work erased by division through actual call count', (x) => {
  x.raw.forEach((r) => { r.operationNs /= 2; }); x.operationNs /= 2;
}, true, 2);
check('unsafe interval conversion', (x) => {
  x.raw[0] = batch(base, 9_007_199_254_740_992n, 1);
  x.operationNs = x.raw.reduce((sum, b) => sum + b.operationNs, 0) / 8;
});
process.stdout.write(JSON.stringify({ schema: 1, syntheticOnly: true, sourceHead: '088fbc605c95fd6a6a7620301a450d6388386997',
  absoluteBaseNs: String(base), durationNs: '2000000', results }, null, 2) + '\n');
