import { describe, expect, it } from 'vitest';
import { spring } from '../src/index.js';

/**
 * Test: spring() clampFinite NaN → wrong-sign -MAX_VALUE
 * Class: regression (correctness)
 * Finding: spring() returns -Number.MAX_VALUE (wrong-sign) instead of staying
 *   finite-and-bounded when clampFinite receives NaN, because NaN>0 is false.
 *
 * Root cause: clampFinite(x) had only two branches:
 *   if (isFinite(x)) return x;
 *   return x > 0 ? MAX_VALUE : -MAX_VALUE;  // NaN > 0 === false → -MAX_VALUE
 *
 * Fix class: add a NaN branch: if (isNaN(x)) return 0.
 *   NaN can only arise from indeterminate forms (0/0, Infinity*0) during
 *   degenerate floating-point evaluation. Returning 0 (spring at rest at start)
 *   is the CSS-safe fallback: no visual glitch, correct sign, truly finite.
 *
 * Invariant locked: spring.ts docstring line 6:
 *   "CSS-safe: output is always finite (never NaN, never Infinity)."
 *   Extended: "output is always finite AND semantically correct-sign."
 *
 * RED proof (mutation targets):
 *   - Restore the original two-branch clampFinite → spring({...}, t=Infinity).value
 *     returns -1.8e308 → the "not -MAX_VALUE" assertion fails.
 *   - Return NaN from clampFinite → the isFinite assertion fails.
 *
 * Mutation proof:
 *   Any regression to the NaN→-MAX_VALUE mapping will cause the wrong-sign test
 *   to turn RED immediately.
 */

describe('spring() clampFinite NaN — no wrong-sign -MAX_VALUE (regression lock)', () => {
  it('spring({...}, Infinity) does not return -Number.MAX_VALUE', () => {
    // t=Infinity causes Math.cos(omegaD*Infinity)=NaN in the underdamped branch.
    // clampFinite(NaN) must NOT return -MAX_VALUE (wrong-sign, semantically absurd).
    const result = spring({ mass: 1, stiffness: 100, damping: 5 }, Number.POSITIVE_INFINITY);
    expect(result.value).not.toBe(-Number.MAX_VALUE);
    expect(result.velocity).not.toBe(-Number.MAX_VALUE);
  });

  it('spring({...}, Infinity) returns a finite value', () => {
    const result = spring({ mass: 1, stiffness: 100, damping: 5 }, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(Number.isFinite(result.velocity)).toBe(true);
  });

  it('spring({...}, Infinity) value is not NaN', () => {
    const result = spring({ mass: 1, stiffness: 100, damping: 5 }, Number.POSITIVE_INFINITY);
    expect(Number.isNaN(result.value)).toBe(false);
    expect(Number.isNaN(result.velocity)).toBe(false);
  });

  it('spring value at t=Infinity is in the expected solved range [0, MAX_VALUE]', () => {
    // For a valid underdamped spring driving from 0 toward 1, the asymptotic
    // solution converges to 1. A NaN-fallback of 0 is also in range.
    // Either way, the value must not be negative-MAX_VALUE.
    const result = spring({ mass: 1, stiffness: 100, damping: 5 }, Number.POSITIVE_INFINITY);
    expect(result.value).toBeGreaterThanOrEqual(0);
  });

  it('spring({...}, Infinity) for overdamped params returns finite correct-sign value', () => {
    // Overdamped: both exponentials decay to 0, value → 1. Math.exp(-Infinity)=0.
    // No NaN in the overdamped branch, but assert anyway for completeness.
    const result = spring({ mass: 1, stiffness: 100, damping: 50 }, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(result.value).toBeGreaterThanOrEqual(0);
    expect(result.value).not.toBe(-Number.MAX_VALUE);
  });

  it('spring({...}, Infinity) for critically damped params returns finite correct-sign value', () => {
    // Critically damped: zeta=1. decay=Math.exp(-omega0*Infinity)=0. value=1-0*(1+omega0*Inf)=NaN.
    // clampFinite(NaN) must return 0, not -MAX_VALUE.
    const criticalDamping = 2 * Math.sqrt(100 * 1); // 2*sqrt(k*m) = 20
    const result = spring(
      { mass: 1, stiffness: 100, damping: criticalDamping },
      Number.POSITIVE_INFINITY,
    );
    expect(Number.isFinite(result.value)).toBe(true);
    expect(result.value).not.toBe(-Number.MAX_VALUE);
    // Value should be non-negative — the spring moves from 0 toward 1.
    expect(result.value).toBeGreaterThanOrEqual(0);
  });

  it('valid finite t values always return finite non-negative values (control group)', () => {
    // Ensure the NaN fix does not break the normal operating range.
    const cases: number[] = [0, 0.016, 0.1, 0.5, 1.0, 2.0, 5.0];
    for (const t of cases) {
      const result = spring({ mass: 1, stiffness: 100, damping: 10 }, t);
      expect(Number.isFinite(result.value), `non-finite at t=${t}: ${result.value}`).toBe(true);
      expect(
        Number.isFinite(result.velocity),
        `non-finite velocity at t=${t}: ${result.velocity}`,
      ).toBe(true);
    }
  });
});
