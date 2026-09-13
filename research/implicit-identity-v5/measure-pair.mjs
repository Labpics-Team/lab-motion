import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [entryA, entryB, mode, sizeRaw, easingKind, clusterRaw, positiveRaw = '0'] = process.argv.slice(2);
const n = Number(sizeRaw);
const cluster = Number(clusterRaw);
const positive = positiveRaw === '1';
assert(mode === 'setup' || mode === 'seek');
assert(Number.isSafeInteger(n) && n >= 2);
assert(easingKind === 'default' || easingKind === 'custom');
assert(Number.isSafeInteger(cluster) && cluster >= 0);
assert(positiveRaw === '0' || positiveRaw === '1');

const urlA = `${pathToFileURL(entryA).href}?paired-block-a-${cluster}`;
const urlB = `${pathToFileURL(entryB).href}?paired-block-b-${cluster}`;
const moduleA = await import(urlA);
const moduleB = await import(urlB);
assert.notEqual(moduleA.keyframes, moduleB.keyframes, 'paired sides must have independent module identities');
const factories = [moduleA.keyframes, moduleB.keyframes];

const values = Array.from({ length: n }, (_, i) => i * 3 - 7);
const requestFrame = () => 1;
const easing = easingKind === 'custom' ? (t) => t * t : undefined;
const checksum = new Float64Array(1);
let callbackCount = 0;
const onStep = (value) => {
  checksum[0] += value;
  callbackCount++;
};
const options = { values, requestFrame, easing, onStep };
const held = mode === 'seek' ? factories.map((factory) => factory(options)) : [];
for (const control of held) control.pause();

// Long enough to make each paired block materially larger than timer/scheduler quanta,
// but bounded so every independent child process remains cheap enough to repeat.
const calls = mode === 'setup' ? 4096 : 262144;
const warmPhases = 4;
const measuredPhases = 4;

function expectedSample(progress) {
  if (progress === 0) return values[0];
  const segment = Math.floor(progress * (n - 1));
  const lo = segment / (n - 1);
  const hi = (segment + 1) / (n - 1);
  const local = (progress - lo) / (hi - lo);
  return values[segment] + 3 * (easingKind === 'custom' ? local * local : local);
}

let expectedPerBurst = 0;
if (mode === 'setup') {
  expectedPerBurst = calls * 2 * expectedSample(0.375);
} else {
  for (let i = 0; i < calls; i++) expectedPerBurst += expectedSample((i & 1023) / 1024);
}

function burst(side, factor = 1) {
  const create = factories[side];
  const current = held[side];
  for (let repetition = 0; repetition < factor; repetition++) {
    for (let i = 0; i < calls; i++) {
      if (mode === 'setup') {
        const control = create(options);
        control.pause();
        control.seek(0.375);
        control.cancel();
      } else {
        current.seek((i & 1023) / 1024);
      }
    }
  }
}

function orderFor(phase) {
  // ABBA within every four-phase block; cluster parity swaps ownership of the first slot.
  const first = ((phase % 4 === 1 || phase % 4 === 2) ? 1 : 0) ^ (cluster & 1);
  return [first, 1 - first];
}

let maxClockDeltaNs = 0;
for (let i = 0; i < 256; i++) {
  const start = process.hrtime.bigint();
  maxClockDeltaNs = Math.max(maxClockDeltaNs, Number(process.hrtime.bigint() - start));
}

const warmCallbackCount = [0, 0];
for (let phase = 0; phase < warmPhases; phase++) {
  for (const side of orderFor(phase)) {
    checksum[0] = 0;
    callbackCount = 0;
    burst(side, 1);
    assert.equal(checksum[0], expectedPerBurst);
    const expectedCallbacks = calls * (mode === 'setup' ? 2 : 1);
    assert.equal(callbackCount, expectedCallbacks);
    warmCallbackCount[side] += callbackCount;
  }
}

const samples = [[], []];
const measuredOrders = [];
for (let phase = 0; phase < measuredPhases; phase++) {
  const order = orderFor(phase);
  measuredOrders.push(order);
  for (const side of order) {
    const factor = side === 1 && positive ? 2 : 1;
    checksum[0] = 0;
    callbackCount = 0;
    const usageBefore = process.resourceUsage();
    const start = process.hrtime.bigint();
    burst(side, factor);
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const usageAfter = process.resourceUsage();
    const expectedCallbacks = calls * factor * (mode === 'setup' ? 2 : 1);
    assert.equal(callbackCount, expectedCallbacks);
    assert.equal(checksum[0], expectedPerBurst * factor);
    const cpuUs =
      usageAfter.userCPUTime - usageBefore.userCPUTime +
      usageAfter.systemCPUTime - usageBefore.systemCPUTime;
    samples[side].push({
      phase,
      factor,
      elapsedNs,
      cpuNs: cpuUs * 1000,
      checksum: checksum[0],
      callbackCount,
      voluntary: usageAfter.voluntaryContextSwitches - usageBefore.voluntaryContextSwitches,
      involuntary: usageAfter.involuntaryContextSwitches - usageBefore.involuntaryContextSwitches,
    });
  }
}

for (const control of held) control.cancel();
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const total = (side, key) => samples[side].reduce((sum, sample) => sum + sample[key], 0);
const wallRatio = total(1, 'elapsedNs') / total(0, 'elapsedNs');
const cpuRatio = total(1, 'cpuNs') / total(0, 'cpuNs');
assert(Number.isFinite(wallRatio) && wallRatio > 0);
assert(Number.isFinite(cpuRatio) && cpuRatio > 0);

console.log(JSON.stringify({
  mode,
  n,
  easingKind,
  cluster,
  positive,
  calls,
  warmPhases,
  measuredPhases,
  warmCallbackCount,
  measuredOrders,
  samples,
  wallRatio,
  cpuRatio,
  sourceHashes: [hash(entryA), hash(entryB)],
  maxClockDeltaNs,
  node: process.version,
}));
