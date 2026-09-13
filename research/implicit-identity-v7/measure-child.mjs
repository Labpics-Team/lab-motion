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

// One child imports exactly one product implementation. Base and candidate are
// never resident in the same V8 isolate/process in this oracle.
const { keyframes } = await import(pathToFileURL(entry));
const sourceHash = createHash('sha256').update(readFileSync(entry)).digest('hex');
const values = Array.from({ length: N }, (_, i) => i * 3 - 7);
const requestFrame = () => 1;
const easing = easingKind === 'custom' ? (t) => t * t : undefined;
const checksum = new Float64Array(1);
let callbackCount = 0;
const onStep = (value) => {
  checksum[0] += value;
  callbackCount++;
};
const options = { values, requestFrame, easing, onStep };
const held = mode === 'seek' ? keyframes(options) : null;
held?.pause();

// Keep the product operation and warmup identical to v4. The new mechanism is
// an adjacent, implementation-independent reference clock inside each isolated
// process. It absorbs multiplicative platform-speed drift without discarding a
// single product observation.
const calls = mode === 'setup' ? 8192 : 524288;
const warmCalls = mode === 'setup' ? 8192 : 262144;
const referenceIterations = 16_777_216;
const referenceWarmRuns = 4;
let referenceSink = 0;

function runReference(count) {
  let x = 0x13579bdf | 0;
  let y = 0x2468ace1 | 0;
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x ^ i, 1664525) + 1013904223) | 0;
    y = (y + ((x >>> 11) ^ (x << 7))) | 0;
  }
  return (x ^ y) | 0;
}

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
  expectedTimed = calls * 2 * expectedSample(0.375);
} else {
  for (let i = 0; i < calls; i++) expectedTimed += expectedSample((i & 1023) / 1024);
}

function cpuNsBetween(before, after) {
  return (
    after.userCPUTime - before.userCPUTime +
    after.systemCPUTime - before.systemCPUTime
  ) * 1000;
}

function timeReference() {
  const usageBefore = process.resourceUsage();
  const start = process.hrtime.bigint();
  const sink = runReference(referenceIterations);
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const usageAfter = process.resourceUsage();
  referenceSink ^= sink;
  return {
    elapsedNs,
    cpuNs: cpuNsBetween(usageBefore, usageAfter),
    voluntary: usageAfter.voluntaryContextSwitches - usageBefore.voluntaryContextSwitches,
    involuntary: usageAfter.involuntaryContextSwitches - usageBefore.involuntaryContextSwitches,
  };
}

function timeProduct() {
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
  return {
    elapsedNs,
    cpuNs: cpuNsBetween(usageBefore, usageAfter),
    checksum: checksum[0],
    callbackCount,
    voluntary: usageAfter.voluntaryContextSwitches - usageBefore.voluntaryContextSwitches,
    involuntary: usageAfter.involuntaryContextSwitches - usageBefore.involuntaryContextSwitches,
  };
}

// Timer diagnostic only. Never used to remove or alter an observation.
let maxClockDeltaNs = 0;
for (let i = 0; i < 256; i++) {
  const start = process.hrtime.bigint();
  const end = process.hrtime.bigint();
  maxClockDeltaNs = Math.max(maxClockDeltaNs, Number(end - start));
}

// Warm both independent mechanisms before any timing evidence.
for (let i = 0; i < referenceWarmRuns; i++) referenceSink ^= runReference(referenceIterations);
checksum[0] = 0;
callbackCount = 0;
runOperations(warmCalls);
const warmCallbackCount = callbackCount;
assert.equal(warmCallbackCount, warmCalls * (mode === 'setup' ? 2 : 1));

const samples = [];
for (let observation = 0; observation < 4; observation++) {
  const referenceBefore = timeReference();
  const product = timeProduct();
  const referenceAfter = timeReference();
  const referenceWallNsPerIteration =
    (referenceBefore.elapsedNs + referenceAfter.elapsedNs) / (2 * referenceIterations);
  const referenceCpuNsPerIteration =
    (referenceBefore.cpuNs + referenceAfter.cpuNs) / (2 * referenceIterations);
  const nsPerCall = product.elapsedNs / calls;
  const cpuNsPerCall = product.cpuNs / calls;
  assert(Number.isFinite(referenceWallNsPerIteration) && referenceWallNsPerIteration > 0);
  assert(Number.isFinite(referenceCpuNsPerIteration) && referenceCpuNsPerIteration > 0);
  samples.push({
    observation,
    nsPerCall,
    cpuNsPerCall,
    normalizedWall: nsPerCall / referenceWallNsPerIteration,
    normalizedCpu: cpuNsPerCall / referenceCpuNsPerIteration,
    referenceWallNsPerIteration,
    referenceCpuNsPerIteration,
    product,
    referenceBefore,
    referenceAfter,
  });
}

held?.cancel();
console.log(JSON.stringify({
  mode,
  N,
  easingKind,
  factor,
  calls,
  warmCalls,
  warmCallbackCount,
  referenceIterations,
  referenceWarmRuns,
  referenceSink,
  samples,
  sourceHash,
  maxClockDeltaNs,
  node: process.version,
}));