import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [root, supportRoot, multiplierText = '1'] = process.argv.slice(2);
const multiplier = Number(multiplierText);
assert(multiplier === 1 || multiplier === 2);
const { animate } = await import(pathToFileURL(`${root}/dist/animate/index.js`));
const { runMassLifecycleSample } = await import(pathToFileURL(`${supportRoot}/scripts/bench-support.mjs`));

const REPS = new Map([[1, 100], [100, 10], [1000, 2]]);
const WARMUP_BATCHES = 8;
const MEASURED_BATCHES = 9;
const rows = {};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

async function mainBatch(motion, count) {
  const out = { startNs: 0, frames60Ns: 0, teardownNs: 0 };
  for (let copy = 0; copy < multiplier; copy++) {
    for (let i = 0; i < REPS.get(count); i++) {
      const sample = await runMassLifecycleSample({ animate, count, motion });
      assert.equal(sample.semantic.valid, true);
      assert.equal(sample.semantic.totalWrites, 60 * count);
      out.startNs += sample.startNs;
      out.frames60Ns += sample.frames60Ns;
      out.teardownNs += sample.teardownNs;
    }
  }
  return out;
}

const STYLE = { getPropertyValue: () => '', setProperty() {} };
async function waapiBatch(count) {
  const targets = Array.from({ length: count }, () => ({
    style: STYLE,
    animate: () => ({ currentTime: 100, cancel() {} }),
  }));
  const out = { startNs: 0, teardownNs: 0 };
  for (let copy = 0; copy < multiplier; copy++) {
    for (let i = 0; i < REPS.get(count); i++) {
      const pending = new Set();
      const before = process.hrtime.bigint();
      const controls = animate(targets, { x: [0, 100], opacity: [0, 1] }, {
        now: () => 0,
        setTimer(cb) {
          const fire = () => { pending.delete(fire); cb(); };
          pending.add(fire);
          return () => { pending.delete(fire); };
        },
      });
      const started = process.hrtime.bigint();
      controls.cancel();
      const ended = process.hrtime.bigint();
      await controls.finished;
      assert.equal(pending.size, 0);
      out.startNs += Number(started - before);
      out.teardownNs += Number(ended - started);
    }
  }
  return out;
}

async function measure(key, fn) {
  for (let i = 0; i < WARMUP_BATCHES; i++) await fn();
  const samples = [];
  for (let i = 0; i < MEASURED_BATCHES; i++) samples.push(await fn());
  const metrics = Object.keys(samples[0]);
  rows[key] = {
    raw: samples,
    median: Object.fromEntries(metrics.map((metric) => [metric, median(samples.map((sample) => sample[metric]))])),
  };
}

for (const motion of ['tween', 'spring']) {
  for (const count of [1, 100, 1000]) {
    await measure(`main/${motion}/${count}`, () => mainBatch(motion, count));
  }
}
for (const count of [1, 100, 1000]) {
  await measure(`waapi/${count}`, () => waapiBatch(count));
}

console.log(JSON.stringify({
  root,
  multiplier,
  repetitions: Object.fromEntries(REPS),
  warmupBatches: WARMUP_BATCHES,
  measuredBatches: MEASURED_BATCHES,
  rows,
  environment: { node: process.version, v8: process.versions.v8 },
}));
