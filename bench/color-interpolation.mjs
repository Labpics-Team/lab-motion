// pnpm build && node bench/color-interpolation.mjs
// Изолированный opaque RGB workload. Это не браузерный benchmark и не CI gate.
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { parseColor, interpolateColor } from '../dist/value/index.js';

const decode = channel => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const encode = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const parsed = text => {
  const color = parseColor(text);
  assert.ok(color);
  return color;
};
const cases = Array.from({ length: 256 }, (_, i) => {
  const fromText = `rgb(${i}, ${(i * 73) & 255}, ${(i * 19) & 255})`;
  const toText = `rgb(${255 - i}, ${(i * 37 + 11) & 255}, ${(i * 53 + 5) & 255})`;
  return { fromText, toText, from: parsed(fromText), to: parsed(toText), p: ((i * 41) & 255) / 255 };
});
function prepareExact({ from, to }) {
  return {
    r0: decode(from.r), r1: decode(to.r),
    g0: decode(from.g), g1: decode(to.g),
    b0: decode(from.b), b1: decode(to.b),
  };
}
const prepared = cases.map(prepareExact);
// Кандидат получает преимущество: EOTF концов вынесена из измеряемого frame path.
// Он ограничен валидным opaque RGB, НЕ является полной заменой public API.
function exactAt(c, p) {
  return `rgb(${Math.round(encode(c.r0 * (1 - p) + c.r1 * p))}, ${Math.round(encode(c.g0 * (1 - p) + c.g1 * p))}, ${Math.round(encode(c.b0 * (1 - p) + c.b1 * p))})`;
}
assert.ok(Math.abs(encode(0.5) - 187.51603067837462) < 1e-10);
assert.equal(interpolateColor(parsed('#fff'), parsed('#000'), 0.5), 'rgb(180, 180, 180)');
assert.equal(exactAt(prepareExact({ from: parsed('#fff'), to: parsed('#000') }), 0.5), 'rgb(188, 188, 188)');
for (let i = 0; i < cases.length; i++) {
  assert.deepEqual(parsed(exactAt(prepared[i], 0)), { ...cases[i].from, format: 'rgb' });
  assert.deepEqual(parsed(exactAt(prepared[i], 1)), { ...cases[i].to, format: 'rgb' });
}

const tasks = {
  parseOneEndpoint: i => parseColor(cases[i].fromText).r,
  prepareExactPair: i => {
    const c = prepareExact(cases[i]);
    return c.r0 + c.r1 + c.g0 + c.g1 + c.b0 + c.b1;
  },
  currentGamma2Serialized: i => {
    const c = cases[i];
    const text = interpolateColor(c.from, c.to, c.p);
    return text.length + text.charCodeAt(5);
  },
  preparedExactSerialized: i => {
    const text = exactAt(prepared[i], cases[i].p);
    return text.length + text.charCodeAt(5);
  },
};
const iterations = 100_000;
const rounds = 9;
let sink = 0;
function measure(fn) {
  let checksum = 0;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) checksum += fn(i & 255);
  const nsPerOp = (performance.now() - started) * 1e6 / iterations;
  sink += checksum;
  return { nsPerOp, checksum };
}
const names = Object.keys(tasks);
for (const name of names) for (let i = 0; i < 3; i++) measure(tasks[name]);
const samples = Object.fromEntries(names.map(name => [name, []]));
for (let round = 0; round < rounds; round++) {
  // Чередование порядка снижает, но не устраняет дрейф общей машины.
  for (const name of round % 2 ? [...names].reverse() : names) {
    samples[name].push(measure(tasks[name]));
  }
}
assert.ok(Number.isFinite(sink) && sink > 0);
const measurements = Object.fromEntries(names.map(name => {
  const times = samples[name].map(x => x.nsPerOp).sort((a, b) => a - b);
  assert.ok(samples[name].every(x => x.checksum === samples[name][0].checksum));
  return [name, { medianNsPerOp: times[Math.floor(rounds / 2)], samples: samples[name] }];
}));
console.log(JSON.stringify({
  scope: 'Node/V8 microbenchmark; finite opaque RGB; not browser smoothness or perceptual quality',
  node: process.version, v8: process.versions.v8, platform: process.platform,
  arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown',
  iterations, rounds, cases: cases.length, measurements,
  exactToGamma2MedianRatio: measurements.preparedExactSerialized.medianNsPerOp / measurements.currentGamma2Serialized.medianNsPerOp,
  sink,
}, null, 2));
