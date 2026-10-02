import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SERVER_PROFILE } from './source/bench/profile/server-profile-registration.mjs';
import { compactServerCpuEvidence, expandServerCpuEvidence, validateServerEngineSample } from './source/bench/profile/server-profile-contract.mjs';

const identity = { clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 9001, tid: 9001 };
const original = [
  { sequence: 0, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 101, tid: 101, seconds: '9007199254740993', nanoseconds: 999999999, valueNs: '9007199254740993999999999' },
  { sequence: 1, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 101, tid: 101, seconds: '9007199254740994', nanoseconds: 0, valueNs: '9007199254740994000000000' },
  { sequence: 2, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 202, tid: 202, seconds: '9007199254740994', nanoseconds: 1, valueNs: '9007199254740994000000001' },
  { sequence: 3, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 101, tid: 101, seconds: '9007199254740994', nanoseconds: 2, valueNs: '9007199254740994000000002' },
];
const expectedCarrier = { encoding: 'native-cpu-rle-v1', count: 4, runs: [
  { from: 0, count: 2, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 101, tid: 101, values: [['9007199254740993', 999999999], ['9007199254740994', 0]] },
  { from: 2, count: 1, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 202, tid: 202, values: [['9007199254740994', 1]] },
  { from: 3, count: 1, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 101, tid: 101, values: [['9007199254740994', 2]] },
] };
const result = { schema: 1, sourceHead: '5a4c29d8abb102b1fea563d14c30c3cdf13efe2c', syntheticOnly: true,
  registeredTimingSamples: 0, original, expectedCarrier, sourceCases: [], consumerCases: [], encodedCases: [] };
const packed = compactServerCpuEvidence(original);
const restored = expandServerCpuEvidence(JSON.parse(JSON.stringify(packed)), original.length);
assert.deepEqual(packed, expectedCarrier);
assert.deepEqual(restored, original);
assert.equal(JSON.stringify(restored), JSON.stringify(original));
assert.strictEqual(expandServerCpuEvidence(original, original.length), original);
result.actualCarrier = packed; result.restoredJson = JSON.stringify(restored); result.jsonByteIdentity = true;

function encodeFault(name, make, countEffects) {
  const input = make(structuredClone(original));
  let error;
  try { compactServerCpuEvidence(input); } catch (e) { error = e.message; }
  assert.ok(error, name);
  if (countEffects) assert.equal(countEffects(), 0, name + ' must not invoke observer');
  result.sourceCases.push({ name, expected: 'REFUSED', error, observerCalls: countEffects?.() ?? null });
}
encodeFault('forged valueNs is not repaired', (x) => { x[1].valueNs = '0'; return x; });
encodeFault('forged ordinal is not repaired', (x) => { x[1].sequence = 0; return x; });
encodeFault('symbol field is not lost', (x) => { x[0][Symbol('acquired')] = 7; return x; });
encodeFault('extra field is not lost', (x) => { x[0].extra = 7; return x; });
encodeFault('extra array field is not lost', (x) => { x.extra = 7; return x; });
encodeFault('sparse source endpoint is not synthesized', (x) => { delete x[1]; return x; });
encodeFault('noncanonical seconds', (x) => { x[1].seconds = '00'; return x; });
encodeFault('nanosecond negative zero', (x) => { x[1].nanoseconds = -0; return x; });
encodeFault('foreign object prototype', (x) => { Object.setPrototypeOf(x[0], { source: true }); return x; });
let observed = 0;
encodeFault('field accessor refused before acquisition', (x) => {
  Object.defineProperty(x[0], 'seconds', { enumerable: true, get() { observed++; return '0'; } }); return x;
}, () => observed);
encodeFault('array accessor refused before acquisition', (x) => {
  Object.defineProperty(x, '0', { enumerable: true, get() { observed++; return original[0]; } }); return x;
}, () => observed);
encodeFault('proxy array refused before traps', (x) => new Proxy(x, { get(target, key) { observed++; return Reflect.get(target, key); } }), () => observed);
encodeFault('proxy endpoint refused before traps', (x) => {
  x[0] = new Proxy(x[0], { get(target, key) { observed++; return Reflect.get(target, key); } }); return x;
}, () => observed);

const scene = SERVER_PROFILE.engineScenes.find((s) => s.workload === 'stock-c');
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
  const raw = Array.from({ length: 8 }, (_, i) => batch(base + BigInt(i) * 5_000_000n, 2_000_000n * BigInt(multiplier), multiplier));
  return { operationNs: 1000 * multiplier, semantic: true, repetitions: 8, workMultiplier: multiplier,
    denominator: SERVER_PROFILE.denominator, cpuScope: SERVER_PROFILE.stockCpuScope,
    warmup: [batch(0n, 0n, 1, false), batch(0n, 0n, 1, false)], cpuClock: identity, raw };
}
function verdict(input, multiplier) {
  try { validateServerEngineSample(input, scene, multiplier); return { verdict: 'ACCEPTED', error: null }; }
  catch (e) { return { verdict: 'REFUSED', error: e.message }; }
}
function consumerCase(name, mutate, expected = 'REFUSED', multiplier = 1) {
  const input = structuredClone(sample(multiplier)); mutate?.(input);
  const before = JSON.stringify(input);
  const expandedVerdict = verdict(input, multiplier);
  const encoded = structuredClone(input);
  let encodedVerdict;
  try {
    for (const row of encoded.raw) row.raw.cpuReads = compactServerCpuEvidence(row.raw.cpuReads);
    encodedVerdict = verdict(JSON.parse(JSON.stringify(encoded)), multiplier);
  } catch (e) { encodedVerdict = { verdict: 'REFUSED', error: e.message, phase: 'source encoding' }; }
  assert.equal(expandedVerdict.verdict, expected, name + ' expanded');
  assert.equal(encodedVerdict.verdict, expected, name + ' encoded');
  assert.equal(JSON.stringify(input), before, name + ' source untouched');
  result.consumerCases.push({ name, expected, input: JSON.parse(before), expandedVerdict, encodedVerdict });
}
consumerCase('healthy exact absolute endpoints', null, 'ACCEPTED');
consumerCase('healthy 2x work unchanged divisor', null, 'ACCEPTED', 2);
consumerCase('timespec/clockRead correlation', (x) => { x.raw[0].raw.cpuReads[1].nanoseconds++; });
consumerCase('foreign endpoint PID/TID', (x) => { x.raw[0].raw.cpuReads[1].pid++; x.raw[0].raw.cpuReads[1].tid++; });
consumerCase('foreign sample identity', (x) => { x.cpuClock.pid++; x.cpuClock.tid++; });
consumerCase('repetitions rollback', (x) => { x.raw[1] = batch(base - 3_000_000n, 2_000_000n, 1); });
consumerCase('missing native endpoint', (x) => { x.raw[0].raw.cpuReads.pop(); });
consumerCase('forged endpoint value', (x) => { x.raw[0].raw.cpuReads[0].valueNs = String(base + 1n); });
consumerCase('wrong ordinal', (x) => { x.raw[0].raw.cpuReads[1].sequence = 0; });
consumerCase('wrong positive divisor', (x) => { x.operationNs /= 2; for (const row of x.raw) row.operationNs /= 2; }, 'REFUSED', 2);

function encodedCase(name, mutate) {
  const input = structuredClone(sample());
  for (const row of input.raw) row.raw.cpuReads = compactServerCpuEvidence(row.raw.cpuReads);
  mutate(input);
  const actual = verdict(input, 1);
  assert.equal(actual.verdict, 'REFUSED', name);
  result.encodedCases.push({ name, expected: 'REFUSED', input, actual });
}
encodedCase('tuple changed with unchanged clockReads', (x) => { x.raw[0].raw.cpuReads.runs[0].values[1][1]++; });
encodedCase('foreign PID/TID run retained for validator', (x) => { x.raw[0].raw.cpuReads.runs[0].pid++; x.raw[0].raw.cpuReads.runs[0].tid++; });
encodedCase('foreign clock run retained for validator', (x) => { x.raw[0].raw.cpuReads.runs[0].clock = 'CLOCK_PROCESS_CPUTIME_ID'; });
encodedCase('count drift', (x) => { x.raw[0].raw.cpuReads.count++; });
encodedCase('gap in acquired run', (x) => { x.raw[0].raw.cpuReads.runs[0].from++; });
encodedCase('missing acquired suffix', (x) => { x.raw[0].raw.cpuReads.runs[0].values.pop(); });
encodedCase('adjacent metadata duplicate is not canonical', (x) => {
  const r = x.raw[0].raw.cpuReads.runs[0];
  x.raw[0].raw.cpuReads.runs = [{ ...r, count: 1, values: [r.values[0]] }, { ...r, from: 1, count: 1, values: [r.values[1]] }];
});

// Execute the exact private helper text without running the expensive profile.
// Its production call site was independently inspected after engineMeasure and
// before sample publication. This probe covers the helper, not the full runner.
const runnerSource = readFileSync(new URL('./source/bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8');
const helperText = /function compactSampleCpuEvidence\(sample\) \{[\s\S]+?\n\}/.exec(runnerSource)?.[0];
assert.ok(helperText);
writeFileSync(new URL('./captured-private-helper.txt', import.meta.url), helperText);
const helper = Function('compactServerCpuEvidence', 'return (' + helperText + ');')(compactServerCpuEvidence);
const healthy = structuredClone(sample());
helper(healthy);
assert.ok(healthy.raw.every((row) => row.raw.cpuReads.encoding === 'native-cpu-rle-v1'));
const failed = structuredClone(sample()); failed.raw[7].raw.cpuReads[1].valueNs = '0';
const originalArrays = failed.raw.map((row) => row.raw.cpuReads);
const failureBefore = JSON.stringify(failed);
let failure;
try { helper(failed); } catch (e) { failure = e; }
assert.ok(failure instanceof AggregateError);
assert.strictEqual(failure.raw, failed);
assert.equal(JSON.stringify(failed), failureBefore);
assert.ok(failed.raw.every((row, i) => row.raw.cpuReads === originalArrays[i]));
result.atomicFailure = { helperSha256: createHash('sha256').update(helperText).digest('hex'), healthyAllEncoded: true,
  originalArraysPreserved: true, originalJsonPreserved: true, rawIdentityPreserved: true,
  error: failure.message, innerError: failure.errors[0].message, input: JSON.parse(failureBefore) };
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
