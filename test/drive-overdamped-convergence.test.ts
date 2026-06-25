import { describe, expect, it } from 'vitest';
import { MotionParamError, drive } from '../src/index.js';

/**
 * Test: overdamped/low-stiffness springs are rejected at the boundary — no MAX_FRAMES stall
 * Class: regression (correctness + performance)
 * Finding: "Overdamped/low-stiffness valid springs never satisfy isConverged() — loop runs
 *   MAX_FRAMES=2000 cap (~33s) then snaps to `to`"
 *
 * Root cause: isConverged() requires both position AND velocity to be < 0.5% of range
 *   simultaneously. For highly overdamped regimes (zeta >> 1), the position decays so slowly
 *   that frameCount hits MAX_FRAMES=2000 before the dual threshold is satisfied. The public
 *   API accepted any positive stiffness without a damping-ratio guard.
 *   Verified: {mass:1, stiffness:1, damping:10} → zeta=5.0 → conv=false after 2000 frames.
 *
 * Fix class: validateSpringParams() (called synchronously at drive() boundary) now computes
 *   ζ = c/(2*sqrt(k*m)) and throws MotionParamError if ζ > MAX_DAMPING_RATIO (4). This
 *   makes the class impossible: no valid spring config can reach MAX_FRAMES via extreme
 *   overdamping through the public API.
 *
 * RED proof (mutation targets):
 *   - Remove the zeta guard from validateSpringParams → the "throws for extreme overdamping"
 *     tests fail (no error thrown).
 *   - Change `zeta > MAX_DAMPING_RATIO` to `zeta > 1000` → same failure for the
 *     {1,1,10} case (zeta=5, which is below 1000).
 *
 * Mutation proof:
 *   Any regression removing the zeta guard lets these overdamped configs through,
 *   causing the integration test (CPU-stall regression) to time out.
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

describe('overdamped spring rejected at drive() boundary — no MAX_FRAMES stall (regression lock)', () => {
  describe('zeta > MAX_DAMPING_RATIO (4) — synchronous MotionParamError', () => {
    it('throws for {mass:1, stiffness:1, damping:10} — the exact failing case (zeta=5)', () => {
      // zeta = 10 / (2*sqrt(1*1)) = 5 > 4 → must throw at boundary
      expect(() =>
        drive({
          from: 0,
          to: 200,
          spring: { mass: 1, stiffness: 1, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('error message references damping ratio', () => {
      let msg = '';
      try {
        drive({
          from: 0,
          to: 200,
          spring: { mass: 1, stiffness: 1, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      // The message should name the damping ratio so the caller understands the constraint.
      expect(msg).toMatch(/damping ratio/i);
    });

    it('throws for extreme damping zeta >> 4 (damping=100, stiffness=1, mass=1)', () => {
      // zeta = 100/(2*1) = 50 >> 4
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: 1, damping: 100 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('throws for low stiffness+high damping zeta > 4 variant', () => {
      // zeta = 20 / (2*sqrt(2*1)) = 7.07 > 4
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: 2, damping: 20 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });
  });

  describe('zeta <= MAX_DAMPING_RATIO — accepted and converges without stall', () => {
    it('does not throw for well-damped UI spring {mass:1, stiffness:170, damping:26} (zeta≈1.0)', async () => {
      // zeta = 26/(2*sqrt(170)) = 26/26.08 ≈ 1.0 — critically damped, within range
      const values: number[] = [];
      const frameQueue: Array<(ts: number) => void> = [];
      let ts = 0;
      const clock = (cb: (ts: number) => void): number => {
        frameQueue.push(cb);
        return frameQueue.length; // non-zero handle
      };

      const done = drive({
        from: 0,
        to: 100,
        spring: { mass: 1, stiffness: 170, damping: 26 },
        onStep: (v) => values.push(v),
        matchMedia: noReduceMedia(),
        requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
      });

      // Drain up to 200 frames — well-damped spring converges in ~47 frames
      for (let i = 0; i < 200 && frameQueue.length > 0; i++) {
        ts += 16;
        const cb = frameQueue.shift();
        cb?.(ts);
      }
      await done;

      // Converged — last value is `to`
      expect(values[values.length - 1]).toBe(100);
      // Converged well before MAX_FRAMES (200 drain cap is already well under 2000)
      expect(values.length).toBeLessThan(200);
    }, 3000);

    it('does not throw for {mass:1, stiffness:100, damping:10} (zeta=0.5 — underdamped)', async () => {
      // zeta = 10/(2*sqrt(100)) = 10/20 = 0.5 < 4 — should pass
      const values: number[] = [];
      await drive({
        from: 0,
        to: 100,
        spring: { mass: 1, stiffness: 100, damping: 10 },
        onStep: (v) => values.push(v),
        matchMedia: noReduceMedia(),
        requestFrame: (_cb) => 0, // non-draining → setTimeout fallback
      });
      expect(values[values.length - 1]).toBe(100);
    }, 3000);

    it('zeta exactly at boundary (ζ≈4) — accepted (boundary is inclusive)', () => {
      // Build a config where zeta ≈ 4: c = 4*2*sqrt(k*m) = 8*sqrt(k*m)
      // With k=100, m=1: c = 8*sqrt(100) = 80, zeta = 80/(2*10) = 4.0
      // This is AT the limit — must NOT throw (boundary is > not >=)
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: 100, damping: 80 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).not.toThrow();
    });

    it('zeta just above boundary (ζ≈4.01) — rejected', () => {
      // c = 80.2, zeta ≈ 4.01 > 4 → throws
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: { mass: 1, stiffness: 100, damping: 80.2 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });
  });
});
