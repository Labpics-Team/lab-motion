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
import { solveSpring } from './internal/solver.js';

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
 * it takes very long to converge and the animation stalls or snaps at MAX_FRAMES.
 *
 * Physics: zeta = c / (2*sqrt(k*m)).
 *
 * Empirically verified (closed-form solver + drive() convergence loop):
 * at ω₀ ≥ MIN_NATURAL_FREQUENCY=2.0, ζ=4.0 converges at frame 1256 / 20.9 s < MAX_FRAMES=2000.
 */
const MAX_DAMPING_RATIO = 4;

/**
 * Minimum allowed natural frequency ω₀ = sqrt(k/m) in rad/s.
 *
 * Wall-clock convergence time for overdamped springs is dominated by the SLOW mode:
 *   τ_slow = 1 / (ω₀·(ζ − √(ζ²−1)))
 * At worst case ζ=MAX_DAMPING_RATIO=4: ζ−√15 ≈ 0.2679, so τ_slow = 1/(ω₀·0.2679).
 *
 * drive() uses CONVERGENCE_THRESHOLD=0.5% relative and MAX_FRAMES=2000 (t≈33.3 s).
 * Binary-search over the closed-form solver shows the critical ω₀ (exactly at MAX_FRAMES)
 * is ≈ 1.2552 rad/s. A spring with ω₀ = 0.5 (the prior floor) converges at frame 5021
 * (83.7 s) — it ALWAYS snaps at MAX_FRAMES with a 12.2% visible jump.
 *
 * We raise the floor to 2.0 rad/s, verified to converge at ≤ 1256 frames for ALL
 * accepted (ω₀, ζ) pairs (see test/spring-low-omega0-wall-clock.test.ts worst-case probe).
 *
 * Physical meaning: ω₀ = 2.0 rad/s corresponds to period 2π/2 ≈ 3.1 s — still far
 * outside any reasonable UI animation intent.
 */
const MIN_NATURAL_FREQUENCY = 2.0; // rad/s — empirically verified floor

/**
 * Minimum allowed damping ratio (ζ). Below this the spring is near-undamped:
 * the decay envelope exp(-ζ·ω₀·t) is nearly flat and the 0.5% convergence threshold
 * is never reached within MAX_FRAMES regardless of ω₀.
 *
 * For underdamped decay, convergence requires:
 *   exp(-ζ·ω₀·t) < THRESHOLD  →  ζ·ω₀ > -ln(0.005)/33.33 ≈ 0.159 rad/s
 * At ω₀ = MIN_NATURAL_FREQUENCY = 2.0: ζ > 0.159/2.0 = 0.0795.
 *
 * We set MIN_DAMPING_RATIO = 0.2 (a practical UI lower bound verified to converge at
 * ≤ 1050 frames at ω₀=1.5; at ω₀=2.0 it converges at frame 844).
 * Practical meaning: ζ < 0.2 produces more than 10 underdamped oscillations — not a
 * useful UI motion.
 */
const MIN_DAMPING_RATIO = 0.2; // ζ floor — closes near-undamped stall class

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
    throw new MotionParamError(`spring: mass must be positive finite, got ${p.mass}`);
  }
  if (!Number.isFinite(p.stiffness) || p.stiffness <= 0) {
    throw new MotionParamError(
      `spring: stiffness must be positive finite, got ${p.stiffness}`,
    );
  }
  if (!Number.isFinite(p.damping) || p.damping < 0) {
    throw new MotionParamError(
      `spring: damping must be non-negative finite, got ${p.damping}`,
    );
  }
  // Guard 1: natural frequency floor — closes the slow-overdamped stall class.
  // Wall-clock convergence time ∝ 1/ω₀; a very soft/heavy spring (ω₀→0) hits
  // MAX_FRAMES (~33 s) and snaps. The prior floor of 0.5 rad/s was WRONG:
  // {m:1, k:0.25, c:4} has ω₀=0.5 exactly (accepts the guard) but converges at
  // frame 5021 (83.7 s), producing a 12.2% visible snap. Correct floor is 2.0 rad/s
  // (verified: worst-case ω₀=2.0, ζ=4 converges at frame 1256).
  // Тексты ошибок намеренно плотные (вес ядра): значение, порог, входы и
  // рекомендация сохранены; формулы/пояснения живут в доке и комментариях.
  const omega0 = Math.sqrt(p.stiffness / p.mass);
  const inputs = `(mass:${p.mass}, stiffness:${p.stiffness}, damping:${p.damping})`;
  if (omega0 < MIN_NATURAL_FREQUENCY) {
    throw new MotionParamError(
      `spring: natural frequency ω₀=${omega0.toFixed(4)} rad/s < min ${MIN_NATURAL_FREQUENCY} ${inputs} — increase stiffness or reduce mass.`,
    );
  }
  // Guard 2: damping ratio bounds — closes BOTH the extreme-overdamping and near-undamped classes.
  // High ζ (>MAX_DAMPING_RATIO): slow overdamped modes extend settling time.
  // Low ζ (<MIN_DAMPING_RATIO): near-undamped decay envelope almost flat; never converges within MAX_FRAMES.
  const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
  if (zeta > MAX_DAMPING_RATIO) {
    throw new MotionParamError(
      `spring: damping ratio ζ=${zeta.toFixed(2)} > max ${MAX_DAMPING_RATIO} ${inputs} — reduce damping or increase stiffness/mass.`,
    );
  }
  if (zeta < MIN_DAMPING_RATIO) {
    throw new MotionParamError(
      `spring: damping ratio ζ=${zeta.toFixed(4)} < min ${MIN_DAMPING_RATIO} ${inputs} — near-undamped spring never settles; increase damping.`,
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
  // Делегат к общему солверу (internal/solver.ts, v0=0 — частный случай):
  // формы решений символьно идентичны прежним построчным. Страж прежний
  // (clampFinite) — политика этого модуля, у motion-value своя.
  const { value, velocity } = solveSpring(params, t, 0);
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
