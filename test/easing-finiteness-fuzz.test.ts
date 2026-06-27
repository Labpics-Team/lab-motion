/**
 * easing-finiteness-fuzz.test.ts — property/fuzz
 * Class: property (Б/В)
 * Invariant NE1 — CSS-safe: every easing/normalizer returns a finite number
 * (never NaN, never Infinity, never -Infinity) for ALL inputs in IEEE-754,
 * including t<0, t>1, NaN, +Infinity, -Infinity, -0, and subnormals.
 *
 * Strategy: seeded LCG (Park-Miller) — deterministic, reproducible, zero deps.
 * >=10k random samples + full enumerated IEEE-754 edge set per easing.
 *
 * RED proof (before implementation):
 *   normalizeEasing and linear are not yet exported from ../src/easing/index.ts
 *   The `typeof normalizeEasing === 'function'` guard fires FIRST, failing with:
 *   "expected 'undefined' to be 'function'"
 *   This prevents the fuzz loop from silently passing on a non-existent function
 *   (theater: `(undefined)(t)` would throw, be caught as non-MotionParamError,
 *   re-throw, test fails for the WRONG reason = compile error not missing behavior).
 *   The typeof guard at the top of each test is the anti-theater hook.
 *
 * Mutation proof (for when implemented):
 *   Replace normalizeEasing to pass-through NaN unchanged:
 *   → the hostile fn (t => NaN) sample triggers Number.isFinite failure → RED.
 *   Return Infinity from linear at t<0 or t>1:
 *   → the enumerated edge for t<0 triggers → RED.
 */

import { describe, expect, it } from 'vitest';
import { normalizeEasing, linear } from '../src/easing/index.js';

/** Park-Miller LCG — seeded, reproducible, zero dependencies. */
function lcg(seed: number): () => number {
  let s = seed >>> 0; // ensure 32-bit unsigned
  return () => {
    s = (Math.imul(48271, s) + 0) & 0x7fffffff;
    return s / 0x7fffffff; // [0, 1)
  };
}

/** Map a uniform [0,1) value to the range [min, max]. */
function range(u: number, min: number, max: number): number {
  return min + u * (max - min);
}

/** Enumerated IEEE-754 edge-case t values that must always produce finite output. */
const IEEE754_EDGES: number[] = [
  0,
  1,
  -0,
  0.5,
  -1,
  2,
  -0.001,
  1.001,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE, // smallest positive subnormal
  Number.EPSILON,
  -Number.EPSILON,
  5e-324, // smallest positive subnormal (denormal)
  -5e-324,
  1 - Number.EPSILON,
  Number.EPSILON / 2,
];

const RANDOM_SAMPLES = 10_000;

/**
 * Run finiteness fuzz over an easing function.
 * All outputs must be finite (Number.isFinite).
 */
function assertFiniteOverDomain(name: string, fn: (t: number) => number): void {
  const rand = lcg(0xdeadbeef);
  const failures: string[] = [];

  // Enumerated IEEE-754 edges first
  for (const t of IEEE754_EDGES) {
    const result = fn(t);
    if (!Number.isFinite(result)) {
      failures.push(`${name}(${t}) = ${result} [edge]`);
    }
  }

  // Random samples across full number line (not just [0,1])
  for (let i = 0; i < RANDOM_SAMPLES; i++) {
    // Interleave: [0,1] samples, out-of-range samples, extreme samples
    let t: number;
    const bucket = i % 4;
    if (bucket === 0) {
      t = range(rand(), 0, 1); // normal domain
    } else if (bucket === 1) {
      t = range(rand(), -10, 10); // out-of-range
    } else if (bucket === 2) {
      t = range(rand(), -1e10, 1e10); // extreme range
    } else {
      t = range(rand(), 0, 1) < 0.5 ? -rand() * 1e308 : rand() * 1e308; // near-MAX_VALUE
    }
    const result = fn(t);
    if (!Number.isFinite(result)) {
      failures.push(`${name}(${t}) = ${result} [random sample ${i}]`);
    }
  }

  expect(
    failures,
    `NE1 finiteness violation — non-finite output detected:\n${failures.slice(0, 20).join('\n')}`,
  ).toHaveLength(0);
}

describe('easing finiteness fuzz — NE1 (CSS-safe invariant)', () => {
  it('normalizeEasing is callable — prerequisite guard (RED if absent)', () => {
    // Anti-theater: if this fails, hostile-fn tests below would throw TypeError
    // ("normalizeEasing is not a function"), which is a wrong-reason failure.
    expect(typeof normalizeEasing).toBe('function');
  });

  it('linear is callable — prerequisite guard (RED if absent)', () => {
    expect(typeof linear).toBe('function');
  });

  it('normalizeEasing(linear) produces ONLY finite output over >=10k samples + IEEE-754 edges (NE1)', () => {
    const normalized = normalizeEasing(linear);
    assertFiniteOverDomain('normalizeEasing(linear)', normalized);
  });

  it('normalizeEasing of hostile fn (t=>t/0) produces ONLY finite output — NaN/Infinity hardened (NE1)', () => {
    // t/0 produces: NaN at t=0, +Infinity at t>0, -Infinity at t<0
    const hostile = (t: number): number => t / 0;
    const normalized = normalizeEasing(hostile);
    assertFiniteOverDomain('normalizeEasing(t=>t/0)', normalized);
  });

  it('normalizeEasing of hostile fn (t=>NaN) produces ONLY finite output — NaN hardened to 0 (NE1)', () => {
    const hostile = (_t: number): number => Number.NaN;
    const normalized = normalizeEasing(hostile);
    assertFiniteOverDomain('normalizeEasing(t=>NaN)', normalized);
  });

  it('normalizeEasing of hostile fn (t=>-Infinity) produces ONLY finite output — Infinity clamped (NE1)', () => {
    const hostile = (_t: number): number => Number.NEGATIVE_INFINITY;
    const normalized = normalizeEasing(hostile);
    assertFiniteOverDomain('normalizeEasing(t=>-Infinity)', normalized);
  });

  it('normalizeEasing of hostile fn (t=>Number.MAX_VALUE*2) produces ONLY finite output (NE1)', () => {
    // 1.8e308 * 2 = Infinity in IEEE-754
    const hostile = (_t: number): number => Number.MAX_VALUE * 2;
    const normalized = normalizeEasing(hostile);
    assertFiniteOverDomain('normalizeEasing(t=>MAX_VALUE*2)', normalized);
  });

  it('linear alone (without normalizer) produces ONLY finite output over >=10k samples + IEEE-754 edges (NE1)', () => {
    assertFiniteOverDomain('linear', linear);
  });
});
