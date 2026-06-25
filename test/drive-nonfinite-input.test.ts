import { describe, expect, it } from 'vitest';
import { MotionParamError, drive } from '../src/index.js';

/**
 * Test: drive() non-finite from/to — validated at entry, MotionParamError thrown
 * Class: regression (AppSec + correctness)
 * Finding: Non-finite from/to never validated at drive() entry — NaN/Infinity
 *   escape to onStep (consumer CSS) + 2000-frame DoS.
 *
 * Root cause: drive() destructured from/to but applied no Number.isFinite guard.
 *   NaN===NaN is false → proceeded past the from===to early-exit.
 *   range=NaN → lo=NaN → clamp(NaN,NaN,0)=NaN → onStep(NaN) every frame.
 *   isConverged(): Math.abs(NaN-to)/absRange = NaN < 0.005 = false always →
 *   loop ran to MAX_FRAMES=2000 before settle().
 *
 * Fix class: validate Number.isFinite(from) && Number.isFinite(to) at drive()
 *   entry and throw MotionParamError, mirroring spring.ts validate() pattern.
 *
 * Invariant locked: drive.ts docstring line 7:
 *   "CSS-safe — only finite values emitted via onStep."
 *
 * RED proof (mutation targets):
 *   - Remove the Number.isFinite(from) guard → NaN propagates to onStep → the
 *     "no non-finite onStep call" assertion fails.
 *   - Change `throw new MotionParamError(...)` to a no-op → the toThrow assertion fails.
 *
 * Mutation proof:
 *   Any regression that lets non-finite from/to reach the frame loop will emit
 *   NaN to onStep → the finiteness assertion in the no-throw control group catches it.
 */

describe('drive() non-finite from/to — MotionParamError at entry (regression lock)', () => {
  it('throws MotionParamError synchronously for from=NaN', () => {
    expect(() =>
      drive({
        from: Number.NaN,
        to: 100,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
      }),
    ).toThrow(MotionParamError);
  });

  it('throws MotionParamError synchronously for to=NaN', () => {
    expect(() =>
      drive({
        from: 0,
        to: Number.NaN,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
      }),
    ).toThrow(MotionParamError);
  });

  it('throws MotionParamError synchronously for from=Infinity', () => {
    expect(() =>
      drive({
        from: Number.POSITIVE_INFINITY,
        to: 100,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
      }),
    ).toThrow(MotionParamError);
  });

  it('throws MotionParamError synchronously for to=-Infinity', () => {
    expect(() =>
      drive({
        from: 0,
        to: Number.NEGATIVE_INFINITY,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
      }),
    ).toThrow(MotionParamError);
  });

  it('throws MotionParamError for from=Infinity AND to=Infinity', () => {
    expect(() =>
      drive({
        from: Number.POSITIVE_INFINITY,
        to: Number.POSITIVE_INFINITY,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
      }),
    ).toThrow(MotionParamError);
  });

  it('error message names the invalid parameter', () => {
    let caughtMessage = '';
    try {
      drive({
        from: Number.NaN,
        to: 100,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
      });
    } catch (e) {
      caughtMessage = (e as Error).message;
    }
    expect(caughtMessage).toMatch(/from/);
    expect(caughtMessage).toMatch(/NaN/);
  });

  it('error is instanceof MotionParamError AND Error', () => {
    let caught: unknown;
    try {
      drive({
        from: 0,
        to: Number.POSITIVE_INFINITY,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect(caught).toBeInstanceOf(Error);
  });

  it('does NOT throw and emits no non-finite values for valid from/to (control group)', async () => {
    // Regression guard: the validation must not reject valid inputs.
    const values: number[] = [];

    // Use a non-draining step-clock so the test runs without a real rAF event loop.
    await drive({
      from: 0,
      to: 100,
      onStep: (v) => values.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: (_cb) => 0, // non-draining → setTimeout fallback resolves
    });

    for (const v of values) {
      expect(Number.isFinite(v), `non-finite value escaped to onStep: ${v}`).toBe(true);
    }
    expect(values[values.length - 1]).toBe(100);
  }, 2000);
});
