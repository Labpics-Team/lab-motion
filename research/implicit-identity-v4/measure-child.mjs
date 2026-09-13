import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [entry, mode, size, easingKind, factorRaw = '1'] = process.argv.slice(2);
const N = Number(size);
const factor = Number(factorRaw);
assert(mode === 'setup' || mode === 'seek');
assert(Number.isInteger(N) && N >= 2);
assert(easingKind === 'default' || easingKind === 'custom');
assert(factor === 1 || factor === 2);

const { keyframes } = await import(pathToFileURL(entry));
const values = Array.from({ length: N }, (_, i) => i * 3 - 7);
const requestFrame = () => 1;
const easing = easingKind === 'custom' ? (t) => t * t : undefined;
const sourceHash = createHash('sha256').update(readFileSync(entry)).digest('hex');

// Preserve the v3 operation and roughly the same warm operation count, but make
// every timed observation long enough that scheduler tails are small relative to
// the measured window. No samples are filtered.
const calls = mode === 'setup' ? 8192 : 524288;
const warmCalls = mode === 'setup' ? 8192 : 262144;
const checksum = new Float64Array(1);
let callbackCount = 0;
const onStep = (value) => {
  checksum[0] += value;
  callbackCount++;
};
const options = { values, requestFrame, easing, onStep };
const held = mode === 'seek' ? keyframes(options) : null;
held?.pause();

function runOperations(count) {
  for (let i = 0; i < count; i++) {
    if (mode === 'setup') {
      const control = keyframes(options);
      control.pause();
      control.seek(0.375);
      control.cancel();
    } else {
      held.seek((i & 1023) / 1024);
    }
  }
}

function expectedSample(progress) {
  if (progress === 0) return values[0];
  const segment = Math.floor(progress * (N - 1));
  const lo = segment / (N - 1);
  const hi = (segment + 1) / (N - 1);
  const local = (progress - lo) / (hi - lo);
  return values[segment] + 3 * (easingKind === 'custom' ? local * local : local);
}

let expectedTimed = 0;
if (mode === 'setup') {
  // seek + cancel each publish the same current value.
  expectedTimed = calls * 2 * expectedSample(0.375);
} else {
  for (let i = 0; i < calls; i++) expectedTimed += expectedSample((i & 1023) / 1024);
}

// Timer diagnostic only. It is never used to drop observations.
let maxClockDeltaNs = 0;
for (let i = 0; i < 256; i++) {
  const start = process.hrtime.bigint();
  const end = process.hrtime.bigint();
  maxClockDeltaNs = Math.max(maxClockDeltaNs, Number(end - start));
}

checksum[0] = 0;
callbackCount = 0;
runOperations(warmCalls);
const warmCallbackCount = callbackCount;
const expectedWarmCallbacks = warmCalls * (mode === 'setup' ? 2 : 1);
assert.equal(warmCallbackCount, expectedWarmCallbacks);

const samples = [];
for (let observation = 0; observation < 4; observation++) {
  checksum[0] = 0;
  callbackCount = 0;
  const usageBefore = process.resourceUsage();
  const start = process.hrtime.bigint();
  runOperations(calls * factor);
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const usageAfter = process.resourceUsage();
  const expectedCallbacks = calls * factor * (mode === 'setup' ? 2 : 1);
  assert.equal(callbackCount, expectedCallbacks);
  assert.equal(checksum[0], expectedTimed * factor);
  const cpuUs =
    usageAfter.userCPUTime - usageBefore.userCPUTime +
    usageAfter.systemCPUTime - usageBefore.systemCPUTime;
  samples.push({
    elapsedNs,
    nsPerCall: elapsedNs / calls,
    cpuNsPerCall: (cpuUs * 1000) / calls,
    checksum: checksum[0],
    callbackCount,
    voluntary:
      usageAfter.voluntaryContextSwitches - usageBefore.voluntaryContextSwitches,
    involuntary:
      usageAfter.involuntaryContextSwitches - usageBefore.involuntaryContextSwitches,
  });
}

held?.cancel();
console.log(
  JSON.stringify({
    mode,
    N,
    easingKind,
    factor,
    calls,
    warmCalls,
    warmCallbackCount,
    samples,
    sourceHash,
    maxClockDeltaNs,
    node: process.version,
  }),
);
