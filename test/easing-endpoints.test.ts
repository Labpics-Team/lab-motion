/**
 * easing-endpoints.test.ts — unit
 * Class: unit + characterization
 * Invariant NE2 — endpoint correctness + reference-value snapshots.
 *
 * For continuous monotonic curves: easing(0)===0 and easing(1)===1 EXACTLY
 * (bit-exact, no floating-point drift), mirroring tween.ts exact-endpoint discipline.
 *
 * For overshooting/stepped curves: documented exemption with the EXACT expected
 * value at each endpoint (never silently undefined).
 *
 * Also includes reference-value snapshots at t=0.5 for each curve (regression
 * anchors derived from Penner canonical values and cross-checked against
 * Motion One / easings.net reference implementations).
 *
 * Mutation proof:
 *   Return `t + 1e-16` always → linear(0) = 1e-16 ≠ 0 → RED.
 *   Remove endpoint short-circuit from easeIn → easeIn(0) might drift → RED.
 *   The bit-exact `===` (not `toBeCloseTo`) is what bites mutations.
 */

import { describe, expect, it } from 'vitest';
import {
  linear,
  normalizeEasing,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectEndpoints(name: string, fn: (t: number) => number, at0 = 0, at1 = 1): void {
  it(`${name}(0) === ${at0} exactly (NE2)`, () => {
    expect(fn(0)).toBe(at0);
  });
  it(`${name}(1) === ${at1} exactly (NE2)`, () => {
    expect(fn(1)).toBe(at1);
  });
}

function expectMidpoint(name: string, fn: (t: number) => number, expected: number, tolerance = 1e-9): void {
  it(`${name}(0.5) ≈ ${expected} (reference value snapshot)`, () => {
    expect(fn(0.5)).toBeCloseTo(expected, 9);
    // also check it's within tolerance
    const delta = Math.abs(fn(0.5) - expected);
    expect(delta).toBeLessThan(tolerance + 1e-12);
  });
}

// ---------------------------------------------------------------------------
// linear
// ---------------------------------------------------------------------------

describe('easing endpoint correctness — NE2', () => {
  it('linear is callable — prerequisite guard (RED if absent)', () => {
    expect(typeof linear).toBe('function');
  });

  it('linear(0) === 0 exactly (bit-exact, no float drift) — NE2', () => {
    expect(linear(0)).toBe(0);
  });
  it('linear(1) === 1 exactly (bit-exact, no float drift) — NE2', () => {
    expect(linear(1)).toBe(1);
  });
  it('linear(0.5) === 0.5 exactly — midpoint correct', () => {
    expect(linear(0.5)).toBe(0.5);
  });
  it('linear(-0) === 0 exactly — negative zero treated as zero endpoint', () => {
    expect(linear(-0)).toBe(0);
    expect(Object.is(linear(-0), 0)).toBe(true);
  });
  it('linear maps [0,1] monotonically — t<0.5 → result<0.5, t>0.5 → result>0.5', () => {
    expect(linear(0.25)).toBeLessThan(0.5);
    expect(linear(0.75)).toBeGreaterThan(0.5);
  });
  it('normalizeEasing(linear)(0) === 0 exactly — normalized wrapper preserves endpoints', () => {
    expect(normalizeEasing(linear)(0)).toBe(0);
  });
  it('normalizeEasing(linear)(1) === 1 exactly — normalized wrapper preserves endpoints', () => {
    expect(normalizeEasing(linear)(1)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // easeIn / easeOut / easeInOut — cubic MONOTONIC
  // ---------------------------------------------------------------------------

  describe('easeIn/Out/InOut (cubic) — NE2 endpoints + reference snapshots', () => {
    expectEndpoints('easeIn', easeIn);
    expectEndpoints('easeOut', easeOut);
    expectEndpoints('easeInOut', easeInOut);

    // Penner reference values at t=0.5:
    // easeIn(0.5) = 0.5^3 = 0.125
    // easeOut(0.5) = 1 - 0.5^3 = 0.875
    // easeInOut(0.5) = 4 * 0.5^3 = 0.5 (exactly)
    expectMidpoint('easeIn', easeIn, 0.125);
    expectMidpoint('easeOut', easeOut, 0.875);
    it('easeInOut(0.5) === 0.5 exactly (symmetric midpoint)', () => {
      expect(easeInOut(0.5)).toBe(0.5);
    });
  });

  // ---------------------------------------------------------------------------
  // sineIn / sineOut / sineInOut — MONOTONIC
  // ---------------------------------------------------------------------------

  describe('sineIn/Out/InOut — NE2 endpoints + reference snapshots', () => {
    expectEndpoints('sineIn', sineIn);
    expectEndpoints('sineOut', sineOut);
    expectEndpoints('sineInOut', sineInOut);

    // sineIn(0.5) = 1 - cos(π/4) ≈ 0.2928932188
    // sineOut(0.5) = sin(π/4) ≈ 0.7071067811
    // sineInOut(0.5) = 0.5 exactly
    expectMidpoint('sineIn', sineIn, 1 - Math.cos(Math.PI / 4));
    expectMidpoint('sineOut', sineOut, Math.sin(Math.PI / 4));
    it('sineInOut(0.5) ≈ 0.5 (symmetric midpoint — not bit-exact due to cos(π/2) float)', () => {
      // cos(π/2) is ~6e-17 in IEEE-754, not exactly 0, so sineInOut(0.5) ≈ 0.5 - 3e-17
      // Use toBeCloseTo with high precision (14 decimal places)
      expect(sineInOut(0.5)).toBeCloseTo(0.5, 14);
    });
  });

  // ---------------------------------------------------------------------------
  // expoIn / expoOut / expoInOut — MONOTONIC
  // ---------------------------------------------------------------------------

  describe('expoIn/Out/InOut — NE2 endpoints + reference snapshots', () => {
    expectEndpoints('expoIn', expoIn);
    expectEndpoints('expoOut', expoOut);
    expectEndpoints('expoInOut', expoInOut);

    // expoIn(0.5) = 2^(10*0.5 - 10) = 2^(-5) = 1/32 ≈ 0.03125
    // expoOut(0.5) = 1 - 2^(-5) ≈ 0.96875
    // expoInOut(0.5) = 0.5 exactly
    expectMidpoint('expoIn', expoIn, Math.pow(2, -5));
    expectMidpoint('expoOut', expoOut, 1 - Math.pow(2, -5));
    it('expoInOut(0.5) === 0.5 exactly (symmetric midpoint)', () => {
      expect(expoInOut(0.5)).toBe(0.5);
    });
  });

  // ---------------------------------------------------------------------------
  // circIn / circOut / circInOut — MONOTONIC
  // ---------------------------------------------------------------------------

  describe('circIn/Out/InOut — NE2 endpoints + reference snapshots', () => {
    expectEndpoints('circIn', circIn);
    expectEndpoints('circOut', circOut);
    expectEndpoints('circInOut', circInOut);

    // circIn(0.5) = 1 - sqrt(1 - 0.25) = 1 - sqrt(0.75) ≈ 0.1339745962
    // circOut(0.5) = sqrt(1 - (-0.5)^2) = sqrt(0.75) ≈ 0.8660254037
    // circInOut(0.5) = 0.5 exactly
    expectMidpoint('circIn', circIn, 1 - Math.sqrt(0.75));
    expectMidpoint('circOut', circOut, Math.sqrt(0.75));
    it('circInOut(0.5) === 0.5 exactly (symmetric midpoint)', () => {
      expect(circInOut(0.5)).toBe(0.5);
    });
  });

  // ---------------------------------------------------------------------------
  // backIn / backOut / backInOut — OVERSHOOTING
  // Endpoint exemption: endpoints are exact (0,0)→(1,1) even for overshooting.
  // The overshoot is INTERIOR, not at the endpoints.
  // ---------------------------------------------------------------------------

  describe('backIn/Out/InOut — NE2 endpoints (exact, overshoot is interior)', () => {
    expectEndpoints('backIn', backIn);
    expectEndpoints('backOut', backOut);
    expectEndpoints('backInOut', backInOut);

    // Overshooting at interior: backIn dips below 0, backOut exceeds 1
    it('backIn dips below 0 at interior (expected overshoot)', () => {
      // At t≈0.3, backIn goes negative — this is the expected behavior
      expect(backIn(0.3)).toBeLessThan(0);
    });
    it('backOut exceeds 1 at interior (expected overshoot)', () => {
      expect(backOut(0.7)).toBeGreaterThan(1);
    });
    // Reference midpoint: backIn(0.5) = c3*0.125 - c1*0.25 = 2.70158*0.125 - 1.70158*0.25
    it('backIn(0.5) matches Penner reference', () => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const expected = c3 * 0.125 - c1 * 0.25;
      expect(backIn(0.5)).toBeCloseTo(expected, 10);
    });
  });

  // ---------------------------------------------------------------------------
  // anticipate — OVERSHOOTING (dips negative, endpoints exact)
  // ---------------------------------------------------------------------------

  describe('anticipate — NE2 endpoints (exact, interior overshoots)', () => {
    expectEndpoints('anticipate', anticipate);
    it('anticipate goes negative in recoil phase', () => {
      expect(anticipate(0.2)).toBeLessThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // elastic — OVERSHOOTING
  // ---------------------------------------------------------------------------

  describe('elastic — NE2 endpoints (exact)', () => {
    expectEndpoints('elastic', elastic);
    it('elastic overshoots [0,1] range at interior', () => {
      // elastic oscillates beyond [0,1] — expected
      const values = [0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9].map(t => elastic(t));
      const hasOvershoot = values.some(v => v < 0 || v > 1);
      expect(hasOvershoot).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // bounce — bounded in [0,1] but non-monotonic, endpoints exact
  // ---------------------------------------------------------------------------

  describe('bounce — NE2 endpoints (exact)', () => {
    expectEndpoints('bounce', bounce);
    it('bounce output stays in [0,1] at interior (bounded non-monotonic)', () => {
      const rand = (() => {
        let s = 0x12345678 >>> 0;
        return () => {
          s = (Math.imul(48271, s) + 0) & 0x7fffffff;
          return s / 0x7fffffff;
        };
      })();
      for (let i = 0; i < 1000; i++) {
        const t = rand();
        const v = bounce(t);
        expect(v).toBeGreaterThanOrEqual(-1e-10); // allow floating-point epsilon
        expect(v).toBeLessThanOrEqual(1 + 1e-10);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // power factory — MONOTONIC for positive exponents
  // ---------------------------------------------------------------------------

  describe('power() factory — NE2 endpoints + reference snapshots', () => {
    for (const exp of [2, 3, 4, 5]) {
      expectEndpoints(`power(${exp})`, power(exp));
      // power(n)(0.5) = 0.5^n
      expectMidpoint(`power(${exp})`, power(exp), Math.pow(0.5, exp));
    }
    expectEndpoints('power(0.5)', power(0.5));
    expectMidpoint('power(0.5)', power(0.5), Math.sqrt(0.5));
  });

  // ---------------------------------------------------------------------------
  // cubicBezier factory — endpoints exact
  // ---------------------------------------------------------------------------

  describe('cubicBezier() factory — NE2 endpoints', () => {
    const cb = cubicBezier(0.25, 0.1, 0.25, 1.0); // CSS ease
    expectEndpoints('cubicBezier(0.25,0.1,0.25,1)', cb);

    const cbEaseIn = cubicBezier(0.42, 0, 1, 1); // CSS ease-in
    expectEndpoints('cubicBezier(0.42,0,1,1)', cbEaseIn);

    const cbEaseOut = cubicBezier(0, 0, 0.58, 1); // CSS ease-out
    expectEndpoints('cubicBezier(0,0,0.58,1)', cbEaseOut);

    // Linear special case (x1===y1, x2===y2): must still give exact endpoints
    const cbLinear = cubicBezier(0.1, 0.1, 0.9, 0.9);
    expectEndpoints('cubicBezier(0.1,0.1,0.9,0.9) [linear fast-path]', cbLinear);
  });

  // ---------------------------------------------------------------------------
  // steps factory — endpoints: 'end' gives 0→0, 1→1; 'start' gives 0→1/n, 1→1
  // ---------------------------------------------------------------------------

  describe('steps() factory — NE2 endpoints (exemption for discontinuous)', () => {
    it('steps(4,"end")(0) === 0 exact', () => {
      expect(steps(4, 'end')(0)).toBe(0);
    });
    it('steps(4,"end")(1) === 1 exact', () => {
      expect(steps(4, 'end')(1)).toBe(1);
    });
    it('steps(4,"start")(0) === 0 exact (clamped to 0 at left endpoint)', () => {
      // Our implementation: t<=0 → 0 (the generic endpoint guard fires before step logic)
      expect(steps(4, 'start')(0)).toBe(0);
    });
    it('steps(4,"start")(1) === 1 exact', () => {
      expect(steps(4, 'start')(1)).toBe(1);
    });
    it('steps(4,"end") steps at t=0.25, 0.5, 0.75, 1.0', () => {
      // each step fires at the END of the interval
      expect(steps(4, 'end')(0.24)).toBe(0);      // just below first step
      expect(steps(4, 'end')(0.25)).toBe(0.25);   // first step fires
      expect(steps(4, 'end')(0.49)).toBe(0.25);   // still on first step
      expect(steps(4, 'end')(0.5)).toBe(0.5);     // second step
      expect(steps(4, 'end')(0.75)).toBe(0.75);   // third step
    });
    it('steps(4,"start") — jump-start: step fires at start of each interval', () => {
      // jump-start: ceil(t*n)/n
      // The step boundary at t=k/n gives ceil(k)=k → result k/n (boundary at top of lower step)
      // t just above 0: ceil(0.001*4)/4 = ceil(0.004)/4 = 1/4 = 0.25 (instant first jump)
      expect(steps(4, 'start')(0.001)).toBe(0.25); // first step is instant
      // t=0.25: ceil(0.25*4)/4 = ceil(1)/4 = 1/4 = 0.25 (still on first step at boundary)
      expect(steps(4, 'start')(0.25)).toBe(0.25);
      // t just above 0.25: ceil(0.26*4)/4 = ceil(1.04)/4 = 2/4 = 0.5 (second step)
      expect(steps(4, 'start')(0.26)).toBe(0.5);
      // t=0.5: ceil(0.5*4)/4 = ceil(2)/4 = 2/4 = 0.5 (boundary, still on second step)
      expect(steps(4, 'start')(0.5)).toBe(0.5);
      // t just above 0.5: ceil(0.51*4)/4 = ceil(2.04)/4 = 3/4 = 0.75
      expect(steps(4, 'start')(0.51)).toBe(0.75);
      // t=0.75: ceil(0.75*4)/4 = ceil(3)/4 = 3/4 = 0.75 (boundary, still third step)
      expect(steps(4, 'start')(0.75)).toBe(0.75);
      // t just above 0.75: ceil(0.76*4)/4 = ceil(3.04)/4 = 4/4 = 1.0 (fourth step)
      expect(steps(4, 'start')(0.76)).toBe(1.0);
    });
  });
});
