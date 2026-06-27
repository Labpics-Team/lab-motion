/**
 * easing-canonical-differential.test.ts — differential (Class C)
 *
 * CLASS this closes (the gap the 280-suite missed):
 *   The existing suite checks endpoints (NE2), determinism (NE4), finiteness
 *   (NE1), and *direction-only* shape (monotonic-where-expected). NONE of those
 *   pin the INTERIOR VALUE of an overshoot/special curve against an EXTERNAL
 *   canonical reference. A curve can be finite, deterministic, have exact
 *   endpoints, and still be the WRONG curve in the middle — exactly the
 *   anticipate launch-phase bug (src/easing/index.ts:424). Direction-only
 *   checks are blind to it because the buggy launch phase is still increasing.
 *
 * METHOD (differential against canonical, Class C):
 *   For each overshoot/special curve, evaluate at several INTERIOR t and assert
 *   the value equals an INDEPENDENT closed-form canonical reference (Penner 2002
 *   / Framer Motion / Motion One / W3C CSS) within a tight tolerance. The
 *   reference is re-implemented here from the published formula — it does NOT
 *   import the constants from src, so a wrong src formula cannot "agree with
 *   itself".
 *   Plus each curve's documented SHAPE INVARIANT (where overshoot is allowed).
 *
 * THE BUG (anticipate, launch phase t >= 0.5):
 *   Canonical (Framer Motion / Motion One):
 *     C1=1.70158, C3=C1+1
 *     backIn(t)  = C3*t^3 - C1*t^2
 *     easeOut(t) = 1 - (1-t)^3
 *     anticipate(t) = t < 0.5 ? 0.5*backIn(2t) : 0.5*easeOut(2t-1) + 0.5
 *   src uses a scaled backOut TAIL for t>=0.5 instead of easeOut, so it
 *   overshoots to ~1.05 @ t=0.79 (a SECOND overshoot a true easeOut never
 *   produces) and deviates ~0.126 @ t=0.667. The file's OWN docstring
 *   (lines ~399/406) states the t>=0.5 half is "scaled easeOut" — the code
 *   contradicts its own contract. These assertions BITE that contradiction.
 *
 * RED-PROOF: on the CURRENT (unfixed) anticipate the interior-value checks at
 * t=0.667 and t=0.79 and the launch-phase no-overshoot invariant MUST fail.
 * A green-from-birth run here would mean the test does not bite (theater).
 */

import { describe, expect, it } from 'vitest';
import {
  backIn,
  backOut,
  backInOut,
  anticipate,
  elastic,
  bounce,
  steps,
  cubicBezier,
} from '../src/easing/index.js';

// --------------------------------------------------------------------------
// Canonical references — re-implemented from the PUBLISHED formulas.
// Deliberately NOT importing src constants: an independent oracle.
// --------------------------------------------------------------------------

const C1 = 1.70158; // Penner back overshoot constant
const C3 = C1 + 1;
const C2 = C1 * 1.525; // Penner easeInOutBack constant

const INTERIOR = [0.25, 0.5, 0.667, 0.79] as const;

// Penner easeInBack / easeOutBack
const refBackIn = (t: number) => C3 * t * t * t - C1 * t * t;
const refBackOut = (t: number) => {
  const u = t - 1;
  return 1 + C3 * u * u * u + C1 * u * u;
};
const refBackInOut = (t: number) => {
  if (t < 0.5) {
    return (Math.pow(2 * t, 2) * ((C2 + 1) * 2 * t - C2)) / 2;
  }
  return (Math.pow(2 * t - 2, 2) * ((C2 + 1) * (2 * t - 2) + C2) + 2) / 2;
};

// Framer Motion / Motion One anticipate: scaled backIn then scaled easeOut.
const refEaseOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const refAnticipate = (t: number) =>
  t < 0.5 ? 0.5 * refBackIn(2 * t) : 0.5 * refEaseOutCubic(2 * t - 1) + 0.5;

// Penner easeInOutElastic (matches src formula / easings.net / Motion One).
const ELASTIC_C5 = (2 * Math.PI) / 4.5;
const refElastic = (t: number) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  if (t < 0.5) {
    return -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2;
  }
  return (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2 + 1;
};

// Penner easeOutBounce core, then easeInOutBounce composition.
const N1 = 7.5625;
const D1 = 2.75;
const refBounceOut = (t: number) => {
  if (t < 1 / D1) return N1 * t * t;
  if (t < 2 / D1) {
    const u = t - 1.5 / D1;
    return N1 * u * u + 0.75;
  }
  if (t < 2.5 / D1) {
    const u = t - 2.25 / D1;
    return N1 * u * u + 0.9375;
  }
  const u = t - 2.625 / D1;
  return N1 * u * u + 0.984375;
};
const refBounce = (t: number) =>
  t < 0.5 ? (1 - refBounceOut(1 - 2 * t)) / 2 : (1 + refBounceOut(2 * t - 1)) / 2;

// Tight tolerance for closed-form curves.
const TOL = 1e-6;

describe('easing canonical differential (Class C) — interior values vs published references', () => {
  describe('anticipate — Framer Motion / Motion One (THE bug target)', () => {
    // Recoil phase (t < 0.5) is correct in src; pin it so a fix cannot regress it.
    it('recoil phase t<0.5 matches scaled backIn (canonical)', () => {
      for (const t of [0.1, 0.2, 0.25, 0.4, 0.49]) {
        expect(anticipate(t)).toBeCloseTo(refAnticipate(t), 9);
      }
    });

    // Launch phase (t >= 0.5) MUST be scaled easeOut per the docstring.
    // CURRENT src uses a scaled backOut tail → these BITE.
    it('launch phase value @ t=0.667 matches canonical scaled easeOut', () => {
      // canonical ≈ 0.852296 ; current buggy ≈ 0.978338 (deviation ~0.126)
      expect(anticipate(0.667)).toBeCloseTo(refAnticipate(0.667), 6);
    });

    it('launch phase value @ t=0.79 matches canonical scaled easeOut', () => {
      // canonical ≈ 0.962956 ; current buggy ≈ 1.050002 (deviation ~0.087)
      expect(anticipate(0.79)).toBeCloseTo(refAnticipate(0.79), 6);
    });

    it('all interior t match canonical anticipate within 1e-6', () => {
      for (const t of INTERIOR) {
        expect(anticipate(t)).toBeCloseTo(refAnticipate(t), 6);
      }
    });

    // SHAPE INVARIANT: a true easeOut launch NEVER exceeds 1. The only
    // overshoot anticipate is allowed is the NEGATIVE recoil dip at the start.
    // CURRENT src overshoots to ~1.05 in the launch phase → BITES.
    it('launch phase never exceeds 1 (no second overshoot)', () => {
      let peak = -Infinity;
      let at = 0;
      for (let i = 500; i <= 1000; i++) {
        const t = i / 1000;
        const v = anticipate(t);
        if (v > peak) {
          peak = v;
          at = t;
        }
      }
      expect(peak, `launch-phase peak ${peak} @ t=${at} exceeds 1`).toBeLessThanOrEqual(
        1 + 1e-9,
      );
    });

    // The documented recoil overshoot IS negative and occurs ONLY at the start.
    it('recoil dips negative at start (declared overshoot)', () => {
      let min = Infinity;
      for (let i = 1; i < 500; i++) {
        const v = anticipate(i / 1000);
        if (v < min) min = v;
      }
      expect(min).toBeLessThan(0);
    });
  });

  describe('backIn / backOut / backInOut — Penner (2002)', () => {
    it('backIn matches Penner easeInBack at interior t', () => {
      for (const t of INTERIOR) {
        expect(backIn(t)).toBeCloseTo(refBackIn(t), 6);
      }
    });

    it('backOut matches Penner easeOutBack at interior t', () => {
      for (const t of INTERIOR) {
        expect(backOut(t)).toBeCloseTo(refBackOut(t), 6);
      }
    });

    it('backInOut matches Penner easeInOutBack at interior t', () => {
      for (const t of INTERIOR) {
        expect(backInOut(t)).toBeCloseTo(refBackInOut(t), 6);
      }
    });

    // Shape invariant: backIn overshoots only NEGATIVE near the start.
    it('backIn dips below 0 near start, never exceeds 1 before the end', () => {
      let belowZero = false;
      for (let i = 1; i < 1000; i++) {
        const t = i / 1000;
        const v = backIn(t);
        if (v < 0) belowZero = true;
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(belowZero).toBe(true);
    });

    // Shape invariant: backOut overshoots only ABOVE 1 near the end.
    it('backOut exceeds 1 near end, never below 0 after the start', () => {
      let aboveOne = false;
      for (let i = 1; i < 1000; i++) {
        const t = i / 1000;
        const v = backOut(t);
        if (v > 1) aboveOne = true;
        expect(v).toBeGreaterThanOrEqual(-1e-9);
      }
      expect(aboveOne).toBe(true);
    });
  });

  describe('elastic — Penner easeInOutElastic', () => {
    it('matches canonical elastic at interior t within 1e-6', () => {
      for (const t of INTERIOR) {
        expect(elastic(t)).toBeCloseTo(refElastic(t), 6);
      }
    });
  });

  describe('bounce — Penner easeInOutBounce', () => {
    it('matches canonical bounce at interior t within 1e-6', () => {
      for (const t of INTERIOR) {
        expect(bounce(t)).toBeCloseTo(refBounce(t), 6);
      }
    });

    // Shape invariant: bounce is bounded to [0,1] (no overshoot at all).
    it('stays within [0,1] across a dense sweep', () => {
      for (let i = 0; i <= 1000; i++) {
        const v = bounce(i / 1000);
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    });
  });

  describe('steps — W3C CSS step-timing-function', () => {
    it('steps(4,"end") = floor(t*4)/4 at interior t', () => {
      const f = steps(4, 'end');
      for (const t of INTERIOR) {
        expect(f(t)).toBeCloseTo(Math.floor(t * 4) / 4, 9);
      }
    });

    it('steps(4,"start") = ceil(t*4)/4 at interior t', () => {
      const f = steps(4, 'start');
      for (const t of INTERIOR) {
        expect(f(t)).toBeCloseTo(Math.min(1, Math.ceil(t * 4) / 4), 9);
      }
    });
  });

  describe('cubicBezier — W3C CSS / Chrome bezier solver', () => {
    // ease = cubic-bezier(0.25, 0.1, 0.25, 1.0). Independent reference: solve
    // B_x(u)=t by bisection, return B_y(u). Cross-checks the src solver.
    const x1 = 0.25;
    const y1 = 0.1;
    const x2 = 0.25;
    const y2 = 1.0;
    const f = cubicBezier(x1, y1, x2, y2);

    const bezierAxis = (u: number, a: number, b: number) => {
      const mu = 1 - u;
      return 3 * mu * mu * u * a + 3 * mu * u * u * b + u * u * u;
    };
    const refBezier = (t: number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        const x = bezierAxis(mid, x1, x2);
        if (x < t) lo = mid;
        else hi = mid;
      }
      return bezierAxis((lo + hi) / 2, y1, y2);
    };

    it('matches independent bezier solver at interior t within 1e-5', () => {
      for (const t of INTERIOR) {
        expect(f(t)).toBeCloseTo(refBezier(t), 5);
      }
    });
  });
});
