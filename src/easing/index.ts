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
 *
 * Shape tags (NE3):
 *   MONOTONIC   — non-decreasing on [0,1]; asserted by dense-sample test
 *   OVERSHOOTING — may exceed [0,1]; bounded-finite, NOT asserted monotonic
 *   STEPPED     — discontinuous; output is finite, not continuous
 */

import { MotionParamError } from '../errors.js';
import { cubicBezierUnchecked } from '../internal/cubic-bezier.js';

// ---------------------------------------------------------------------------
// Internal guard — mirrors spring.ts clampFinite exactly
// ---------------------------------------------------------------------------

/**
 * Clamp a value to finite range.
 *
 * Mirrors spring.ts `clampFinite` exactly:
 *   - Finite → pass through unchanged
 *   - NaN → 0 (spring-at-rest position; safe CSS-default)
 *   - +Infinity → Number.MAX_VALUE
 *   - -Infinity → -Number.MAX_VALUE
 *
 * Private — not exported. Called inside normalizeEasing and all curve bodies.
 */
function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

// ---------------------------------------------------------------------------
// Public: normalizeEasing — NE1 harness for custom easings
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Endpoint guard — used by all continuous monotonic curves
// Mirrors tween.ts discipline: t<=0→0, t>=1→1, hostile t handled first.
// ---------------------------------------------------------------------------

/**
 * Returns 0 if t is before or at the start endpoint (including NaN, -Infinity),
 * returns 1 if t is at or beyond the end endpoint (+Infinity),
 * returns undefined otherwise (interior — caller computes).
 *
 * Private utility: avoids duplicating the t<=0/t>=1 pattern across every curve.
 * Covers NaN: NaN <= 0 is false, NaN >= 1 is false → falls through to formula.
 * NaN in formula for most trig fns → NaN output → clampFinite catches it.
 * So curves that call clampFinite on interior results are NE1-safe.
 */
function endpointOrUndefined(t: number): number | undefined {
  if (!Number.isFinite(t)) {
    // -Infinity → 0 (before start); +Infinity → 1 (after end); NaN → 0
    if (Number.isNaN(t)) return 0;
    return t > 0 ? 1 : 0;
  }
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return undefined; // interior: caller computes
}

// ---------------------------------------------------------------------------
// linear — NE3: MONOTONIC
// ---------------------------------------------------------------------------

/**
 * Linear easing: identity function on [0,1].
 *
 * linear(t) = t for t ∈ (0, 1)
 *
 * Shape: MONOTONIC
 * Canonical: identity — no external reference needed (definition is t).
 *
 * Invariants:
 *   NE2: linear(0) === 0 and linear(1) === 1 bit-exact (endpoint short-circuit)
 *   NE1: finite for ALL IEEE-754 inputs — handled inline (not via clampFinite):
 *        NaN     → 0  (clamped to start; NaN is neither ≤0 nor ≥1)
 *        -Infinity → 0  (before start)
 *        +Infinity → 1  (after end)
 *        t < 0   → 0  (clamp to start)
 *        t > 1   → 1  (clamp to end)
 *        interior: t (identity, always finite because t is finite here)
 *   NE4: pure, deterministic, no side effects
 */
export function linear(t: number): number {
  if (!Number.isFinite(t)) {
    if (Number.isNaN(t)) return 0;
    return t > 0 ? 1 : 0;
  }
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

// ---------------------------------------------------------------------------
// easeIn / easeOut / easeInOut — cubic (power(3))
// Shape: MONOTONIC
// Canonical: Robert Penner "Programming Macromedia Flash MX" (2002), Ch. 7.
// Same as power(3) In/Out/InOut but named for ergonomic default use.
// ---------------------------------------------------------------------------

/**
 * Ease-in cubic: slow start, fast end.
 * easeIn(t) = t³
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInCubic — t³
 */
export function easeIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return t * t * t;
}

/**
 * Ease-out cubic: fast start, slow end.
 * easeOut(t) = 1 − (1−t)³
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeOutCubic
 */
export function easeOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Ease-in-out cubic: slow start, fast middle, slow end.
 * easeInOut(t) = t < 0.5 ? 4t³ : 1 − (−2t+2)³/2
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInOutCubic
 */
export function easeInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return 4 * t * t * t;
  }
  const u = -2 * t + 2;
  return 1 - (u * u * u) / 2;
}

// ---------------------------------------------------------------------------
// sineIn / sineOut / sineInOut
// Shape: MONOTONIC
// Canonical: Penner (2002) easeInSine / easeOutSine / easeInOutSine
// ---------------------------------------------------------------------------

/**
 * Sine ease-in: gentle acceleration from zero.
 * sineIn(t) = 1 − cos(t * π/2)
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInSine
 */
export function sineIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(1 - Math.cos((t * Math.PI) / 2));
}

/**
 * Sine ease-out: gentle deceleration to zero.
 * sineOut(t) = sin(t * π/2)
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeOutSine
 */
export function sineOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(Math.sin((t * Math.PI) / 2));
}

/**
 * Sine ease-in-out: gentle S-curve.
 * sineInOut(t) = −(cos(π*t) − 1) / 2
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInOutSine
 */
export function sineInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(-(Math.cos(Math.PI * t) - 1) / 2);
}

// ---------------------------------------------------------------------------
// expoIn / expoOut / expoInOut — exponential
// Shape: MONOTONIC
// Canonical: Penner (2002) easeInExpo / easeOutExpo / easeInOutExpo
// ---------------------------------------------------------------------------

/**
 * Exponential ease-in: very slow start, extremely fast end.
 * expoIn(t) = 2^(10t − 10)
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInExpo
 */
export function expoIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(Math.pow(2, 10 * t - 10));
}

/**
 * Exponential ease-out: extremely fast start, very slow end.
 * expoOut(t) = 1 − 2^(−10t)
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeOutExpo
 */
export function expoOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(1 - Math.pow(2, -10 * t));
}

/**
 * Exponential ease-in-out.
 * expoInOut(t) = t < 0.5 ? 2^(20t−10)/2 : (2−2^(−20t+10))/2
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInOutExpo
 */
export function expoInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite(Math.pow(2, 20 * t - 10) / 2);
  }
  return clampFinite((2 - Math.pow(2, -20 * t + 10)) / 2);
}

// ---------------------------------------------------------------------------
// circIn / circOut / circIn Out — circular arc
// Shape: MONOTONIC
// Canonical: Penner (2002) easeInCirc / easeOutCirc / easeInOutCirc
// ---------------------------------------------------------------------------

/**
 * Circular ease-in: quarter-circle arc, slow start.
 * circIn(t) = 1 − √(1 − t²)
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInCirc
 */
export function circIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(1 - Math.sqrt(1 - t * t));
}

/**
 * Circular ease-out: quarter-circle arc, slow end.
 * circOut(t) = √(1 − (t−1)²)
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeOutCirc
 */
export function circOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  const u = t - 1;
  return clampFinite(Math.sqrt(1 - u * u));
}

/**
 * Circular ease-in-out: S-curve with circular arcs at both ends.
 * circInOut(t) = t < 0.5 ? (1−√(1−(2t)²))/2 : (√(1−(−2t+2)²)+1)/2
 *
 * Shape: MONOTONIC
 * Canonical: Penner (2002) easeInOutCirc
 */
export function circInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite((1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2);
  }
  return clampFinite((Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2);
}

// ---------------------------------------------------------------------------
// backIn / backOut / backInOut — overshoot (anticipate then overshoot)
// Shape: OVERSHOOTING — may go below 0 (backIn) or above 1 (backOut/backInOut)
// Endpoint exemption: backIn(1)===1 exact; backOut(0)===0 exact; but
// these curves overshoot on their respective sides.
// Canonical: Penner (2002) easeInBack / easeOutBack / easeInOutBack
// ---------------------------------------------------------------------------

// Penner back constant: c1 = 1.70158; c3 = c1 + 1
const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;
const BACK_C2 = BACK_C1 * 1.525;

/**
 * Back ease-in: anticipatory recoil before the main motion.
 * backIn(t) = c3·t³ − c1·t²
 *
 * Shape: OVERSHOOTING (dips below 0 briefly near start)
 * Canonical: Penner (2002) easeInBack, c1=1.70158
 *
 * Endpoint exemption (NE2): backIn(0)===0 exact; backIn(1)===1 exact.
 * The overshoot occurs in the interior (backIn dips negative for small t).
 */
export function backIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(BACK_C3 * t * t * t - BACK_C1 * t * t);
}

/**
 * Back ease-out: overshoot past target before settling.
 * backOut(t) = 1 + c3·(t−1)³ + c1·(t−1)²
 *
 * Shape: OVERSHOOTING (exceeds 1 briefly near end)
 * Canonical: Penner (2002) easeOutBack, c1=1.70158
 *
 * Endpoint exemption (NE2): backOut(0)===0 exact; backOut(1)===1 exact.
 * The overshoot occurs in the interior (backOut exceeds 1 for t near 1).
 */
export function backOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  const u = t - 1;
  return clampFinite(1 + BACK_C3 * u * u * u + BACK_C1 * u * u);
}

/**
 * Back ease-in-out: recoil at start + overshoot at end.
 * t < 0.5: uses scaled c2 constant for tighter effect
 * t >= 0.5: mirrored version
 *
 * Shape: OVERSHOOTING (dips below 0 at start, exceeds 1 at end)
 * Canonical: Penner (2002) easeInOutBack, c2=c1*1.525
 *
 * Endpoint exemption: backInOut(0)===0 exact; backInOut(1)===1 exact.
 */
export function backInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite((Math.pow(2 * t, 2) * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2);
  }
  return clampFinite(
    (Math.pow(2 * t - 2, 2) * ((BACK_C2 + 1) * (2 * t - 2) + BACK_C2) + 2) / 2,
  );
}

// ---------------------------------------------------------------------------
// anticipate — spring-like recoil: pulls back then launches forward
// Shape: OVERSHOOTING (dips negative at start)
// Canonical: Motion One / Framer Motion `anticipate` (GSAP community convention)
// Formula: t < 0.5 → backIn scaled; t >= 0.5 → easeOut scaled
// ---------------------------------------------------------------------------

/**
 * Anticipate: pulls back before launching — single recoil at start only.
 * This is the "anticipate" easing from Framer Motion / Motion One.
 * For t ∈ [0, 0.5]: scaled backIn (recoil phase)
 * For t ∈ [0.5, 1]: scaled easeOut (launch phase)
 *
 * Shape: OVERSHOOTING (goes negative in recoil phase)
 * Canonical: Framer Motion / Motion One `anticipate`; Penner-derived.
 *
 * Endpoint exemption: anticipate(0)===0 exact; anticipate(1)===1 exact.
 */
export function anticipate(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  // Scale t to [0,1] for each half, then blend.
  // Recoil half (t<0.5): scaled backIn (uses the back constants).
  // Launch half (t>=0.5): scaled easeOut cubic (no back overshoot).
  if (t < 0.5) {
    const t2 = 2 * t;
    return clampFinite((BACK_C3 * t2 * t2 * t2 - BACK_C1 * t2 * t2) / 2);
  }
  // easeOut (cubic) in the second half — maps [0.5,1] → [0,1] output.
  // Canonical: 0.5*easeOut(2t-1)+0.5 with easeOut(x)=1-(1-x)^3.
  const x = 2 * t - 1;
  const inv = 1 - x;
  return clampFinite(0.5 * (1 - inv * inv * inv) + 0.5);
}

// ---------------------------------------------------------------------------
// elastic — spring oscillation overshoot
// Shape: OVERSHOOTING
// Canonical: Penner (2002) easeInElastic / easeOutElastic; also Motion One.
// c4 = (2π)/3 period constant for the damped sine
// ---------------------------------------------------------------------------

const ELASTIC_C4 = (2 * Math.PI) / 3;
const ELASTIC_C5 = (2 * Math.PI) / 4.5;

/**
 * Elastic easing: spring-like oscillation that overshoots and bounces back.
 * Models the "elastic" easing as found in Motion One and Framer Motion.
 *
 * For t < 0.5: elasticIn-style (inverted oscillation at start)
 * For t >= 0.5: elasticOut-style (oscillation settling at end)
 *
 * elastic(t) for t ∈ (0,0.5):  −2^(20t−10)·sin((20t−11.125)·c5) / 2
 * elastic(t) for t ∈ [0.5,1):   2^(−20t+10)·sin((20t−11.125)·c5) / 2 + 1
 *
 * Shape: OVERSHOOTING (may dip below 0 or exceed 1)
 * Canonical: easings.net / Motion One `easeInOutElastic`, Penner-derived.
 *
 * Endpoint exemption: elastic(0)===0 exact; elastic(1)===1 exact.
 */
export function elastic(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite(-(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2);
  }
  return clampFinite(
    (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2 + 1,
  );
}

// ---------------------------------------------------------------------------
// bounce — bouncing ball simulation
// Shape: OVERSHOOTING (values stay ≥ 0 for bounceOut, ≤ 0 below for bounceIn)
// Actually bounce output stays in [0,1] — it's "bounded" but NOT monotonic.
// Canonical: Penner (2002) easeOutBounce (bounce = bounceInOut hybrid).
// ---------------------------------------------------------------------------

// Penner bounce constants
const BOUNCE_N1 = 7.5625;
const BOUNCE_D1 = 2.75;

/**
 * Core bounce-out formula (Penner): output always in [0,1].
 * bounceOut(t) = piecewise polynomial matching a bouncing ball decay.
 *
 * Canonical: Penner (2002) easeOutBounce.
 * NE1: output always in [0,1] for t ∈ [0,1]; endpoints: 0→0, 1→1 exact.
 */
function bounceOut(t: number): number {
  if (t < 1 / BOUNCE_D1) {
    return BOUNCE_N1 * t * t;
  }
  if (t < 2 / BOUNCE_D1) {
    const u = t - 1.5 / BOUNCE_D1;
    return BOUNCE_N1 * u * u + 0.75;
  }
  if (t < 2.5 / BOUNCE_D1) {
    const u = t - 2.25 / BOUNCE_D1;
    return BOUNCE_N1 * u * u + 0.9375;
  }
  const u = t - 2.625 / BOUNCE_D1;
  return BOUNCE_N1 * u * u + 0.984375;
}

/**
 * Bounce easing: bounceInOut — pull-back then bouncing landing.
 * For t < 0.5: bounceIn (inverted bounceOut) in first half
 * For t >= 0.5: bounceOut in second half
 *
 * Shape: OVERSHOOTING-like (values stay in [0,1] but non-monotonic)
 * Canonical: Penner (2002) easeInOutBounce.
 *
 * Endpoint exemption: bounce(0)===0 exact; bounce(1)===1 exact.
 * bounce is not monotonic — values oscillate — but is bounded to [0,1].
 */
export function bounce(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite((1 - bounceOut(1 - 2 * t)) / 2);
  }
  return clampFinite((1 + bounceOut(2 * t - 1)) / 2);
}

// ---------------------------------------------------------------------------
// power(exponent) factory — parametric polynomial easeIn
// Shape: MONOTONIC for exponent > 0; OVERSHOOTING for exponent < 0
// Canonical: Penner (2002) easeInCubic = power(3), quad = power(2), etc.
// quad = power(2), cubic = power(3), quart = power(4), quint = power(5)
// ---------------------------------------------------------------------------

/**
 * Factory: returns a power-easeIn curve t^p for the given exponent.
 *
 * power(p)(t) = t^p for t ∈ (0,1)
 *
 * Shape: MONOTONIC for p > 0 (non-decreasing); the In-style curve.
 * For p=1: linear; p=2: quad; p=3: cubic; p=4: quart; p=5: quint.
 * For non-integer exponents: smooth generalization of polynomial easing.
 *
 * NE7: rejects non-finite exponents via MotionParamError — NEVER returns NaN.
 * NE1: output is always finite (clampFinite for edge t values).
 * NE2: power(p)(0)===0 and power(p)(1)===1 bit-exact (endpoint short-circuit).
 *
 * Canonical: Penner (2002), generalized; Motion One `easeIn` factory.
 *
 * @param exponent - the power; must be a finite number
 * @returns easing function t^exponent, NE1-safe for all t
 * @throws MotionParamError if exponent is not finite
 */
export function power(exponent: number): (t: number) => number {
  if (!Number.isFinite(exponent)) {
    throw new MotionParamError('LM028');
  }
  return (t: number): number => {
    const ep = endpointOrUndefined(t);
    if (ep !== undefined) return ep;
    return clampFinite(Math.pow(t, exponent));
  };
}

// ---------------------------------------------------------------------------
// cubicBezier(x1, y1, x2, y2) factory — CSS cubic-bezier curve
// Shape: depends on control points; approximates CSS timing function
// Canonical: CSS Transitions Level 1 §2.2 / W3C; implemented via
//   Newton-Raphson with bisection fallback (same approach as Chrome's
//   CubicBezierTimingFunction and Framer Motion's bezier solver).
// ---------------------------------------------------------------------------

/**
 * Factory: returns a cubic-bezier easing matching the CSS cubic-bezier(x1,y1,x2,y2) curve.
 *
 * Implements the same Newton-Raphson + bisection bezier solver used by
 * Chrome's CubicBezierTimingFunction and Framer Motion's bezier utility.
 *
 * NE7: rejects non-finite control points via MotionParamError.
 * NE1: output is always finite (clampFinite; NaN→0, ±Inf→clamped).
 * NE2: cubicBezier(x1,y1,x2,y2)(0)===0 and (1)===1 exact.
 * NE4: deterministic — same input → same output bit-identical.
 *
 * Canonical: W3C CSS Transitions Level 1 §2.2; Chrome blink/CubicBezierTimingFunction.
 *
 * @param x1 - control point 1 x [0,1]
 * @param y1 - control point 1 y (unconstrained)
 * @param x2 - control point 2 x [0,1]
 * @param y2 - control point 2 y (unconstrained)
 * @returns easing function, NE1-safe for all t
 * @throws MotionParamError if any control point is non-finite
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    throw new MotionParamError('LM029');
  }
  // x1 and x2 must be in [0,1] — the Bezier x-component is only monotonic
  // (and thus invertible by the solver) when both x control points are in [0,1].
  // CSS cubic-bezier() rejects out-of-range x values for the same reason.
  // y1/y2 are unconstrained (allow overshoot).
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new MotionParamError('LM030');
  }

  // Linear fast path (x1===y1 && x2===y2 === the control points lie on diagonal)
  if (x1 === y1 && x2 === y2) {
    return linear;
  }

  return cubicBezierUnchecked(x1, y1, x2, y2);
}

// ---------------------------------------------------------------------------
// steps(n, position) factory — stepped/discrete easing
// Shape: STEPPED (discontinuous)
// Canonical: CSS Transitions Level 1 §2.3 / W3C; MDN step-timing-function.
// ---------------------------------------------------------------------------

/**
 * Step positions for steps() easing — mirrors CSS step-timing-function.
 * "start" = jump-start: first jump fires at the first interior t > 0
 *            (the endpoint t=0 is clamped to 0 by the NE2 hostile-t guard;
 *            CSS jump-start fires at t=0, but our guard fires first)
 * "end"   = jump-end: last jump at t=1 (default CSS behavior)
 */
export type StepPosition = 'start' | 'end';

/**
 * Factory: returns a stepped easing dividing progress into n discrete steps.
 *
 * steps(n, 'end')(t): floor(t*n)/n — steps at end of each interval (CSS default)
 * steps(n, 'start')(t): ceil(t*n)/n — steps at start of each interval
 *
 * NE7: rejects n <= 0 (or non-finite n) via MotionParamError.
 * NE1: output is always finite for all t (integer math, clamped).
 * NE2: endpoint behavior is documented below (steps is discontinuous).
 * NE4: deterministic — same (n, position, t) → same output bit-identical.
 *
 * Endpoint behavior (NE2 — endpoint short-circuit applies to all positions):
 *   'end':   steps(n,'end')(0)=0 exact (t<=0 short-circuit); steps(n,'end')(1)=1 exact
 *   'start': steps(n,'start')(0)=0 exact (t<=0 short-circuit, NOT 1/n);
 *            steps(n,'start')(1)=1 exact
 *   Both positions: t<=0→0 and t>=1→1 by the hostile-t guard, regardless of
 *   CSS jump-start semantics. The first visible step for 'start' occurs at the
 *   first interior t > 0.
 *
 * Canonical: W3C CSS Transitions Level 1 §2.3 step-timing-function.
 *
 * @param n - number of steps; must be a positive integer (n >= 1)
 * @param position - where steps occur: 'start' or 'end' (default 'end')
 * @returns stepped easing function, NE1-safe for all t
 * @throws MotionParamError if n is not a positive finite integer or position is invalid
 */
export function steps(n: number, position: StepPosition = 'end'): (t: number) => number {
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    throw new MotionParamError('LM031');
  }
  if (position !== 'start' && position !== 'end') {
    throw new MotionParamError('LM032');
  }

  return (t: number): number => {
    // Hostile t → endpoint
    if (!Number.isFinite(t)) {
      if (Number.isNaN(t)) return 0;
      return t > 0 ? 1 : 0;
    }
    if (t <= 0) return 0;
    if (t >= 1) return 1;

    if (position === 'start') {
      // jump-start: step occurs at the beginning of each interval
      // ceil(t * n) / n, clamped to [0,1]
      return clampFinite(Math.min(1, Math.ceil(t * n) / n));
    }
    // jump-end (default): step occurs at the end of each interval
    // floor(t * n) / n
    return clampFinite(Math.floor(t * n) / n);
  };
}
