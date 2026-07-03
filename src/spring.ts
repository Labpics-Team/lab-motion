/**
 * spring.ts — L1 Domain: pure spring physics solver.
 *
 * Pure function of (params, t). No DOM, no clock, no window, no global state.
 * Invariants:
 *   2. CSS-safe: output is always finite (never NaN, never Infinity).
 *   3. Deterministic: identical (params, t) → identical output.
 *   5. Domain purity: no side effects; единственный импорт — внутренние
 *      константы контура кадра (бюджет валидатора выводится из них).
 *
 * Physics model:
 *   Underdamped / critically-damped / overdamped spring from rest (x=0)
 *   toward target (x=1), using the closed-form analytical solution.
 *   Normalized: from=0, to=1. Caller scales to [from, to].
 *
 * Time units: t is in seconds. Typical frame dt ≈ 0.016s (60fps).
 */

import { MotionParamError } from './errors.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from './internal/constants.js';
import { solveSpring } from './internal/solver.js';
import { type SpringParams } from './internal/types.js';

// Публичная точка типа — определение в internal/types.ts (разрыв модульного
// цикла spring ↔ solver), потребители продолжают импортировать отсюда.
export { type SpringParams };

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
 * Бюджет времени оседания (аудит 2026-07-03, дыра B): прежние КОРОБОЧНЫЕ полы
 * (ω₀ ≥ 2.0, 0.2 ≤ ζ ≤ 4) были маскировкой лимита MAX_FRAMES под «валидацию» —
 * они отвергали физически валидные пружины ({m:1,k:1,c:1}: ω₀=1, сходится за
 * ~11 с) и запрещали упругие ζ < 0.2 даже при большой ω₀ (rate = ζ·ω₀ высокая,
 * сходимость быстрая). Заменены ОДНИМ выведенным критерием: аналитическая
 * верхняя граница времени оседания медленной моды обязана помещаться в бюджет
 * кадра-капа.
 *
 *   rate  = ζ·ω₀ (underdamped) | ω₀·(ζ − √(ζ²−1)) (overdamped, медленный корень)
 *   amp   = 1/√(1−ζ²) | (ζ+√(ζ²−1))/(2√(ζ²−1))   (пик коэффициентов разложения;
 *           у ζ→1 факторизация вырождается — ζ_eff отводится на ±1e-3, истинный
 *           пик критической ветки ограничен)
 *   t_settle ≤ [ln(1/ε) + max(0, ln ω₀) + ln(max(1, amp))]/rate
 *           (ε — CONVERGENCE_THRESHOLD; ln ω₀ — скоростной критерий |v| < ε·range)
 *
 * Требование: t_settle ≤ MAX_FRAMES·FIXED_DT_S (≈33.3 с). Ноль коробочных
 * констант: бюджет выведен из уже существующих порогов контура кадра.
 */
const SETTLE_BUDGET_S = MAX_FRAMES * FIXED_DT_S;

/** Аналитическая верхняя граница времени оседания (сек) для валидных m/k/c. */
export function settleTimeUpperBound(p: SpringParams): number {
  const omega0 = Math.sqrt(p.stiffness / p.mass);
  // ζ = c/(2√(km)) = c/(2m·ω₀) — без второго sqrt (тождество √(km) = m·√(k/m)).
  const zetaRaw = p.damping / (2 * p.mass * omega0);
  // У ζ = 1 разложение на моды вырождено (см. solver) — отводим на ±1e-3.
  const zeta =
    Math.abs(zetaRaw - 1) < 1e-3 ? (zetaRaw < 1 ? 0.999 : 1.001) : zetaRaw;
  const under = zeta < 1;
  const d = Math.sqrt(Math.abs(zeta * zeta - 1)); // √|ζ²−1|: ωd/ω₀ | расщепление корней
  const rate = under ? zeta * omega0 : omega0 * (zeta - d);
  if (!(rate > 0)) return Infinity; // ζ=0: незатухающая — не оседает никогда
  const amp = under ? 1 / d : (zeta + d) / (2 * d);
  const needLn =
    Math.log(1 / CONVERGENCE_THRESHOLD) +
    Math.max(0, Math.log(omega0)) +
    Math.log(Math.max(1, amp));
  return needLn / rate;
}

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
  // Единый выведенный гард (взамен коробочных ω₀/ζ-полов, см. SETTLE_BUDGET_S):
  // аналитическое время оседания обязано помещаться в бюджет кадра-капа.
  const tSettle = settleTimeUpperBound(p);
  if (!(tSettle <= SETTLE_BUDGET_S)) {
    throw new MotionParamError(
      `spring: settle time ${Number.isFinite(tSettle) ? tSettle.toFixed(1) : '∞'}s > budget ${SETTLE_BUDGET_S.toFixed(1)}s (m:${p.mass} k:${p.stiffness} c:${p.damping}) — increase damping·ω₀`,
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
