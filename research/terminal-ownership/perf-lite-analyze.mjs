import { readFileSync, writeFileSync } from 'node:fs';

const [dir, out] = process.argv.slice(2);
const read = (kind) => JSON.parse(readFileSync(`${dir}/${kind}.json`, 'utf8'));
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};
const median = (values) => quantile(values, 0.5);

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function bootstrapMedian(values, seed) {
  const random = makeRandom(seed);
  const boot = [];
  for (let b = 0; b < 20_000; b++) {
    const sample = [];
    for (let i = 0; i < values.length; i++) sample.push(values[Math.floor(random() * values.length)]);
    boot.push(median(sample));
  }
  return { p50: median(values), lo: quantile(boot, 0.025), hi: quantile(boot, 0.975) };
}

function cellKeys(file) {
  const first = file.rows[0].a.rows;
  const keys = [];
  for (const [scenario, row] of Object.entries(first)) {
    for (const metric of Object.keys(row.median)) keys.push([scenario, metric]);
  }
  return keys;
}
function ratios(file, scenario, metric) {
  return file.rows.map((block) => block.b.rows[scenario].median[metric] / block.a.rows[scenario].median[metric]);
}
function descriptive(file, side, scenario, metric) {
  const values = file.rows.flatMap((block) => block[side].rows[scenario].raw.map((sample) => sample[metric]));
  return { samples: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), p99: quantile(values, 0.99) };
}

const aa = read('aa');
const positive = read('positive');
const ab = read('ab');
const result = { pass: true, policy: { nonInferiority: 1.05, aaBand: [0.95, 1.05], positiveLower: 1.5 }, cells: {} };
let seed = 0x5eed1234;
for (const [scenario, metric] of cellKeys(ab)) {
  const aaCI = bootstrapMedian(ratios(aa, scenario, metric), seed++);
  const positiveCI = bootstrapMedian(ratios(positive, scenario, metric), seed++);
  const candidateCI = bootstrapMedian(ratios(ab, scenario, metric), seed++);
  const resolvable = aaCI.lo >= 0.95 && aaCI.hi <= 1.05;
  const positiveDetected = positiveCI.lo > 1.5;
  const nonInferior = candidateCI.hi <= 1.05;
  const pass = resolvable && positiveDetected && nonInferior;
  result.cells[`${scenario}/${metric}`] = {
    aa: aaCI,
    positive: positiveCI,
    candidate: candidateCI,
    descriptive: {
      base: descriptive(ab, 'a', scenario, metric),
      candidate: descriptive(ab, 'b', scenario, metric),
    },
    resolvable,
    positiveDetected,
    nonInferior,
    pass,
  };
  result.pass &&= pass;
}
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
