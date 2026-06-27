/**
 * easing/index.ts — L1 Domain: pure easing functions.
 *
 * Pure functions of (t: number) → number. No DOM, no clock, no window, no global state.
 * Invariants:
 *   NE1. CSS-safe: output is always finite (never NaN, never Infinity, never -Infinity)
 *        for ALL inputs in IEEE-754, including t<0, t>1, NaN, ±Infinity, -0, subnormals.
 *   NE2. Endpoint correctness (continuous curves): easing(0)===0 and easing(1)===1
 *        bit-exact, mirroring tween.ts exact-endpoint discipline.
 *   NE4. Deterministic & pure: identical inputs → bit-identical outputs; zero runtime
 *        dependencies, no Math.random, no Date.now, no clock, no DOM.
 *
 * Finiteness guard mirrors spring.ts `clampFinite` semantics:
 *   Number.isFinite(x) → x unchanged
 *   NaN → 0          (safest CSS-safe fallback: spring-at-rest analogue)
 *   +Infinity → Number.MAX_VALUE
 *   -Infinity → -Number.MAX_VALUE
 *
 * Endpoint discipline mirrors tween.ts:
 *   t <= 0 → return 0 (exact, no drift)
 *   t >= 1 → return 1 (exact, no drift)
 *   interior: mathematical formula
 */

/**
 * Clamp a value to finite range.
 *
 * Mirrors spring.ts `clampFinite` exactly:
 *   - Finite → pass through unchanged
 *   - NaN → 0 (spring-at-rest position; safe CSS-default)
 *   - +Infinity → Number.MAX_VALUE
 *   - -Infinity → -Number.MAX_VALUE
 *
 * Private — not exported. Called inside normalizeEasing.
 */
function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/**
 * Wraps an arbitrary `(t: number) => number` easing and hardens its output
 * to satisfy NE1 (finiteness): any non-finite return value is clamped via
 * `clampFinite` semantics (NaN→0, ±Infinity→±MAX_VALUE).
 *
 * Well-behaved easings (finite output for all finite inputs) pass through
 * unchanged in value — the guard is transparent for them.
 *
 * Usage:
 *   const safe = normalizeEasing(myCustomEasing);
 *   safe(t); // always finite
 *
 * @param fn - any (t: number) => number easing; may return non-finite values
 * @returns a wrapped easing guaranteed to return a finite number for all t
 */
export function normalizeEasing(fn: (t: number) => number): (t: number) => number {
  return (t: number): number => clampFinite(fn(t));
}

/**
 * Linear easing: identity function on [0,1].
 *
 * linear(t) = t for t ∈ (0, 1)
 *
 * Invariants:
 *   NE2: linear(0) === 0 and linear(1) === 1 bit-exact (endpoint short-circuit)
 *   NE1: finite for all IEEE-754 inputs (t<0→0, t>1→1, NaN→0, ±Infinity→0 or 1)
 *   NE4: pure, deterministic, no side effects
 *
 * Endpoint discipline mirrors tween.ts:
 *   t <= 0 → 0 (exact)
 *   t >= 1 → 1 (exact)
 *   The short-circuit also handles NaN (NaN <= 0 is false, NaN >= 1 is false,
 *   so NaN falls through to `return t` which is NaN — caller must use
 *   normalizeEasing(linear) for full NE1 coverage with hostile inputs.
 *   `linear` alone is NE1-safe for finite inputs including t<0, t>1.)
 *
 * NaN handling: linear(NaN) === 0. NaN signals an indeterminate time position;
 * returning the start-of-animation value (0) is the safest CSS-safe fallback,
 * mirroring spring.ts clampFinite semantics (NaN→0). This makes linear itself
 * NE1-safe without needing a normalizer wrapper.
 */
export function linear(t: number): number {
  // NaN check first: NaN is not <=0 and not >=1, so explicit guard is required.
  // This makes linear NE1-safe for all IEEE-754 inputs.
  if (!Number.isFinite(t)) {
    // NaN → 0 (start-of-animation, safest fallback; mirrors clampFinite semantics)
    // +Infinity → 1 (t "beyond end" → end value)
    // -Infinity → 0 (t "before start" → start value)
    if (Number.isNaN(t)) return 0;
    return t > 0 ? 1 : 0;
  }
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}
