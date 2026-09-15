import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalGzip, observationalBrotli } from './compression-oracle.mjs';

const BASE_SHA = 'fe11daa407de396fad952be7679650f63dabd4dd';
const CANDIDATE_SHA = 'df7aaced646116f34135083dbfbf62ee40265657';
const OPS = 5_000;
const WARMUPS = 8;
const NULL_PAIRS = 20;
const POSITIVE_PAIRS = 10;
const PRODUCT_PAIRS = 120;
const BOOTSTRAPS = 10_000;
const SEED = 0x415fe11d;

const baseRoot = process.argv[2];
const candidateRoot = process.argv[3];
if (!baseRoot || !candidateRoot) throw new Error('usage: node --expose-gc script BASE_ROOT CANDIDATE_ROOT');
if (typeof global.gc !== 'function') throw new Error('requires --expose-gc');

const importAnimate = async (root) => {
  const mod = await import(pathToFileURL(resolve(root, 'dist/animate/index.js')).href);
  if (typeof mod.animate !== 'function') throw new Error(`animate export missing: ${root}`);
  return mod.animate;
};

const [baseAnimate, candidateAnimate] = await Promise.all([
  importAnimate(baseRoot),
  importAnimate(candidateRoot),
]);

const requestFrame = () => 1;
const matchMedia = () => ({ matches: false });
const options = Object.freeze({ requestFrame, matchMedia });
const freshProps = Object.freeze({
  x: [0, 100],
  y: [0, 80],
  scaleX: [1, 1.2],
  scaleY: [1, 0.8],
  rotate: [0, 30],
  skewX: [0, 4],
  skewY: [0, -3],
});
const retargetProps = Object.freeze({ x: 140 });

function fakeEl() {
  const inline = new Map();
  return {
    style: {
      setProperty(name, value) { inline.set(name, value); },
      getPropertyValue(name) { return inline.get(name) ?? ''; },
      removeProperty(name) { inline.delete(name); },
    },
  };
}

function prepareFresh(n) {
  return Array.from({ length: n }, () => fakeEl());
}

function prepareRetarget(animate, n) {
  const targets = prepareFresh(n);
  const owners = new Array(n);
  for (let i = 0; i < n; i++) owners[i] = animate(targets[i], freshProps, options);
  return { targets, owners };
}

function prepare(animate, scenario, n) {
  return scenario === 'fresh7' ? { targets: prepareFresh(n), owners: null } : prepareRetarget(animate, n);
}

function timedPrepared(animate, scenario, prepared) {
  const controls = new Array(prepared.targets.length);
  global.gc();
  const start = process.hrtime.bigint();
  if (scenario === 'fresh7') {
    for (let i = 0; i < prepared.targets.length; i++) {
      controls[i] = animate(prepared.targets[i], freshProps, options);
    }
  } else {
    for (let i = 0; i < prepared.targets.length; i++) {
      controls[i] = animate(prepared.targets[i], retargetProps, options);
    }
  }
  const elapsed = Number(process.hrtime.bigint() - start);
  // Keep controls and prepared owners strongly live until after the timestamp.
  if (controls.length !== prepared.targets.length) throw new Error('unreachable controls mismatch');
  return elapsed;
}

function timedBatch(animate, scenario, n) {
  const prepared = prepare(animate, scenario, n);
  return timedPrepared(animate, scenario, prepared);
}

function ratioPair(leftFn, rightFn, scenario, i, leftOps = OPS, rightOps = OPS) {
  // Preparation for each side is outside both timing intervals.
  const leftPrepared = prepare(leftFn, scenario, leftOps);
  const rightPrepared = prepare(rightFn, scenario, rightOps);
  let left;
  let right;
  if ((i & 1) === 0) {
    left = timedPrepared(leftFn, scenario, leftPrepared);
    right = timedPrepared(rightFn, scenario, rightPrepared);
  } else {
    right = timedPrepared(rightFn, scenario, rightPrepared);
    left = timedPrepared(leftFn, scenario, leftPrepared);
  }
  return { left, right, ratio: right / left };
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('empty quantile');
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

function bootstrapCI(ratios, q, seedSalt) {
  const random = rng((SEED ^ seedSalt) >>> 0);
  const stats = new Array(BOOTSTRAPS);
  const sample = new Array(ratios.length);
  for (let b = 0; b < BOOTSTRAPS; b++) {
    for (let i = 0; i < ratios.length; i++) {
      sample[i] = ratios[Math.floor(random() * ratios.length)];
    }
    stats[b] = quantile(sample, q);
  }
  return [quantile(stats, 0.025), quantile(stats, 0.975)];
}

function summarizeProduct(ratios, salt) {
  const p50 = quantile(ratios, 0.5);
  const p95 = quantile(ratios, 0.95);
  return {
    p50,
    p50CI: bootstrapCI(ratios, 0.5, salt),
    p95,
    p95CI: bootstrapCI(ratios, 0.95, salt ^ 0x9e3779b9),
    min: Math.min(...ratios),
    max: Math.max(...ratios),
  };
}

function sizeOf(root, rel) {
  const bytes = readFileSync(resolve(root, rel));
  return {
    raw: bytes.length,
    gzip: canonicalGzip(bytes).length,
    brotli: observationalBrotli(bytes).length,
  };
}

const size = {};
for (const rel of ['dist/animate/index.js', 'dist/animate/index.cjs']) {
  size[rel] = {
    base: sizeOf(baseRoot, rel),
    candidate: sizeOf(candidateRoot, rel),
  };
}
console.log('LM_START_PROOF_SIZE ' + JSON.stringify(size));

const scenarios = ['fresh7', 'retarget7->x'];
const results = {};
for (let s = 0; s < scenarios.length; s++) {
  const scenario = scenarios[s];
  for (let i = 0; i < WARMUPS; i++) {
    timedBatch(baseAnimate, scenario, OPS);
    timedBatch(candidateAnimate, scenario, OPS);
  }

  const baseNull = [];
  const candidateNull = [];
  for (let i = 0; i < NULL_PAIRS; i++) {
    baseNull.push(ratioPair(baseAnimate, baseAnimate, scenario, i).ratio);
    candidateNull.push(ratioPair(candidateAnimate, candidateAnimate, scenario, i).ratio);
  }

  const basePositive = [];
  const candidatePositive = [];
  for (let i = 0; i < POSITIVE_PAIRS; i++) {
    basePositive.push(ratioPair(baseAnimate, baseAnimate, scenario, i, OPS, OPS * 2).ratio);
    candidatePositive.push(ratioPair(candidateAnimate, candidateAnimate, scenario, i, OPS, OPS * 2).ratio);
  }

  const nullSummary = {
    baseP50: quantile(baseNull, 0.5),
    candidateP50: quantile(candidateNull, 0.5),
  };
  const positiveSummary = {
    baseP50: quantile(basePositive, 0.5),
    candidateP50: quantile(candidatePositive, 0.5),
  };
  const calibrationPass =
    nullSummary.baseP50 >= 0.95 && nullSummary.baseP50 <= 1.05 &&
    nullSummary.candidateP50 >= 0.95 && nullSummary.candidateP50 <= 1.05 &&
    positiveSummary.baseP50 >= 1.80 && positiveSummary.candidateP50 >= 1.80;

  const productRatios = [];
  for (let i = 0; i < PRODUCT_PAIRS; i++) {
    productRatios.push(ratioPair(baseAnimate, candidateAnimate, scenario, i).ratio);
  }
  const product = summarizeProduct(productRatios, 0x1000 + s);
  results[scenario] = {
    calibration: { null: nullSummary, positive: positiveSummary, pass: calibrationPass },
    product,
    nonInferior: calibrationPass && product.p50CI[1] <= 1.05 && product.p95CI[1] <= 1.05,
  };
  console.log('LM_START_PROOF_SCENARIO ' + JSON.stringify({ scenario, ...results[scenario] }));
}

const sizePass = Object.values(size).every(({ base, candidate }) =>
  candidate.raw <= base.raw && candidate.gzip <= base.gzip && candidate.brotli <= base.brotli
);
const calibrationPass = Object.values(results).every((x) => x.calibration.pass);
const timingPass = Object.values(results).every((x) => x.nonInferior);
const verdict = {
  baseSha: BASE_SHA,
  candidateSha: CANDIDATE_SHA,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  ops: OPS,
  warmups: WARMUPS,
  nullPairs: NULL_PAIRS,
  positivePairs: POSITIVE_PAIRS,
  productPairs: PRODUCT_PAIRS,
  bootstraps: BOOTSTRAPS,
  seed: `0x${SEED.toString(16)}`,
  sizePass,
  calibrationPass,
  timingPass,
  results,
  size,
};
console.log('LM_START_PROOF_VERDICT ' + JSON.stringify(verdict));
if (!sizePass) process.exitCode = 20;
else if (!calibrationPass) process.exitCode = 21;
else if (!timingPass) process.exitCode = 22;
