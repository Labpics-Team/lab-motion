import { describe, expect, it } from 'vitest';
import { spring } from '../src/index.js';

/**
 * Test: overdamped spring trajectory correctness
 * Class: unit (regression lock for Critical bug — inverted A1/A2 coefficients)
 *
 * The analytical overdamped solution is:
 *   x(t) = 1 + A1*e^{r1*t} + A2*e^{r2*t}
 *   Boundary conditions: x(0)=0, x'(0)=0
 *   → A1 = r2/(r1-r2),  A2 = -r1/(r1-r2)   (A1+A2 = -1, so x(0) = 1+(-1) = 0)
 *
 * The bug: inverted signs (A1=-r2/(r1-r2), A2=r1/(r1-r2)) give A1+A2=+1
 * → x(0)=2, spring starts at 2× target and monotonically decays toward 1.
 * Any fix that restores the correct signs will pass all assertions here.
 *
 * RED proof: with the inverted coefficients the value at t≈0 is ≈2.0,
 * so `expect(result.value).toBeLessThan(0.5)` fails immediately.
 *
 * Mutation proof: negate A1 or A2 in the fix and the initial-value
 * assertion `value(0)=0` fails. Negate both and the trajectory assertion
 * (value must increase toward 1, not decrease from 2) fails.
 */

describe('overdamped spring trajectory correctness (regression: inverted A1/A2)', () => {
  // Params that guarantee zeta > 1 (overdamped, no oscillation) and within the
  // drive() damping-ratio cap (≤4). zeta = c / (2*sqrt(k*m)) = 40/(2*10) = 2.0.
  // Previously used {mass:1, stiffness:50, damping:400} (zeta≈28.3) which is now
  // rejected at the validateSpringParams() boundary. Any zeta > 1 exercises the
  // overdamped solver branch — zeta=2 is sufficient and passes the drive() gate.
  const overdampedParams = { mass: 1, stiffness: 100, damping: 40 };

  it('spring is callable — prerequisite guard', () => {
    expect(typeof spring).toBe('function');
  });

  it('value at t≈0 is 0 (initial position), NOT 2 (inverted-sign artifact)', () => {
    // t=0 is special-cased to return {value:0,velocity:0} directly.
    // t=0.0001 exercises the overdamped branch with a negligible elapsed time.
    const result = spring(overdampedParams, 0.0001);
    // Correct behaviour: value is near 0 (spring just started).
    // Inverted-sign bug: value ≈ 2.0 (starts at double the target).
    expect(result.value).toBeLessThan(0.01);
    expect(result.value).toBeGreaterThanOrEqual(0);
  });

  it('value at t=0 is exactly 0 (boundary condition)', () => {
    const result = spring(overdampedParams, 0);
    expect(result.value).toBe(0);
    expect(result.velocity).toBe(0);
  });

  it('value at t=0.016 (one 60fps frame) is small and positive, not ≈2', () => {
    const result = spring(overdampedParams, 0.016);
    // With correct signs: value grows from 0 toward 1 slowly (overdamped is slow).
    // With inverted signs: value ≈ 1.998, decaying from 2 toward 1.
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThan(0.1);
  });

  it('value at t=1 is between 0 and 1 (partial progress toward target)', () => {
    const result = spring(overdampedParams, 1);
    // Correct: ~0.117 (slow overdamped rise). Inverted: ~1.88 (decayed from 2).
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThan(1);
  });

  it('value increases monotonically from t=0 toward t=10 (no oscillation, no reverse start)', () => {
    // Overdamped springs approach target from one side only — they do NOT oscillate
    // and must NOT start above the target. Sample 20 time points.
    const times = Array.from({ length: 20 }, (_, i) => (i + 1) * 0.5);
    let prev = spring(overdampedParams, 0).value; // 0
    for (const t of times) {
      const { value } = spring(overdampedParams, t);
      expect(value).toBeGreaterThanOrEqual(prev - 1e-10); // monotone (allow float epsilon)
      prev = value;
    }
  });

  it('value approaches 1 asymptotically (converges toward target)', () => {
    // Heavily overdamped (zeta≈28) springs converge slowly — that is correct physics.
    // We verify the qualitative asymptotic behaviour at two time scales:
    //   t=20: well past halfway (> 0.9), proving rise from 0 not decay from 2
    //   t=100: close to 1 (> 0.9999)
    const at20 = spring(overdampedParams, 20);
    expect(at20.value).toBeGreaterThan(0.9);
    expect(at20.value).toBeLessThanOrEqual(1 + 1e-9);

    const at100 = spring(overdampedParams, 100);
    expect(at100.value).toBeGreaterThan(0.9999);
    expect(at100.value).toBeLessThanOrEqual(1 + 1e-9); // does not overshoot
  });

  it('velocity at t≈0 is near 0 (x′(0)=0 boundary condition)', () => {
    const result = spring(overdampedParams, 0.0001);
    // With correct signs: velocity ≈ 0 (spring barely started).
    // With inverted signs: velocity is large and negative (decaying from 2).
    expect(Math.abs(result.velocity)).toBeLessThan(0.5);
  });

  it('discriminates from underdamped: overdamped has no negative velocity after t=0', () => {
    // An underdamped spring oscillates and has negative velocity after overshooting.
    // An overdamped spring approaches target from below — velocity is always >= 0.
    const times = Array.from({ length: 50 }, (_, i) => (i + 1) * 0.1);
    for (const t of times) {
      const { velocity } = spring(overdampedParams, t);
      // velocity from the solver can be negative when the spring decays
      // but raw spring velocity for overdamped from-rest should be non-negative.
      // (It is a decay toward zero, not an oscillation.)
      expect(velocity).toBeGreaterThanOrEqual(-1e-9); // allow float epsilon
    }
  });
});
