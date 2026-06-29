import { describe, expect, it } from 'vitest';
import { MotionParamError, drive } from '../src/index.js';

/**
 * Test: spring param validation is at the drive() boundary — synchronous, scheduler-independent
 * Class: regression (correctness + contract)
 * Finding: "Spring-param validation absent at drive() boundary — scheduler-dependent error
 *   contract (UNCAUGHT+hang vs REJECT)"
 *
 * Root cause: spring params were validated lazily inside spring() which is first
 *   called from tick() → computeValue(), reached only when the scheduler fires.
 *   On a real rAF / non-draining injected clock tick() runs asynchronously
 *   (setTimeout fallback), so the MotionParamError escaped the Promise executor
 *   → window.onerror (UNCAUGHT), never .catch(). On a draining clock tick() ran
 *   synchronously inside the executor → REJECT. Identical bad input, different
 *   error contract depending on the scheduler.
 *
 * Fix class: validateSpringParams() is called synchronously in drive() before any
 *   Promise is constructed, mirroring the from/to guards. The error contract is now
 *   always a synchronous throw — scheduler-independent.
 *
 * RED proof (mutation targets):
 *   - Remove the validateSpringParams(opts.spring) call from drive.ts → the
 *     synchronous throw tests fail (no error thrown synchronously).
 *   - Replace validateSpringParams with a no-op → same failure.
 *
 * Mutation proof:
 *   Any regression that moves validation back into tick()/spring() will cause
 *   the "throws synchronously" tests to fail because they don't await a Promise.
 */

/** Stub matchMedia: no reduced-motion preference. */
function noReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * Non-draining clock: returns 0, never invokes callback.
 * Represents real rAF / async scheduler scenario from the finding.
 */
function nonDrainingClock(_cb: (ts?: number) => void): number {
  return 0;
}

describe('drive() spring-param validation is at the boundary — scheduler-independent (regression lock)', () => {
  describe('invalid stiffness — synchronous throw before any scheduler', () => {
    it('throws MotionParamError synchronously for stiffness=-100 (non-draining clock)', () => {
      // This was the UNCAUGHT case: tick() ran async via setTimeout, MotionParamError
      // escaped the Promise and went to window.onerror. After the fix, drive() itself
      // throws synchronously before returning a Promise.
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: -100, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });

    it('throws MotionParamError synchronously for stiffness=0', () => {
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: 0, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });

    it('throws MotionParamError synchronously for stiffness=NaN', () => {
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: Number.NaN, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });

    it('throws MotionParamError synchronously for stiffness=Infinity', () => {
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: Number.POSITIVE_INFINITY, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });
  });

  describe('invalid mass — synchronous throw before any scheduler', () => {
    it('throws MotionParamError synchronously for mass=-1', () => {
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: -1, stiffness: 100, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });

    it('throws MotionParamError synchronously for mass=0', () => {
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 0, stiffness: 100, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });
  });

  describe('invalid damping — synchronous throw before any scheduler', () => {
    it('throws MotionParamError synchronously for damping=-1', () => {
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: 100, damping: -1 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });

    it('throws MotionParamError synchronously for damping=NaN', () => {
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: 100, damping: Number.NaN },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        }),
      ).toThrow(MotionParamError);
    });
  });

  describe('error contract is scheduler-independent (the core finding)', () => {
    it('error from invalid spring is a synchronous throw — NOT a Promise rejection', () => {
      // If validation is at the boundary, drive() throws before returning a Promise.
      // The caller can catch it with a plain try/catch, no .catch() needed.
      // Previously this was only catchable via window.onerror on non-draining clocks.
      let threw = false;
      let returnedPromise = false;

      try {
        const p = drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: -1, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        });
        // If we reach here, drive() returned without throwing.
        returnedPromise = true;
        void p; // suppress unused warning
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      expect(returnedPromise).toBe(false);
    });

    it('error from invalid spring is MotionParamError (not TypeError or generic Error)', () => {
      let caught: unknown;
      try {
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: -100, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MotionParamError);
      expect(caught).toBeInstanceOf(Error);
    });

    it('error message names the invalid param (stiffness)', () => {
      let msg = '';
      try {
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: -100, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/stiffness/);
    });
  });

  describe('valid spring params — no throw (control group)', () => {
    it('does not throw for valid spring params {mass:1, stiffness:100, damping:10}', async () => {
      const values: number[] = [];
      await drive({
        from: 0,
        to: 100,
        spring: { mass: 1, stiffness: 100, damping: 10 },
        onStep: (v) => values.push(v),
        matchMedia: noReduceMedia(),
        requestFrame: nonDrainingClock,
      });
      expect(values[values.length - 1]).toBe(100);
    }, 2000);

    it('throws for damping=0 (undamped — ζ=0 < MIN_DAMPING_RATIO=0.2, now correctly rejected)', () => {
      // damping=0 → zeta=0 < 0.2 → MotionParamError (near-undamped stall class).
      // Prior behaviour (accepted, oscillated to MAX_FRAMES) was a latent CPU-stall bug:
      // an undamped spring never satisfies isConverged() and always hits MAX_FRAMES→snap.
      // The MIN_DAMPING_RATIO guard closes this class; damping=0 must now throw.
      expect(() => {
        drive({
          from: 0,
          to: 50,
          spring: { mass: 1, stiffness: 100, damping: 0 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
          requestFrame: nonDrainingClock,
        });
      }).toThrow(MotionParamError);
    });
  });
});
