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
 * RED proof (before named curves existed):
 *   The `typeof fn === 'function'` guard fires FIRST for any absent export,
 *   failing with "expected 'undefined' to be 'function'".
 *   This prevents the fuzz loop from silently passing on a non-existent function.
 *
 * Mutation proof:
 *   Remove clampFinite call from any curve body:
 *   → trig/exp functions return NaN/Infinity for hostile t → RED.
 *   Return pass-through NaN from normalizeEasing:
 *   → hostile fn (t=>NaN) sample triggers Number.isFinite failure → RED.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeEasing,
  linear,
  easeIn,
  easeOut,
  easeInOut,
  sineIn,
  sineOut,
  sineInOut,
  expoIn,
  expoOut,
  expoInOut,
  circIn,
  circOut,
  circInOut,
  backIn,
  backOut,
  backInOut,
  anticipate,
  elastic,
  bounce,
  power,
  cubicBezier,
  steps,
} from '../src/easing/index.js';

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
  // --- prerequisite guards (anti-theater: wrong-reason failure if absent) ---
  it('normalizeEasing is callable — prerequisite guard (RED if absent)', () => {
    expect(typeof normalizeEasing).toBe('function');
  });
  it('linear is callable — prerequisite guard (RED if absent)', () => {
    expect(typeof linear).toBe('function');
  });

  // --- normalizeEasing harness ---
  it('normalizeEasing(linear) produces ONLY finite output over >=10k samples + IEEE-754 edges (NE1)', () => {
    const normalized = normalizeEasing(linear);
    assertFiniteOverDomain('normalizeEasing(linear)', normalized);
  });
  it('normalizeEasing of hostile fn (t=>t/0) produces ONLY finite output — NaN/Infinity hardened (NE1)', () => {
    const hostile = (t: number): number => t / 0;
    const normalized = normalizeEasing(hostile);
    assertFiniteOverDomain('normalizeEasing(t=>t/0)', normalized);
  });
  it('normalizeEasing of hostile fn (t=>NaN) clamps EXACTLY to 0 — mutation-pins NaN→0 contract (NE1)', () => {
    const hostile = (_t: number): number => Number.NaN;
    const normalized = normalizeEasing(hostile);
    // EXACT clamp target: NaN → 0 (not just "finite") — pins clampFinite NaN branch
    expect(normalized(0), 'NaN output must clamp to exactly 0').toBe(0);
    expect(normalized(0.5), 'NaN output must clamp to exactly 0').toBe(0);
    expect(normalized(1), 'NaN output must clamp to exactly 0').toBe(0);
    assertFiniteOverDomain('normalizeEasing(t=>NaN)', normalized);
  });
  it('normalizeEasing of hostile fn (t=>+Infinity) clamps EXACTLY to Number.MAX_VALUE — mutation-pins +Inf contract (NE1)', () => {
    const hostile = (_t: number): number => Number.POSITIVE_INFINITY;
    const normalized = normalizeEasing(hostile);
    // EXACT clamp target: +Infinity → Number.MAX_VALUE — pins clampFinite +Inf branch
    expect(normalized(0), '+Infinity output must clamp to exactly Number.MAX_VALUE').toBe(Number.MAX_VALUE);
    expect(normalized(0.5), '+Infinity output must clamp to exactly Number.MAX_VALUE').toBe(Number.MAX_VALUE);
    expect(normalized(1), '+Infinity output must clamp to exactly Number.MAX_VALUE').toBe(Number.MAX_VALUE);
    assertFiniteOverDomain('normalizeEasing(t=>+Infinity)', normalized);
  });
  it('normalizeEasing of hostile fn (t=>-Infinity) clamps EXACTLY to -Number.MAX_VALUE — mutation-pins -Inf contract (NE1)', () => {
    const hostile = (_t: number): number => Number.NEGATIVE_INFINITY;
    const normalized = normalizeEasing(hostile);
    // EXACT clamp target: -Infinity → -Number.MAX_VALUE — pins clampFinite -Inf branch
    expect(normalized(0), '-Infinity output must clamp to exactly -Number.MAX_VALUE').toBe(-Number.MAX_VALUE);
    expect(normalized(0.5), '-Infinity output must clamp to exactly -Number.MAX_VALUE').toBe(-Number.MAX_VALUE);
    expect(normalized(1), '-Infinity output must clamp to exactly -Number.MAX_VALUE').toBe(-Number.MAX_VALUE);
    assertFiniteOverDomain('normalizeEasing(t=>-Infinity)', normalized);
  });
  it('normalizeEasing of hostile fn (t=>Number.MAX_VALUE*2) clamps EXACTLY to Number.MAX_VALUE — mutation-pins overflow contract (NE1)', () => {
    const hostile = (_t: number): number => Number.MAX_VALUE * 2; // overflows to +Infinity in IEEE-754
    const normalized = normalizeEasing(hostile);
    // MAX_VALUE*2 = +Infinity in IEEE-754, so clamps to Number.MAX_VALUE
    expect(normalized(0.5), 'overflow to +Infinity must clamp to exactly Number.MAX_VALUE').toBe(Number.MAX_VALUE);
    assertFiniteOverDomain('normalizeEasing(t=>MAX_VALUE*2)', normalized);
  });
  it('linear alone (without normalizer) produces ONLY finite output over >=10k samples + IEEE-754 edges (NE1)', () => {
    assertFiniteOverDomain('linear', linear);
  });

  // --- named curves: easeIn/Out/InOut ---
  it('easeIn — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('easeIn', easeIn);
  });
  it('easeOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('easeOut', easeOut);
  });
  it('easeInOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('easeInOut', easeInOut);
  });

  // --- sine family ---
  it('sineIn — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('sineIn', sineIn);
  });
  it('sineOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('sineOut', sineOut);
  });
  it('sineInOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('sineInOut', sineInOut);
  });

  // --- expo family ---
  it('expoIn — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('expoIn', expoIn);
  });
  it('expoOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('expoOut', expoOut);
  });
  it('expoInOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('expoInOut', expoInOut);
  });

  // --- circ family ---
  it('circIn — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('circIn', circIn);
  });
  it('circOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('circOut', circOut);
  });
  it('circInOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('circInOut', circInOut);
  });

  // --- back family ---
  it('backIn — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('backIn', backIn);
  });
  it('backOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('backOut', backOut);
  });
  it('backInOut — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('backInOut', backInOut);
  });

  // --- anticipate ---
  it('anticipate — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('anticipate', anticipate);
  });

  // --- elastic ---
  it('elastic — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('elastic', elastic);
  });

  // --- bounce ---
  it('bounce — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('bounce', bounce);
  });

  // --- power factory ---
  it('power(2) (quad) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('power(2)', power(2));
  });
  it('power(3) (cubic) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('power(3)', power(3));
  });
  it('power(4) (quart) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('power(4)', power(4));
  });
  it('power(5) (quint) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('power(5)', power(5));
  });
  it('power(0.5) (sqrt) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('power(0.5)', power(0.5));
  });
  it('power(10) (extreme) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('power(10)', power(10));
  });

  // --- cubicBezier factory ---
  it('cubicBezier(0.25,0.1,0.25,1) (CSS ease) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('cubicBezier(0.25,0.1,0.25,1)', cubicBezier(0.25, 0.1, 0.25, 1));
  });
  it('cubicBezier(0.42,0,1,1) (CSS ease-in) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('cubicBezier(0.42,0,1,1)', cubicBezier(0.42, 0, 1, 1));
  });
  it('cubicBezier(0,0,0.58,1) (CSS ease-out) — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('cubicBezier(0,0,0.58,1)', cubicBezier(0, 0, 0.58, 1));
  });
  it('cubicBezier(0,1.5,1,-0.5) (overshooting) — NE1 finite over all IEEE-754 inputs', () => {
    // y control points outside [0,1] → curve overshoots; output must still be finite
    assertFiniteOverDomain('cubicBezier(0,1.5,1,-0.5)', cubicBezier(0, 1.5, 1, -0.5));
  });

  // --- steps factory ---
  it('steps(1,"end") — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('steps(1,"end")', steps(1, 'end'));
  });
  it('steps(4,"end") — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('steps(4,"end")', steps(4, 'end'));
  });
  it('steps(4,"start") — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('steps(4,"start")', steps(4, 'start'));
  });
  it('steps(10,"end") — NE1 finite over all IEEE-754 inputs', () => {
    assertFiniteOverDomain('steps(10,"end")', steps(10, 'end'));
  });
});
