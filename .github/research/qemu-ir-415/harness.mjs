import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const marker = require(process.env.LM_QEMU_MARKER);
const [bundlePath, caseName, mode = 'product'] = process.argv.slice(2);
if (!bundlePath || !caseName) throw new Error('usage: harness.mjs <bundle> <case> <mode>');

const { bindGroup, parseProps } = await import(pathToFileURL(bundlePath).href);
const N = 2000;
const WARM = 5000;
const KEYS = ['x', 'y', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY'];

const element = {
  style: {
    getPropertyValue() { return ''; },
    setProperty() {},
  },
};

function snapshot(key, i) {
  return { _value: i + 0.25, _velocity: key === 'x' ? 0.5 : 0 };
}

function makeFixture(name) {
  const numeric = new Map();
  let owner;
  let specs;
  let knownForPositive;
  if (name === 'settled-single') {
    specs = parseProps({ x: [0, 100] });
    for (let i = 1; i < KEYS.length; i++) numeric.set(KEYS[i], snapshot(KEYS[i], i));
    knownForPositive = KEYS.slice(1);
  } else if (name === 'all-seven') {
    specs = parseProps({
      x: [0, 100], y: [0, 100], scaleX: [1, 2], scaleY: [1, 2],
      rotate: [0, 90], skewX: [0, 10], skewY: [0, 10],
    });
    knownForPositive = KEYS;
  } else if (name === 'live-single') {
    specs = parseProps({ x: 100 });
    for (let i = 0; i < KEYS.length; i++) numeric.set(KEYS[i], snapshot(KEYS[i], i));
    const live = new Map(KEYS.map((key, i) => [key, snapshot(key, i + 10)]));
    owner = {
      _capture() {},
      _captureNum(key) { return live.get(key); },
      _captureCss() { return undefined; },
      _numericKeys() { return KEYS; },
      _supersede() {},
    };
    knownForPositive = KEYS;
  } else {
    throw new Error(`unknown case ${name}`);
  }
  const record = { _owner: owner, _transition: false, _numeric: numeric, _cssValue: undefined };
  return { specs, record, knownForPositive };
}

const fixture = makeFixture(caseName);

function productOne() {
  const bound = bindGroup(element, 'transform', fixture.specs, fixture.record);
  const tx = bound._transform?.x ?? 0;
  return bound._numeric.length * 17 + bound._residuals.size * 31 + tx;
}

function extraScan(bound) {
  let hits = 0;
  for (const key of fixture.knownForPositive) {
    for (const channel of bound._numeric) {
      if (channel._key === key) { hits++; break; }
    }
  }
  return hits;
}

function positiveOne() {
  const bound = bindGroup(element, 'transform', fixture.specs, fixture.record);
  const tx = bound._transform?.x ?? 0;
  return bound._numeric.length * 17 + bound._residuals.size * 31 + tx + extraScan(bound);
}

function productLoop(n) {
  let checksum = 0;
  for (let i = 0; i < n; i++) checksum += productOne();
  return checksum;
}

function positiveLoop(n) {
  let checksum = 0;
  for (let i = 0; i < n; i++) checksum += positiveOne();
  return checksum;
}

function optimized(status) {
  return (status & 16) !== 0;
}

let checksum = 0;
let statusBefore = 0;
let statusAfter = 0;

if (mode === 'floor') {
  marker.start();
  marker.end();
} else if (mode === 'product') {
  %PrepareFunctionForOptimization(productOne);
  %PrepareFunctionForOptimization(productLoop);
  for (let i = 0; i < WARM; i++) productOne();
  productLoop(100);
  %OptimizeFunctionOnNextCall(productOne);
  productOne();
  %OptimizeFunctionOnNextCall(productLoop);
  productLoop(100);
  statusBefore = Math.min(%GetOptimizationStatus(productOne), %GetOptimizationStatus(productLoop));
  if (!optimized(%GetOptimizationStatus(productOne)) || !optimized(%GetOptimizationStatus(productLoop))) {
    throw new Error(`not optimized before product: ${%GetOptimizationStatus(productOne)}/${%GetOptimizationStatus(productLoop)}`);
  }
  marker.start();
  checksum = productLoop(N);
  marker.end();
  statusAfter = Math.min(%GetOptimizationStatus(productOne), %GetOptimizationStatus(productLoop));
  if (!optimized(%GetOptimizationStatus(productOne)) || !optimized(%GetOptimizationStatus(productLoop))) {
    throw new Error(`deoptimized product: ${%GetOptimizationStatus(productOne)}/${%GetOptimizationStatus(productLoop)}`);
  }
} else if (mode === 'positive') {
  %PrepareFunctionForOptimization(positiveOne);
  %PrepareFunctionForOptimization(positiveLoop);
  for (let i = 0; i < WARM; i++) positiveOne();
  positiveLoop(100);
  %OptimizeFunctionOnNextCall(positiveOne);
  positiveOne();
  %OptimizeFunctionOnNextCall(positiveLoop);
  positiveLoop(100);
  statusBefore = Math.min(%GetOptimizationStatus(positiveOne), %GetOptimizationStatus(positiveLoop));
  if (!optimized(%GetOptimizationStatus(positiveOne)) || !optimized(%GetOptimizationStatus(positiveLoop))) {
    throw new Error(`not optimized before positive: ${%GetOptimizationStatus(positiveOne)}/${%GetOptimizationStatus(positiveLoop)}`);
  }
  marker.start();
  checksum = positiveLoop(N);
  marker.end();
  statusAfter = Math.min(%GetOptimizationStatus(positiveOne), %GetOptimizationStatus(positiveLoop));
  if (!optimized(%GetOptimizationStatus(positiveOne)) || !optimized(%GetOptimizationStatus(positiveLoop))) {
    throw new Error(`deoptimized positive: ${%GetOptimizationStatus(positiveOne)}/${%GetOptimizationStatus(positiveLoop)}`);
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}

if (!Number.isFinite(checksum)) throw new Error('non-finite checksum');
console.log(`HARNESS case=${caseName} mode=${mode} checksum=${checksum} statusBefore=${statusBefore} statusAfter=${statusAfter}`);
