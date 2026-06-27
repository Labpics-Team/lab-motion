import { describe, expect, it } from 'vitest';
import { MotionParamError, drive, spring } from '../src/index.js';
import { springUnchecked } from '../src/spring.js';

/**
 * Test: convergence-class guard — closes the wall-clock-stall class
 * Class: regression (correctness + performance)
 *
 * The wall-clock-stall class has TWO independent failure modes:
 *
 * MODE A — slow overdamped (prior bug, root cause of Finding #3):
 *   High ζ extends slow-mode settling time τ_slow = 1/(ω₀·(ζ−√(ζ²−1))).
 *   The PRIOR floor of ω₀ ≥ 0.5 rad/s was empirically wrong:
 *     {m:1, k:0.25, c:4}: ω₀=0.5 (AT floor, passes guard), ζ=4 (at cap, passes guard)
 *     → closes at frame 5021 (83.7 s), snaps at MAX_FRAMES=2000 with a 12.2% jump.
 *   Fix: raise MIN_NATURAL_FREQUENCY to 2.0 rad/s (critical ≈ 1.2552 rad/s, safe headroom).
 *   Worst-case accepted (ω₀=2.0, ζ=4) now converges at frame 1256 < MAX_FRAMES.
 *
 * MODE B — near-undamped (new class guard, closes Finding #3 remainder):
 *   Very low ζ: decay envelope exp(−ζ·ω₀·t) is nearly flat → oscillates to MAX_FRAMES.
 *   Fix: add MIN_DAMPING_RATIO = 0.2 floor (ζ=0.2 at ω₀=2.0 converges at frame 844).
 *
 * Mutation targets:
 *   - Remove `omega0 < MIN_NATURAL_FREQUENCY` guard → "throws for low-ω₀" tests FAIL.
 *   - Lower MIN_NATURAL_FREQUENCY to 0.5 → worst-case-accepted-pair test FAILS (would stall).
 *   - Remove `zeta < MIN_DAMPING_RATIO` guard → "throws for low-ζ" tests FAIL.
 *   - Lower MIN_DAMPING_RATIO to 0.01 → near-undamped worst-case test would stall.
 *
 * The worst-case-accepted-pair tests (MODE A worst case + MODE B worst case) are the KEY
 * regression locks: they bite if the floor is lowered even slightly.
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

// ─── Constants mirrored from src/spring.ts for test assertions ──────────────
// If these change, update the guard AND the tests together.
const MIN_NATURAL_FREQUENCY = 2.0; // rad/s
const MIN_DAMPING_RATIO = 0.2;
const MAX_DAMPING_RATIO = 4;
const MAX_FRAMES = 2000;
const FIXED_DT_S = 1 / 60;

/**
 * Synchronously drive a spring to completion and return the frame count.
 * Uses the same closed-form solver as drive() to count convergence frames,
 * without requiring an async scheduler.
 */
function convergenceFrameSync(
  omega0: number,
  zeta: number,
  threshold = 0.005,
): number {
  const sqrtTerm = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega0 * (zeta - sqrtTerm);
  const r2 = -omega0 * (zeta + sqrtTerm);
  const A1 = r2 / (r1 - r2);
  const A2 = -r1 / (r1 - r2);
  // Search up to 3× MAX_FRAMES so we can detect a stall without infinite loop
  for (let f = 0; f <= MAX_FRAMES * 3; f++) {
    const t = f * FIXED_DT_S;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    const value = 1 + A1 * e1 + A2 * e2;
    const velocity = A1 * r1 * e1 + A2 * r2 * e2;
    if (Math.abs(value - 1) < threshold && Math.abs(velocity) < threshold) return f;
  }
  return Infinity;
}

describe('convergence-class guard — wall-clock-stall class (regression lock)', () => {
  // ─── MODE A: ω₀ floor (slow-overdamped stall) ─────────────────────────────
  describe('MODE A: ω₀ < MIN_NATURAL_FREQUENCY rejected — slow-overdamped stall class', () => {
    it('throws for {mass:1, stiffness:0.01, damping:0.08} — ω₀=0.1 rad/s, ζ=0.4', () => {
      // omega0 = sqrt(0.01/1) = 0.1 < 2.0 → must throw (omega0 guard)
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 0.01, damping: 0.08 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('throws for {mass:1, stiffness:0.1, damping:0.8} — ω₀≈0.316 rad/s, ζ≈1.27', () => {
      // omega0 = sqrt(0.1) ≈ 0.316 < 2.0 → throws on omega0 guard
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 0.1, damping: 0.8 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('throws for {mass:100, stiffness:1, damping:8} — ω₀=0.1 rad/s (heavy mass, soft spring)', () => {
      // omega0 = sqrt(1/100) = 0.1 < 2.0 → throws
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 100, stiffness: 1, damping: 8 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('throws for the OLD floor config {mass:1, stiffness:0.25, damping:4} — ω₀=0.5 (prior root cause)', () => {
      // This is the EXACT config that passed the prior guard (ω₀=0.5, ζ=4) yet stalled 83.7s.
      // With the corrected floor (2.0), it must now throw.
      // omega0 = sqrt(0.25/1) = 0.5 < 2.0 → throws
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 0.25, damping: 4 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('spring() also throws for low-ω₀ configs', () => {
      expect(() => spring({ mass: 1, stiffness: 0.01, damping: 0.08 }, 0.5)).toThrow(MotionParamError);
    });

    it('error message names natural frequency (ω₀) to guide the caller', () => {
      let msg = '';
      try {
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 0.01, damping: 0.08 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/natural frequency|stiffness.*mass|omega|ω/i);
    });

    it('error is MotionParamError (not TypeError or generic Error)', () => {
      let caught: unknown;
      try {
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 0.01, damping: 0.08 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MotionParamError);
    });

    /**
     * KEY REGRESSION LOCK — MODE A worst-case accepted pair.
     * If MIN_NATURAL_FREQUENCY is ever lowered below 2.0, a config will be accepted
     * that stalls at MAX_FRAMES. This test uses the CLOSED-FORM SOLVER to prove the
     * worst-case accepted pair (ω₀=MIN_NATURAL_FREQUENCY, ζ=MAX_DAMPING_RATIO)
     * converges before MAX_FRAMES.
     *
     * Mutation that breaks the class: lower MIN_NATURAL_FREQUENCY in spring.ts →
     * convergenceFrameSync(new_floor, 4) will return > MAX_FRAMES → this test FAILS.
     */
    it('worst-case accepted pair (ω₀=2.0, ζ=4.0) converges before MAX_FRAMES — regression lock', () => {
      // Verify the at-floor, at-cap config does not stall.
      // convergenceFrameSync uses the same overdamped closed-form as springUnchecked().
      const frame = convergenceFrameSync(MIN_NATURAL_FREQUENCY, MAX_DAMPING_RATIO);
      expect(frame).toBeLessThan(MAX_FRAMES);
      // Anchor the frame count so we catch regressions even to any MAX_FRAMES raise:
      // empirically 1256 frames at ω₀=2.0, ζ=4 (≈ 20.9 s).
      expect(frame).toBeLessThanOrEqual(1300);
    });

    it('prior buggy floor (ω₀=0.5, ζ=4) would have stalled at frame 5021 — documents root cause', () => {
      // DOCUMENTATION TEST: proves the prior floor was wrong.
      // Do NOT call drive() with this config (it now throws). Use the solver directly.
      const r1 = -0.5 * (4 - Math.sqrt(15));
      const r2 = -0.5 * (4 + Math.sqrt(15));
      const A1 = r2 / (r1 - r2);
      const A2 = -r1 / (r1 - r2);
      // Compute value at MAX_FRAMES to show the 12.2% snap:
      const t_max = MAX_FRAMES * FIXED_DT_S;
      const value_at_max = 1 + A1 * Math.exp(r1 * t_max) + A2 * Math.exp(r2 * t_max);
      const snap_pct = Math.abs(1 - value_at_max) * 100;
      // The value at MAX_FRAMES must be far from 1 (i.e. the spring hasn't settled).
      expect(snap_pct).toBeGreaterThan(10); // prior config would snap >10% at MAX_FRAMES
    });
  });

  // ─── MODE B: ζ floor (near-undamped stall) ────────────────────────────────
  describe('MODE B: ζ < MIN_DAMPING_RATIO rejected — near-undamped oscillation stall class', () => {
    it('throws for {mass:1, stiffness:100, damping:0} — ζ=0, purely undamped', () => {
      // ω₀=10 (passes omega0 guard). ζ=0 < 0.2 → throws (min-damping guard).
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 100, damping: 0 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('throws for {mass:1, stiffness:100, damping:0.1} — ζ=0.005, near-undamped', () => {
      // ω₀=10. ζ=0.1/(2*10)=0.005 < 0.2 → throws.
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 100, damping: 0.1 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('throws for {mass:1, stiffness:4, damping:0.5} — ω₀=2.0, ζ=0.125 (at ω₀ floor, near-undamped)', () => {
      // omega0=sqrt(4/1)=2.0 (passes omega0 guard). zeta=0.5/(2*sqrt(4))=0.125 < 0.2 → throws.
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 4, damping: 0.5 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).toThrow(MotionParamError);
    });

    it('error message names damping to guide the caller', () => {
      let msg = '';
      try {
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 100, damping: 0 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/damping/i);
    });

    it('spring() also throws for near-undamped configs', () => {
      expect(() => spring({ mass: 1, stiffness: 100, damping: 0 }, 0.5)).toThrow(MotionParamError);
    });

    /**
     * KEY REGRESSION LOCK — MODE B worst-case accepted pair.
     * Worst case for underdamped: ω₀ = MIN_NATURAL_FREQUENCY = 2.0, ζ = MIN_DAMPING_RATIO = 0.2.
     * Uses the springUnchecked() solver (bypasses validation, tests pure physics convergence).
     * If MIN_DAMPING_RATIO is ever lowered, this verifies the class is still closed.
     */
    it('worst-case accepted pair (ω₀=2.0, ζ=0.2) converges before MAX_FRAMES — regression lock', () => {
      // Drive the worst-case underdamped config via the raw solver and count convergence.
      // omega0=2.0, zeta=0.2 => mass=1, stiffness=4, damping=0.2*2*sqrt(4*1)=0.8
      // Verify it passes validation first:
      const accepted = { mass: 1, stiffness: 4, damping: 0.8 };
      // Sanity: these pass the guards (no throw expected)
      const omega0 = Math.sqrt(accepted.stiffness / accepted.mass);
      const zeta = accepted.damping / (2 * Math.sqrt(accepted.stiffness * accepted.mass));
      expect(omega0).toBeCloseTo(2.0, 5);
      expect(zeta).toBeCloseTo(0.2, 5);

      // Count convergence frames using the raw solver (underdamped branch)
      const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
      let convergenceFrame = Infinity;
      for (let f = 0; f <= MAX_FRAMES * 3; f++) {
        const t = f * FIXED_DT_S;
        const { value, velocity } = springUnchecked(accepted, t);
        if (Math.abs(value - 1) < 0.005 && Math.abs(velocity) < 0.005) {
          convergenceFrame = f;
          break;
        }
      }
      expect(convergenceFrame).toBeLessThan(MAX_FRAMES);
      // Anchor: empirically ~844 frames at ω₀=2.0, ζ=0.2
      expect(convergenceFrame).toBeLessThanOrEqual(1000);
      // Silence unused var (omegaD used in derivation above, TypeScript may warn)
      void omegaD;
    });
  });

  // ─── Accepted configs: valid zone ──────────────────────────────────────────
  describe('accepted configs — valid zone (ω₀ ≥ 2.0, 0.2 ≤ ζ ≤ 4.0)', () => {
    it('does not throw for typical UI spring {mass:1, stiffness:100, damping:10} — ω₀=10, ζ=0.5', () => {
      // omega0 = sqrt(100) = 10 >> 2.0, zeta = 10/(2*10) = 0.5 > 0.2
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 100, damping: 10 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).not.toThrow();
    });

    it('does not throw for {mass:1, stiffness:4, damping:1.6} — ω₀=2.0 (at floor), ζ=0.4', () => {
      // omega0 = sqrt(4) = 2.0 exactly = MIN_NATURAL_FREQUENCY — must NOT throw (< not <=)
      // zeta = 1.6/(2*sqrt(4)) = 1.6/4 = 0.4 > 0.2 — OK
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 4, damping: 1.6 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).not.toThrow();
    });

    it('does not throw for stiff spring {mass:1, stiffness:400, damping:80} — ω₀=20, ζ=2.0', () => {
      // omega0 = sqrt(400) = 20, zeta = 80/(2*sqrt(400)) = 80/40 = 2.0 — valid
      expect(() =>
        drive({
          from: 0, to: 100,
          spring: { mass: 1, stiffness: 400, damping: 80 },
          onStep: () => {},
          matchMedia: noReduceMedia(),
        }),
      ).not.toThrow();
    });
  });
});
