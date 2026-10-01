/**
 * tween.ts — L1 Domain: pure linear interpolation.
 *
 * Pure function of (from, to, t). No DOM, no clock, no state.
 * Invariants:
 *   2. CSS-safe: output is always finite when inputs are finite.
 *   3. Deterministic: identical inputs → identical output.
 *   5. Domain purity: no external imports.
 */

/**
 * Linear interpolation between `from` and `to` at normalized time `t ∈ [0,1]`.
 *
 * Guarantees:
 *   tween(from, to, 0) === from   (exact, no floating-point drift)
 *   tween(from, to, 1) === to     (exact)
 *
 * Uses the numerically stable form:  from + (to - from) * t
 * At t=0: from + 0 = from (exact integer path when to-from is integer)
 * At t=1: from + (to - from) = to (exact by IEEE 754 for representable values)
 *
 * CSS-safety guard: when |from|+|to|>Number.MAX_VALUE the subtraction
 * (to-from) overflows to ±Infinity, making raw ±Infinity or NaN (0*∞=NaN at t≈0).
 * Fall back to the two-point form `from*(1-t)+to*t` which avoids the subtraction
 * and remains finite for all t∈(0,1) even when the range would overflow.
 */
export function tween(from: number, to: number, t: number): number {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const raw = from + (to - from) * t;
  if (!Number.isFinite(raw)) {
    const twoPoint = from * (1 - t) + to * t;
    return Number.isFinite(twoPoint) ? twoPoint : to;
  }
  return raw;
}
