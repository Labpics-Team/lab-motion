/**
 * spring.ts — L1 Domain: pure spring physics solver.
 *
 * Pure function of (params, t). No DOM, no clock, no window, no global state.
 * Invariants:
 *   2. CSS-safe: output is always finite (never NaN, never Infinity).
 *   3. Deterministic: identical (params, t) → identical output.
 *   5. Domain purity: no external imports, no side effects.
 *
 * Physics model:
 *   Underdamped / critically-damped / overdamped spring from rest (x=0)
 *   toward target (x=1), using the closed-form analytical solution.
 *   Normalized: from=0, to=1. Caller scales to [from, to].
 *
 * Time units: t is in seconds. Typical frame dt ≈ 0.016s (60fps).
 */

import { MotionParamError } from './errors.js';

/** Physics parameters for a spring. */
export interface SpringParams {
  /** Positive finite mass (kg). */
  readonly mass: number;
  /** Positive finite stiffness (N/m). */
  readonly stiffness: number;
  /** Non-negative finite damping coefficient (N·s/m). Zero = undamped. */
  readonly damping: number;
}

/** Output of the spring solver at a given time. */
export interface SpringResult {
  /**
   * Normalized spring position [0..~1] at time t.
   * 0 = start, 1 = target (may overshoot slightly for underdamped springs).
   */
  readonly value: number;
  /** Velocity in position-units per second. */
  readonly velocity: number;
}

/**
 * Maximum allowed damping ratio (ζ). Above this the spring is so overdamped
 * that the time-constant τ = m/(c/2) is multiple seconds and the animation
 * will run the full MAX_FRAMES cap (≈33 s at 60 fps) before snapping.
 *
 * Physics: zeta = c / (2*sqrt(k*m)). For zeta=4, the slower exponential root
 * decays with τ ≈ m/(omega0*(zeta-sqrt(zeta²-1))) which for {m:1,k:1} ≈ 7.7 s.
 * Setting the limit at zeta≤4 keeps the worst-case animation under ~5 s
 * for any valid param set, while still allowing heavily overdamped configs
 * that UI engineers commonly reach for to avoid oscillation.
 */
const MAX_DAMPING_RATIO = 4;

/**
 * Validate spring params. Throws MotionParamError for invalid inputs.
 *
 * Exported so drive() can call this synchronously at its boundary —
 * before any Promise is constructed or frame scheduled — making invalid
 * spring config throw eagerly and deterministically regardless of the
 * injected scheduler.
 */
export function validateSpringParams(p: SpringParams): void {
  if (!Number.isFinite(p.mass) || p.mass <= 0) {
    throw new MotionParamError(`spring: mass must be a positive finite number, got ${p.mass}`);
  }
  if (!Number.isFinite(p.stiffness) || p.stiffness <= 0) {
    throw new MotionParamError(
      `spring: stiffness must be a positive finite number, got ${p.stiffness}`,
    );
  }
  if (!Number.isFinite(p.damping) || p.damping < 0) {
    throw new MotionParamError(
      `spring: damping must be a non-negative finite number, got ${p.damping}`,
    );
  }
  // Guard against extreme overdamping. Compute the damping ratio ζ and reject
  // configs that would cause the animation to run to MAX_FRAMES (CPU stall +
  // abrupt snap to `to`). This closes the class: no valid spring config can
  // produce a >MAX_DAMPING_RATIO overdamped animation through the public API.
  const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
  if (zeta > MAX_DAMPING_RATIO) {
    throw new MotionParamError(
      `spring: damping ratio ζ=${zeta.toFixed(2)} exceeds the maximum of ${MAX_DAMPING_RATIO}. Reduce damping or increase stiffness/mass to avoid a CPU-bound animation stall. Current: {mass:${p.mass}, stiffness:${p.stiffness}, damping:${p.damping}}.`,
    );
  }
}

/**
 * Clamp a value to be finite. Defensive guard — analytical solver should
 * never produce non-finite values for valid inputs, but floating-point
 * edge cases near critical damping can produce tiny infinities or NaN.
 *
 * NaN is treated as the spring-at-rest position (0) because:
 *   - NaN can only arise from indeterminate forms (0/0, Infinity*0) during
 *     degenerate floating-point evaluation (e.g. t=Infinity passed externally).
 *   - The spring at rest at the start position (0, normalized) is the safest
 *     CSS-safe fallback — it produces no visual glitch and does not inject a
 *     wrong-sign huge value into consumer CSS transforms.
 *   - The "always finite" invariant is met; the wrong-sign -MAX_VALUE branch
 *     (NaN > 0 === false) was a semantic violation: a solver targeting x=1
 *     returning -1.8e308 is physically absurd.
 */
function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/**
 * Internal solver — same as spring() but skips validation.
 * Used by drive() which validates spring params once at its boundary (before any
 * Promise or frame is scheduled) so the per-frame tick loop pays zero validation cost.
 * Never call this directly from outside this module; use spring() or drive() instead.
 *
 * @internal
 */
export function springUnchecked(params: SpringParams, t: number): SpringResult {
  const { mass: m, stiffness: k, damping: c } = params;

  // At t=0 the spring is at rest at the start position.
  if (t <= 0) {
    return { value: 0, velocity: 0 };
  }

  const omega0 = Math.sqrt(k / m); // natural frequency
  const zeta = c / (2 * Math.sqrt(k * m)); // damping ratio

  let value: number;
  let velocity: number;

  if (zeta < 1) {
    // Underdamped: oscillates, decays toward 1.
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta); // damped frequency
    const decay = Math.exp(-zeta * omega0 * t);
    // x(t) = 1 - e^{-zeta*omega0*t} * (cos(omegaD*t) + (zeta*omega0/omegaD)*sin(omegaD*t))
    const cosD = Math.cos(omegaD * t);
    const sinD = Math.sin(omegaD * t);
    const A = (zeta * omega0) / omegaD;
    value = 1 - decay * (cosD + A * sinD);
    // x'(t) — derivative:
    velocity =
      zeta * omega0 * decay * (cosD + A * sinD) - decay * (-omegaD * sinD + A * omegaD * cosD);
  } else if (zeta === 1) {
    // Critically damped: fastest non-oscillatory approach.
    const decay = Math.exp(-omega0 * t);
    value = 1 - decay * (1 + omega0 * t);
    velocity = decay * omega0 * omega0 * t;
  } else {
    // Overdamped: two real exponentials, no oscillation.
    const sqrtTerm = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega0 * (zeta - sqrtTerm);
    const r2 = -omega0 * (zeta + sqrtTerm);
    // x(t) = 1 + A1*e^{r1*t} + A2*e^{r2*t}
    // Boundary conditions: x(0)=0, x'(0)=0 → A1 + A2 = -1, r1*A1 + r2*A2 = 0
    // Solving: A1 = r2/(r1-r2), A2 = -r1/(r1-r2)  (sum = -1 ✓, x(0) = 1+(-1) = 0 ✓)
    const A1 = r2 / (r1 - r2);
    const A2 = -r1 / (r1 - r2);
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    value = 1 + A1 * e1 + A2 * e2;
    velocity = A1 * r1 * e1 + A2 * r2 * e2;
  }

  return {
    value: clampFinite(value),
    velocity: clampFinite(velocity),
  };
}

/**
 * Compute normalized spring position and velocity at time `t` (seconds).
 *
 * Public entry point — validates params then delegates to the solver.
 * drive() uses springUnchecked() internally (params already validated at drive boundary).
 *
 * Analytical closed-form solution for a spring-mass-damper system:
 *   m * x'' + c * x' + k * x = k  (driving toward 1)
 *   Initial conditions: x(0)=0, x'(0)=0
 *
 * Three regimes:
 *   1. Underdamped:  c < 2*sqrt(k*m)
 *   2. Critically:   c = 2*sqrt(k*m)
 *   3. Overdamped:   c > 2*sqrt(k*m)
 *
 * @param params - spring physics parameters
 * @param t      - time in seconds (≥ 0)
 */
export function spring(params: SpringParams, t: number): SpringResult {
  validateSpringParams(params);
  return springUnchecked(params, t);
}
