/**
 * easing-factory-validation.test.ts — unit (NE7 factory validation)
 * Class: unit (contract/boundary)
 * Invariant NE7 — factories reject invalid parameters via MotionParamError;
 * NEVER return NaN for bad params — ALWAYS throw before producing output.
 *
 * RED proof (TDD discipline):
 *   Before the guard exists in cubicBezier/steps/power:
 *   - cubicBezier(NaN,0,1,1) would NOT throw → test fails (expected throw, got value) → RED.
 *   - steps(0,'end') would NOT throw → test fails → RED.
 *   - power(NaN) would NOT throw → test fails → RED.
 *   The throw-assertion tests are RED before the MotionParamError guard is implemented.
 *
 * Mutation proof:
 *   Remove the !Number.isFinite(x1) check from cubicBezier:
 *   → cubicBezier(NaN,...) no longer throws → `toThrow(MotionParamError)` fails → RED.
 *   Change steps guard to `n < 0` instead of `n <= 0`:
 *   → steps(0,...) no longer throws → RED.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { cubicBezier, steps, power } from '../src/easing/index.js';

// ---------------------------------------------------------------------------
// cubicBezier — NE7: non-finite control points → MotionParamError
// ---------------------------------------------------------------------------

describe('cubicBezier() factory validation — NE7', () => {
  it('cubicBezier(NaN,0,1,1) throws MotionParamError (non-finite x1)', () => {
    expect(() => cubicBezier(Number.NaN, 0, 1, 1)).toThrow(MotionParamError);
  });
  it('cubicBezier(0,NaN,1,1) throws MotionParamError (non-finite y1)', () => {
    expect(() => cubicBezier(0, Number.NaN, 1, 1)).toThrow(MotionParamError);
  });
  it('cubicBezier(0,0,NaN,1) throws MotionParamError (non-finite x2)', () => {
    expect(() => cubicBezier(0, 0, Number.NaN, 1)).toThrow(MotionParamError);
  });
  it('cubicBezier(0,0,1,NaN) throws MotionParamError (non-finite y2)', () => {
    expect(() => cubicBezier(0, 0, 1, Number.NaN)).toThrow(MotionParamError);
  });
  it('cubicBezier(Infinity,0,1,1) throws MotionParamError (x1=+Infinity)', () => {
    expect(() => cubicBezier(Number.POSITIVE_INFINITY, 0, 1, 1)).toThrow(MotionParamError);
  });
  it('cubicBezier(0,-Infinity,1,1) throws MotionParamError (y1=-Infinity)', () => {
    expect(() => cubicBezier(0, Number.NEGATIVE_INFINITY, 1, 1)).toThrow(MotionParamError);
  });
  it('cubicBezier(0,0,Infinity,1) throws MotionParamError (x2=+Infinity)', () => {
    expect(() => cubicBezier(0, 0, Number.POSITIVE_INFINITY, 1)).toThrow(MotionParamError);
  });
  it('cubicBezier(0,0,1,Infinity) throws MotionParamError (y2=+Infinity)', () => {
    expect(() => cubicBezier(0, 0, 1, Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
  });
  it('cubicBezier(NaN,NaN,NaN,NaN) throws MotionParamError (all NaN)', () => {
    expect(() => cubicBezier(Number.NaN, Number.NaN, Number.NaN, Number.NaN)).toThrow(MotionParamError);
  });

  // Verify that the error message is informative (not empty or generic)
  it('cubicBezier(NaN,0,1,1) error message mentions control points', () => {
    try {
      cubicBezier(Number.NaN, 0, 1, 1);
      expect.fail('Expected MotionParamError to be thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MotionParamError);
      expect((e as MotionParamError).message).toMatch(/finite/i);
    }
  });

  // Valid: all finite — must NOT throw
  it('cubicBezier(0.25,0.1,0.25,1) with all-finite params does NOT throw', () => {
    expect(() => cubicBezier(0.25, 0.1, 0.25, 1)).not.toThrow();
  });
  it('cubicBezier with y outside [0,1] (overshooting) does NOT throw', () => {
    // y control points may be outside [0,1]; only non-finite is rejected
    expect(() => cubicBezier(0, 1.5, 1, -0.5)).not.toThrow();
  });
  it('cubicBezier return value is a function (callable)', () => {
    const fn = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(typeof fn).toBe('function');
    expect(typeof fn(0.5)).toBe('number');
  });
  it('cubicBezier return value never returns NaN for hostile t (NE1)', () => {
    const fn = cubicBezier(0.25, 0.1, 0.25, 1);
    const hostileTs = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2];
    for (const t of hostileTs) {
      expect(Number.isFinite(fn(t))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// steps() — NE7: n <= 0 or non-integer or non-finite → MotionParamError
// ---------------------------------------------------------------------------

describe('steps() factory validation — NE7', () => {
  it('steps(0,"end") throws MotionParamError (n=0 is invalid)', () => {
    expect(() => steps(0, 'end')).toThrow(MotionParamError);
  });
  it('steps(0,"start") throws MotionParamError (n=0 is invalid)', () => {
    expect(() => steps(0, 'start')).toThrow(MotionParamError);
  });
  it('steps(-1,"end") throws MotionParamError (n<0 is invalid)', () => {
    expect(() => steps(-1, 'end')).toThrow(MotionParamError);
  });
  it('steps(-100,"end") throws MotionParamError', () => {
    expect(() => steps(-100, 'end')).toThrow(MotionParamError);
  });
  it('steps(NaN,"end") throws MotionParamError', () => {
    expect(() => steps(Number.NaN, 'end')).toThrow(MotionParamError);
  });
  it('steps(Infinity,"end") throws MotionParamError', () => {
    expect(() => steps(Number.POSITIVE_INFINITY, 'end')).toThrow(MotionParamError);
  });
  it('steps(1.5,"end") throws MotionParamError (non-integer n)', () => {
    expect(() => steps(1.5, 'end')).toThrow(MotionParamError);
  });
  it('steps(2.9,"end") throws MotionParamError (non-integer n)', () => {
    expect(() => steps(2.9, 'end')).toThrow(MotionParamError);
  });

  // Valid: positive integer n — must NOT throw
  it('steps(1,"end") does NOT throw', () => {
    expect(() => steps(1, 'end')).not.toThrow();
  });
  it('steps(1,"start") does NOT throw', () => {
    expect(() => steps(1, 'start')).not.toThrow();
  });
  it('steps(4,"end") does NOT throw', () => {
    expect(() => steps(4, 'end')).not.toThrow();
  });
  it('steps(100,"end") does NOT throw', () => {
    expect(() => steps(100, 'end')).not.toThrow();
  });

  it('steps() error message mentions positive integer', () => {
    try {
      steps(0, 'end');
      expect.fail('Expected MotionParamError');
    } catch (e) {
      expect(e).toBeInstanceOf(MotionParamError);
      expect((e as MotionParamError).message).toMatch(/positive/i);
    }
  });

  it('steps() return value is a function', () => {
    const fn = steps(4, 'end');
    expect(typeof fn).toBe('function');
  });
  it('steps() return value never returns NaN for hostile t (NE1)', () => {
    const fn = steps(4, 'end');
    const hostileTs = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2];
    for (const t of hostileTs) {
      expect(Number.isFinite(fn(t))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// power() — NE7: non-finite exponent → MotionParamError
// ---------------------------------------------------------------------------

describe('power() factory validation — NE7', () => {
  it('power(NaN) throws MotionParamError', () => {
    expect(() => power(Number.NaN)).toThrow(MotionParamError);
  });
  it('power(Infinity) throws MotionParamError', () => {
    expect(() => power(Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
  });
  it('power(-Infinity) throws MotionParamError', () => {
    expect(() => power(Number.NEGATIVE_INFINITY)).toThrow(MotionParamError);
  });

  // Valid: finite exponents — must NOT throw (including edge cases)
  it('power(0) does NOT throw (t^0 = 1 for t>0, defined at boundary)', () => {
    expect(() => power(0)).not.toThrow();
  });
  it('power(-1) does NOT throw (finite, though curve is descending)', () => {
    expect(() => power(-1)).not.toThrow();
  });
  it('power(2) does NOT throw', () => {
    expect(() => power(2)).not.toThrow();
  });
  it('power(0.5) does NOT throw', () => {
    expect(() => power(0.5)).not.toThrow();
  });

  it('power() error message mentions finite', () => {
    try {
      power(Number.NaN);
      expect.fail('Expected MotionParamError');
    } catch (e) {
      expect(e).toBeInstanceOf(MotionParamError);
      expect((e as MotionParamError).message).toMatch(/finite/i);
    }
  });

  it('power() return value is a function', () => {
    const fn = power(3);
    expect(typeof fn).toBe('function');
  });
  it('power() return value never returns NaN for hostile t (NE1)', () => {
    const fn = power(3);
    const hostileTs = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2];
    for (const t of hostileTs) {
      expect(Number.isFinite(fn(t))).toBe(true);
    }
  });
});
