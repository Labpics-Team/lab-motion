import assert from 'node:assert/strict';
import { solveSpring } from '../../src/internal/solver.js';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  clearSpringExecutionArtifactCacheUnchecked,
} from '../../src/compositor/curve.js';

const TOL = 1 / 400;
const BUDGET = TOL * 0.70;
const ZETAS = [0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 1, 2, 5];
const V0S = [0, 3, -3];

function sample(params, v0, u) {
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const r = solveSpring(params, u / omega0, v0);
  return [r.value, r.velocity / omega0];
}

function buildCubic(params, v0, durationMs) {
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const zeta = params.damping / (2 * params.mass * omega0);
  const U = durationMs / 1000 * omega0;
  // В безразмерном времени u=ω₀t для y=x−1:
  // y'''' = (1−4ζ²)y + 4ζ(1−2ζ²)y'. Energy norm H=hypot(y,y')
  // не растёт, поэтому Cauchy-Schwarz даёт certified |y''''| bound.
  const a = 1 - 4 * zeta * zeta;
  const b = 4 * zeta * (1 - 2 * zeta * zeta);
  const coeff = Math.hypot(a, b);
  const knots = [];
  let u = 0;
  while (u < U && knots.length < 8192) {
    const [value, velocityU] = sample(params, v0, u);
    assert(Number.isFinite(value) && Number.isFinite(velocityU));
    knots.push([u, value, velocityU]);
    const H = Math.hypot(value - 1, velocityU);
    let h = coeff === 0 || H === 0
      ? U - u
      : Math.pow(384 * BUDGET / (coeff * H), 0.25);
    if (!Number.isFinite(h) || h <= 0) throw new Error('invalid-step');
    if (h > U - u) h = U - u;
    u += h;
    if (U - u < Number.EPSILON * Math.max(1, U)) u = U;
  }
  if (knots.length >= 8192) throw new Error('cubic-cap');
  // Та же terminal discipline, что production linear artifact.
  knots.push([U, 1, 0]);
  return knots;
}

function hermite(a, b, u) {
  const h = b[0] - a[0];
  const q = (u - a[0]) / h;
  const q2 = q * q;
  const q3 = q2 * q;
  return (2*q3 - 3*q2 + 1) * a[1]
    + (q3 - 2*q2 + q) * h * a[2]
    + (-2*q3 + 3*q2) * b[1]
    + (q3 - q2) * h * b[2];
}

function cubicControls(a, b) {
  const h = b[0] - a[0];
  const delta = b[1] - a[1];
  if (delta === 0 || !Number.isFinite(delta)) return undefined;
  const y1 = h * a[2] / (3 * delta);
  const y2 = 1 - h * b[2] / (3 * delta);
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return undefined;
  return [y1, y2];
}

function bezierY(q, y1, y2) {
  const r = 1 - q;
  return 3*r*r*q*y1 + 3*r*q*q*y2 + q*q*q;
}

const rows = [];
let mutationDetected = false;
for (const zeta of ZETAS) for (const v0 of V0S) {
  const params = { mass: 1, stiffness: 100, damping: 20 * zeta };
  clearSpringExecutionArtifactCacheUnchecked();
  let linear;
  try {
    linear = compileSpringExecutionArtifactTupleUnchecked(params, v0, TOL);
  } catch {
    continue;
  }
  const durationMs = linear[2];
  const knots = buildCubic(params, v0, durationMs);
  let maxErr = 0;
  let maxBezierParity = 0;
  let controlBytes = 0;
  let valid = true;
  for (let i = 0; i + 1 < knots.length; i++) {
    const left = knots[i];
    const right = knots[i + 1];
    const controls = cubicControls(left, right);
    if (!controls) { valid = false; break; }
    const [y1, y2] = controls;
    const easing = `cubic-bezier(.3333333333333333,${String(y1)},.6666666666666666,${String(y2)})`;
    controlBytes += Buffer.byteLength(easing);
    for (let j = 1; j < 64; j++) {
      const q = j / 64;
      const u = left[0] + (right[0] - left[0]) * q;
      const expected = sample(params, v0, u)[0];
      const h = hermite(left, right, u);
      const viaBezier = left[1] + (right[1] - left[1]) * bezierY(q, y1, y2);
      maxErr = Math.max(maxErr, Math.abs(h - expected));
      maxBezierParity = Math.max(maxBezierParity, Math.abs(viaBezier - h));
      if (i === 0 && j === 24) {
        const bad = left[1] + (right[1] - left[1]) * bezierY(q, y1 * 1.5, y2);
        if (Math.abs(bad - expected) > maxErr + 1e-6) mutationDetected = true;
      }
    }
  }
  const linearStops = linear[1].length / 2;
  const linearStringBytes = Buffer.byteLength(linear[0]);
  const linearRetainedLower = linearStringBytes + linear[1].byteLength;
  // Оптимистичный нижний предел C¹-sampleable cubic artifact: u,value,dx/du
  // на knot. Не включает container overhead и easing-строки.
  const cubicRetainedLower = knots.length * 3 * 8;
  rows.push({
    zeta, v0, valid, durationMs,
    linearStops, cubicSegments: knots.length - 1,
    maxErr, maxBezierParity,
    linearStringBytes, cubicControlStringBytes: controlBytes,
    linearRetainedLower, cubicRetainedLower,
    retainedRatio: cubicRetainedLower / linearRetainedLower,
    controlStringRatio: controlBytes / linearStringBytes,
  });
}
assert(rows.length > 0);
assert(mutationDetected, 'positive-control mutation was not observed');
for (const row of rows) {
  if (row.valid) assert(row.maxBezierParity < 1e-12, JSON.stringify(row));
}
const accepted = rows.filter(r => r.valid && r.maxErr <= TOL);
const under = accepted.filter(r => r.zeta < 1);
assert(accepted.length > 0 && under.length > 0, 'candidate accepted no representative rows');
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const summary = {
  exactBase: process.env.BASE_SHA,
  rows: rows.length,
  accepted: accepted.length,
  underAccepted: under.length,
  worstErrorRatio: Math.max(...accepted.map(r => r.maxErr / TOL)),
  underMedianSegmentRatio: median(under.map(r => r.cubicSegments / r.linearStops)),
  underMedianRetainedRatio: median(under.map(r => r.retainedRatio)),
  underMedianControlStringRatio: median(under.map(r => r.controlStringRatio)),
  underWorstControlStringRatio: Math.max(...under.map(r => r.controlStringRatio)),
  mutationDetected,
};
console.log(JSON.stringify({summary, rows}, null, 2));
