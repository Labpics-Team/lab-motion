/**
 * easing-monotonic-shape.test.ts — property
 * Class: property (NE3 — monotonic-where-expected)
 *
 * For each easing tagged MONOTONIC: assert non-decreasing across a dense [0,1]
 * sample (1001 points including both endpoints).
 *
 * For OVERSHOOTING families (back/anticipate/elastic/bounce): assert only
 * that they are bounded-finite and that endpoints are correct — NOT monotonic.
 *
 * Shape tags (mirroring src/easing/index.ts doc comments):
 *   MONOTONIC   — non-decreasing; linear, easeX/sineX/expoX/circX families, power(p>0)
 *   OVERSHOOTING — may exceed [0,1]; back*, anticipate, elastic
 *   BOUNDED     — stays in [0,1] but non-monotonic; bounce
 *   STEPPED     — discontinuous; steps()
 *
 * Mutation proof:
 *   Replace easeIn with (t)=>1-t (decreasing):
 *   → monotonic assertion [t_i, t_{i+1}] fails for any increasing pair → RED.
 *   Tag bounce as MONOTONIC → dense-sample check catches it instantly → RED.
 *   Remove endpoint from backIn → endpoint assertion fails → RED.
 */

import { describe, expect, it } from 'vitest';
import {
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
} from '../src/easing/index.js';

const DENSE_N = 1001;
const DENSE_TOLERANCE = 1e-10; // allow tiny float rounding (e.g., 1e-16 drift)

/**
 * Assert non-decreasing across a dense sample on [0,1].
 * Allows tolerance for floating-point rounding (not for logical reversals).
 */
function assertMonotonic(name: string, fn: (t: number) => number): void {
  const violations: string[] = [];
  let prev = fn(0);
  for (let i = 1; i <= DENSE_N; i++) {
    const t = i / DENSE_N;
    const curr = fn(t);
    if (curr < prev - DENSE_TOLERANCE) {
      violations.push(`${name}: decreased at t=${t.toFixed(6)}: ${prev} → ${curr} (delta=${curr - prev})`);
      if (violations.length >= 5) break; // cap output
    }
    prev = curr;
  }
  expect(
    violations,
    `NE3 monotonicity violation:\n${violations.join('\n')}`,
  ).toHaveLength(0);
}

/**
 * Assert that the easing is bounded within [lo, hi] across a dense sample.
 * Used for BOUNDED curves (bounce) to verify they stay in [0,1].
 */
function assertBounded(name: string, fn: (t: number) => number, lo: number, hi: number): void {
  const violations: string[] = [];
  for (let i = 0; i <= DENSE_N; i++) {
    const t = i / DENSE_N;
    const v = fn(t);
    if (v < lo - 1e-10 || v > hi + 1e-10) {
      violations.push(`${name}(${t.toFixed(6)}) = ${v} outside [${lo},${hi}]`);
      if (violations.length >= 5) break;
    }
  }
  expect(
    violations,
    `NE3 bounded violation:\n${violations.join('\n')}`,
  ).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// MONOTONIC family
// ---------------------------------------------------------------------------

describe('easing monotonic-where-expected — NE3', () => {
  describe('MONOTONIC: linear', () => {
    it('linear is non-decreasing on dense [0,1] sample', () => {
      assertMonotonic('linear', linear);
    });
  });

  describe('MONOTONIC: easeIn/Out/InOut (cubic)', () => {
    it('easeIn is non-decreasing on dense [0,1]', () => { assertMonotonic('easeIn', easeIn); });
    it('easeOut is non-decreasing on dense [0,1]', () => { assertMonotonic('easeOut', easeOut); });
    it('easeInOut is non-decreasing on dense [0,1]', () => { assertMonotonic('easeInOut', easeInOut); });
  });

  describe('MONOTONIC: sineIn/Out/InOut', () => {
    it('sineIn is non-decreasing on dense [0,1]', () => { assertMonotonic('sineIn', sineIn); });
    it('sineOut is non-decreasing on dense [0,1]', () => { assertMonotonic('sineOut', sineOut); });
    it('sineInOut is non-decreasing on dense [0,1]', () => { assertMonotonic('sineInOut', sineInOut); });
  });

  describe('MONOTONIC: expoIn/Out/InOut', () => {
    it('expoIn is non-decreasing on dense [0,1]', () => { assertMonotonic('expoIn', expoIn); });
    it('expoOut is non-decreasing on dense [0,1]', () => { assertMonotonic('expoOut', expoOut); });
    it('expoInOut is non-decreasing on dense [0,1]', () => { assertMonotonic('expoInOut', expoInOut); });
  });

  describe('MONOTONIC: circIn/Out/InOut', () => {
    it('circIn is non-decreasing on dense [0,1]', () => { assertMonotonic('circIn', circIn); });
    it('circOut is non-decreasing on dense [0,1]', () => { assertMonotonic('circOut', circOut); });
    it('circInOut is non-decreasing on dense [0,1]', () => { assertMonotonic('circInOut', circInOut); });
  });

  describe('MONOTONIC: power() family (positive exponents)', () => {
    for (const exp of [0.5, 1, 2, 3, 4, 5, 10]) {
      it(`power(${exp}) is non-decreasing on dense [0,1]`, () => {
        assertMonotonic(`power(${exp})`, power(exp));
      });
    }
  });

  describe('MONOTONIC: cubicBezier (monotone control points)', () => {
    // CSS ease — x1,x2 ∈ [0,1]; y control may differ but curve is functional
    it('cubicBezier(0.25,0.1,0.25,1) [CSS ease] is non-decreasing on [0,1]', () => {
      assertMonotonic('cubicBezier(0.25,0.1,0.25,1)', cubicBezier(0.25, 0.1, 0.25, 1));
    });
    it('cubicBezier(0.42,0,1,1) [CSS ease-in] is non-decreasing on [0,1]', () => {
      assertMonotonic('cubicBezier(0.42,0,1,1)', cubicBezier(0.42, 0, 1, 1));
    });
    it('cubicBezier(0,0,0.58,1) [CSS ease-out] is non-decreasing on [0,1]', () => {
      assertMonotonic('cubicBezier(0,0,0.58,1)', cubicBezier(0, 0, 0.58, 1));
    });
    it('cubicBezier(0.4,0,0.6,1) [ease-in-out variant] is non-decreasing on [0,1]', () => {
      assertMonotonic('cubicBezier(0.4,0,0.6,1)', cubicBezier(0.4, 0, 0.6, 1));
    });
  });

  // ---------------------------------------------------------------------------
  // OVERSHOOTING family — NOT monotonic; assert endpoints + finite
  // ---------------------------------------------------------------------------

  describe('OVERSHOOTING: backIn/Out/InOut — not monotonic, endpoints exact, finite', () => {
    it('backIn(0)===0, backIn(1)===1 (exact), goes negative at interior', () => {
      expect(backIn(0)).toBe(0);
      expect(backIn(1)).toBe(1);
      // At t≈0.3 backIn is negative
      const hasNegative = [0.1, 0.2, 0.3].some(t => backIn(t) < 0);
      expect(hasNegative).toBe(true);
    });
    it('backOut(0)===0, backOut(1)===1 (exact), exceeds 1 at interior', () => {
      expect(backOut(0)).toBe(0);
      expect(backOut(1)).toBe(1);
      const hasOver = [0.7, 0.8, 0.9].some(t => backOut(t) > 1);
      expect(hasOver).toBe(true);
    });
    it('backInOut(0)===0, backInOut(1)===1 (exact)', () => {
      expect(backInOut(0)).toBe(0);
      expect(backInOut(1)).toBe(1);
    });
    it('backIn is finite across dense [0,1] (NE1)', () => {
      for (let i = 0; i <= DENSE_N; i++) {
        expect(Number.isFinite(backIn(i / DENSE_N))).toBe(true);
      }
    });
    it('backOut is finite across dense [0,1] (NE1)', () => {
      for (let i = 0; i <= DENSE_N; i++) {
        expect(Number.isFinite(backOut(i / DENSE_N))).toBe(true);
      }
    });
  });

  describe('OVERSHOOTING: anticipate — not monotonic, endpoints exact, finite', () => {
    it('anticipate(0)===0, anticipate(1)===1 (exact)', () => {
      expect(anticipate(0)).toBe(0);
      expect(anticipate(1)).toBe(1);
    });
    it('anticipate is finite across dense [0,1] (NE1)', () => {
      for (let i = 0; i <= DENSE_N; i++) {
        expect(Number.isFinite(anticipate(i / DENSE_N))).toBe(true);
      }
    });
    it('anticipate has recoil phase (goes negative before 0.5)', () => {
      const negatives = [0.1, 0.15, 0.2, 0.25].filter(t => anticipate(t) < 0);
      expect(negatives.length).toBeGreaterThan(0);
    });
  });

  describe('OVERSHOOTING: elastic — not monotonic, endpoints exact, finite', () => {
    it('elastic(0)===0, elastic(1)===1 (exact)', () => {
      expect(elastic(0)).toBe(0);
      expect(elastic(1)).toBe(1);
    });
    it('elastic is finite across dense [0,1] (NE1)', () => {
      for (let i = 0; i <= DENSE_N; i++) {
        expect(Number.isFinite(elastic(i / DENSE_N))).toBe(true);
      }
    });
    it('elastic oscillates (values outside [0,1] at interior)', () => {
      const outside = Array.from({ length: 101 }, (_, i) => i / 100)
        .filter(t => { const v = elastic(t); return v < -0.01 || v > 1.01; });
      expect(outside.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // BOUNDED: bounce — non-monotonic but always in [0,1]
  // ---------------------------------------------------------------------------

  describe('BOUNDED: bounce — non-monotonic, stays in [0,1], endpoints exact', () => {
    it('bounce(0)===0, bounce(1)===1 (exact)', () => {
      expect(bounce(0)).toBe(0);
      expect(bounce(1)).toBe(1);
    });
    it('bounce is bounded in [0,1] across dense sample (NE3 BOUNDED tag)', () => {
      assertBounded('bounce', bounce, 0, 1);
    });
    it('bounce is NOT monotonic (decreases between bounces)', () => {
      // After a bounce peak the value decreases momentarily
      let hasDecrease = false;
      let prev = bounce(0);
      for (let i = 1; i <= DENSE_N; i++) {
        const t = i / DENSE_N;
        const curr = bounce(t);
        if (curr < prev - 0.001) { hasDecrease = true; break; }
        prev = curr;
      }
      expect(hasDecrease).toBe(true);
    });
  });
});
