/**
 * utils/index.ts — L1 Domain: pure numeric value-mapping & math primitives.
 *
 * Subpath export: import { clamp, mix, wrap, snap, mapRange, interpolate, pipe }
 *                 from '@labpics/motion/utils'
 *
 * The primitives Framer Motion and GSAP ship at their core — a scalar remap
 * (`mapRange` / Framer `transform`), an N-stop piecewise mapper (`interpolate`),
 * range constraint (`clamp`), cyclic wrap (`wrap`), grid/target snapping (`snap`),
 * a total lerp (`mix`), and left-to-right composition (`pipe`). Pure math: no
 * DOM, no clock, no window, no global state.
 *
 * Invariants (same discipline as ./easing, ./value, ./stagger):
 *   U1. CSS-safe finiteness: every NUMERIC output is always finite (never NaN,
 *       never ±Infinity) for ALL IEEE-754 value inputs — <range, >range, NaN,
 *       ±Infinity, -0, subnormals. Guard is the module-private `clampFinite`,
 *       mirroring spring.ts exactly (NaN→0, +∞→MAX_VALUE, −∞→−MAX_VALUE).
 *   U2. Eager config validation: invalid CONFIG (bounds, increment, stops)
 *       throws MotionParamError synchronously at the boundary (mirrors easing
 *       power/steps/cubicBezier). The trailing VALUE argument NEVER throws — it
 *       is hardened by `clampFinite` instead.
 *   U3. Deterministic & pure: identical inputs → bit-identical outputs; zero
 *       runtime dependencies (only MotionParamError is imported), no Math.random,
 *       no Date.now, no clock, no DOM.
 *   U4. Bit-exact endpoints: mix/mapRange/interpolate resolve exact endpoints
 *       without float drift (short-circuits, not a+(b−a)·1).
 *   U5. Tree-shake isolation: private helpers are inlined (no cross-subpath
 *       import); mapRange does NOT route through the interpolate segment engine;
 *       interpolate's default mixer is the private `lerp`, not the public `mix` —
 *       so a single-symbol import stays a handful of bytes.
 *
 * The sole exception to U1 is `pipe`: a structural combinator that applies no
 * clampFinite (each composed stage owns its own finiteness). A pipeline built
 * from these primitives is finite by transitivity.
 */

import { MotionParamError } from '../errors.js';

// ---------------------------------------------------------------------------
// Private helpers — not exported (any leak trips the api-surface `extra` pin).
// ---------------------------------------------------------------------------

/**
 * Clamp a value to finite range. Mirrors spring.ts `clampFinite` exactly:
 *   Finite → pass through ; NaN → 0 ; +Infinity → MAX_VALUE ; −Infinity → −MAX_VALUE.
 * Branch order (isFinite, then isNaN, then sign) is load-bearing: collapsing the
 * NaN/sign branches would map NaN → −MAX_VALUE (NaN > 0 === false).
 */
function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/**
 * Linear interpolation with an overflow guard — the default numeric Mixer and
 * the interior of `mix`. The `t===0`/`t===1` short-circuits guarantee bit-exact
 * endpoints (`lerp(a,b,0)===a`, `lerp(a,b,1)===b`) even when `b - a` overflows to
 * ±Infinity — otherwise `∞*0 = NaN → 0` would break interior-breakpoint
 * exactness and terminal exactness under `clamp:false`. Shared by `mix` and
 * `interpolate` so neither import retains the other's public symbol (U5).
 */
function lerp(a: number, b: number, t: number): number {
  if (t === 0) return clampFinite(a);
  if (t === 1) return clampFinite(b);
  return clampFinite(a + (b - a) * t);
}

/** Общий страж конечности с code-only ошибкой LM110. */
function assertFinite(v: number, label: string): void {
  if (!Number.isFinite(v)) {
    throw new MotionParamError('LM110');
  }
}

/**
 * Nearest element of `targets` to `x` by absolute distance. Strict `<` so the
 * earliest (lowest-index) target wins ties. Result is clampFinite'd (no-op for
 * validated-finite targets, explicit for the contract).
 */
function nearestInArray(targets: readonly number[], x: number): number {
  let best = targets[0]!;
  let bestDist = Math.abs(x - best);
  for (let i = 1; i < targets.length; i++) {
    const d = Math.abs(x - targets[i]!);
    if (d < bestDist) {
      bestDist = d;
      best = targets[i]!;
    }
  }
  return clampFinite(best);
}

// ---------------------------------------------------------------------------
// Public type surface — erased at runtime (must NOT appear in Object.keys).
// ---------------------------------------------------------------------------

/** An easing function `(t) => t'`, matching the ./easing subpath shape. */
export type EasingFunction = (t: number) => number;

/**
 * A value mixer `(from, to, t) => value`. 3-arg DIRECT shape so ./value's
 * `mixColor(from, to, t)` drops in as `{ mixer: mixColor }` with zero adapter.
 * `mix` itself is a valid `Mixer<number>`.
 */
export type Mixer<T> = (from: T, to: T, t: number) => T;

/** Options for `interpolate`. */
export interface InterpolateOptions<T> {
  /** Clamp queries to the endpoints (default `true`, Framer parity). */
  readonly clamp?: boolean;
  /**
   * Easing applied to each segment's local progress. A single function eases
   * every segment; an array of length `input.length - 1` eases segment k with
   * `ease[k]`. Default: identity.
   */
  readonly ease?: EasingFunction | readonly EasingFunction[];
  /**
   * Custom value mixer — the only seam for non-numeric output (e.g. colors via
   * ./value's `mixColor`). Default: private numeric lerp.
   */
  readonly mixer?: Mixer<T>;
}

// ---------------------------------------------------------------------------
// clamp — constrain a value to [min, max]
// ---------------------------------------------------------------------------

/**
 * Constrain `value` to `[min, max]` = `min(max, max(min, value))` (Framer/GSAP).
 * Curried config-first: two args → reusable `(value) => number`; three args →
 * number. `min > max` deterministically yields `max` (Math.min wins), matching
 * Framer. Value is clampFinite'd before AND after the min/max, so even
 * pathological infinite bounds keep the output finite.
 *
 * The one exception to the finite-config rule: ±Infinity bounds ARE permitted
 * (the one-sided clamp idiom `clamp(0, Infinity, v)`); only NaN bounds throw.
 *
 * @throws MotionParamError if `min` or `max` is NaN.
 */
export function clamp(min: number, max: number): (value: number) => number;
export function clamp(min: number, max: number, value: number): number;
export function clamp(
  min: number,
  max: number,
  value?: number,
): number | ((value: number) => number) {
  if (Number.isNaN(min) || Number.isNaN(max)) {
    throw new MotionParamError('LM111');
  }
  const mapper = (v: number): number => clampFinite(Math.min(max, Math.max(min, clampFinite(v))));
  return value === undefined ? mapper : mapper(value);
}

// ---------------------------------------------------------------------------
// mix — total linear interpolation / extrapolation
// ---------------------------------------------------------------------------

/**
 * Unclamped linear interpolation: `from + (to - from) * progress`. `progress` is
 * NOT clamped to [0,1] — extrapolation is a feature. Bit-exact endpoints via
 * short-circuit (`progress === 0` → from, `progress === 1` → to). All three args
 * are clampFinite'd: NaN progress → 0 → returns `from`; ±Infinity progress →
 * ±MAX_VALUE → extrapolate-then-clamp; degenerate `mix(5,5,∞)` → 5.
 *
 * Also the canonical shape of `Mixer<number>` — pass it as `{ mixer: mix }`.
 * Never throws.
 */
export function mix(from: number, to: number, progress: number): number {
  const a = clampFinite(from);
  const b = clampFinite(to);
  const p = clampFinite(progress);
  if (p === 0) return a;
  if (p === 1) return b;
  return lerp(a, b, p);
}

// ---------------------------------------------------------------------------
// wrap — cyclic wrap into the half-open range [min, max)
// ---------------------------------------------------------------------------

/**
 * Cyclically wrap `value` into `[min, max)` via the double-modulo that corrects
 * JS `%` (dividend-signed) into a mathematical positive modulo, so negatives and
 * huge magnitudes wrap correctly. The `max` endpoint folds to `min` (half-open).
 * A degenerate range (`min === max`) short-circuits to `min` (dodges `% 0` → NaN).
 * Curried config-first. Canonical use assumes `min < max`.
 *
 * @throws MotionParamError if `min` or `max` is non-finite (NaN or ±Infinity) —
 *   a finite range is required for the modulo.
 */
export function wrap(min: number, max: number): (value: number) => number;
export function wrap(min: number, max: number, value: number): number;
export function wrap(
  min: number,
  max: number,
  value?: number,
): number | ((value: number) => number) {
  assertFinite(min, 'wrap min');
  assertFinite(max, 'wrap max');
  const span = max - min;
  const mapper = (v: number): number => {
    const x = clampFinite(v);
    if (span === 0) return clampFinite(min);
    return clampFinite(((((x - min) % span) + span) % span) + min);
  };
  return value === undefined ? mapper : mapper(value);
}

// ---------------------------------------------------------------------------
// snap — grid snap (increment) or nearest-of-set (targets)
// ---------------------------------------------------------------------------

/**
 * Snap `value` to a grid or a set. Two modes, dispatched by `Array.isArray`:
 *   INCREMENT: `round(value / increment) * increment`. Math.round rounds half
 *     toward +Infinity (round(2.5)=3, round(-2.5)=−2) — GSAP parity. Negative
 *     increments are legal (same lattice as `|increment|`).
 *   TARGETS: the nearest array element by `|value − target|`; ties resolve to
 *     the first (lowest-index) target.
 * Curried config-first. The value argument is clampFinite'd and never throws.
 *
 * @throws MotionParamError if increment is non-finite or zero, if the targets
 *   array is empty, or if any target element is non-finite.
 */
export function snap(target: number | readonly number[]): (value: number) => number;
export function snap(target: number | readonly number[], value: number): number;
export function snap(
  target: number | readonly number[],
  value?: number,
): number | ((value: number) => number) {
  let mapper: (v: number) => number;

  if (Array.isArray(target)) {
    // Snapshot before validating: the eager assertFinite loop then guards the
    // frozen copy, and the mapper is immune to post-build caller mutation (U3).
    const targets = (target as readonly number[]).slice();
    if (targets.length === 0) {
      throw new MotionParamError('LM112');
    }
    for (let i = 0; i < targets.length; i++) {
      assertFinite(targets[i]!, `snap targets[${i}]`);
    }
    mapper = (v: number): number => nearestInArray(targets, clampFinite(v));
  } else {
    const increment = target as number;
    assertFinite(increment, 'snap increment');
    if (increment === 0) {
      throw new MotionParamError('LM113');
    }
    mapper = (v: number): number =>
      clampFinite(Math.round(clampFinite(v) / increment) * increment);
  }

  return value === undefined ? mapper : mapper(value);
}

// ---------------------------------------------------------------------------
// mapRange — single-segment unclamped linear remap (GSAP mapRange)
// ---------------------------------------------------------------------------

/**
 * Remap `value` from `[inMin, inMax]` onto `[outMin, outMax]`, UNCLAMPED
 * (extrapolates outside the input range — that is `interpolate`'s job to clamp).
 * Bit-exact endpoints; a degenerate input range (`inMin === inMax`) yields
 * `outMin` (dodges `/ 0`). Curried config-first. STANDALONE — does not route
 * through the interpolate segment engine, so a `mapRange` import tree-shakes to
 * a few bytes (U5).
 *
 * @throws MotionParamError if any of the four bounds is non-finite.
 */
export function mapRange(
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): (value: number) => number;
export function mapRange(
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  value: number,
): number;
export function mapRange(
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  value?: number,
): number | ((value: number) => number) {
  assertFinite(inMin, 'mapRange inMin');
  assertFinite(inMax, 'mapRange inMax');
  assertFinite(outMin, 'mapRange outMin');
  assertFinite(outMax, 'mapRange outMax');
  const inSpan = inMax - inMin;
  const mapper = (v: number): number => {
    const x = clampFinite(v);
    if (inSpan === 0) return clampFinite(outMin);
    if (x === inMin) return clampFinite(outMin);
    if (x === inMax) return clampFinite(outMax);
    return clampFinite(outMin + ((x - inMin) / inSpan) * (outMax - outMin));
  };
  return value === undefined ? mapper : mapper(value);
}

// ---------------------------------------------------------------------------
// interpolate — N-stop piecewise mapper (Framer transform / GSAP array-interp)
// ---------------------------------------------------------------------------

/**
 * Build a mapper `(v) => value` from N breakpoints. `input` must be strictly
 * increasing with `input.length === output.length >= 2`. On a query `v`:
 *   1. `v` is clampFinite'd to `x`.
 *   2. If `clamp` (default true) and `x` is at/beyond an end, the endpoint's
 *      output is returned directly with no ease/mixer call (numeric endpoints
 *      are clampFinite'd for U1; non-numeric `T` endpoints pass through verbatim).
 *   3. The containing segment `k` is located; local progress
 *      `p = (x - input[k]) / (input[k+1] - input[k])` (with `clamp:false`, `p`
 *      may be <0 or >1 → extrapolation).
 *   4. `p` is eased (`ease` single or per-segment), then the value is produced
 *      by `mixer(output[k], output[k+1], easedP)` (default: numeric lerp).
 *   5. Numeric outputs are clampFinite'd (U1); a custom mixer's output is the
 *      mixer's own finiteness contract (e.g. ./value's mixColor is CSS-safe).
 *
 * Interior breakpoints resolve as `p = 0` of the right-hand segment → bit-exact
 * `output[k]` when `ease(0) === 0` and `mixer(a,b,0) === a` (holds for house
 * easings and the default). Equivalent to Framer `transform(input, output, opts)`
 * whenever the ease/mixer ANCHORS its endpoints (`ease(0)=0`, `ease(1)=1`,
 * `mixer(a,b,0)=a`, `mixer(a,b,1)=b`) — true for every house easing and the
 * default identity/lerp. A non-anchoring custom ease/mixer diverges only at the
 * two clamped OUTER endpoints, which short-circuit without applying it (the price
 * of the U4 bit-exact-endpoint guarantee); interior breakpoints still apply it.
 *
 * `input`/`output` are snapshotted at factory time, so the returned mapper is
 * pure with respect to later mutation of the caller's arrays (U3).
 *
 * @throws MotionParamError (eager, at factory time) on: length mismatch;
 *   fewer than 2 stops; a non-finite input; input not strictly increasing; an
 *   `ease` array whose length ≠ segment count or containing a non-function
 *   element; or (numeric path only, no mixer) a non-finite output. The returned
 *   mapper never throws.
 */
export function interpolate(
  input: readonly number[],
  output: readonly number[],
  options?: InterpolateOptions<number>,
): (v: number) => number;
export function interpolate<T>(
  input: readonly number[],
  output: readonly T[],
  options: InterpolateOptions<T> & { mixer: Mixer<T> },
): (v: number) => T;
export function interpolate<T>(
  input: readonly number[],
  output: readonly T[],
  options: InterpolateOptions<T> = {},
): (v: number) => T {
  // Snapshot input/output once so the returned mapper is pure w.r.t. later
  // caller mutation (U3): endpoints AND interior read the same frozen copies,
  // and the eager validation below guards exactly what the mapper will use.
  const inp = input.slice();
  const outp = output.slice();
  const last = inp.length - 1;

  if (inp.length !== outp.length) {
    throw new MotionParamError('LM114');
  }
  if (inp.length < 2) {
    throw new MotionParamError('LM115');
  }
  for (let i = 0; i < inp.length; i++) {
    assertFinite(inp[i]!, `interpolate input[${i}]`);
  }
  for (let i = 0; i < last; i++) {
    if (inp[i]! >= inp[i + 1]!) {
      throw new MotionParamError('LM116');
    }
  }

  const { clamp: doClamp = true, ease, mixer } = options;

  const easeArr = Array.isArray(ease) ? (ease as readonly EasingFunction[]) : undefined;
  const easeFn = easeArr ? undefined : (ease as EasingFunction | undefined);
  if (easeArr) {
    if (easeArr.length !== last) {
      throw new MotionParamError('LM117');
    }
    // Eager U2: every ease element must be callable — otherwise a non-function
    // defers to a raw TypeError on the value path instead of a boundary error.
    for (let i = 0; i < easeArr.length; i++) {
      if (typeof easeArr[i] !== 'function') {
        throw new MotionParamError('LM118');
      }
    }
  }

  // Numeric path only (no custom mixer): pin output finiteness eagerly.
  if (mixer === undefined) {
    for (let i = 0; i < outp.length; i++) {
      assertFinite(outp[i] as unknown as number, `interpolate output[${i}]`);
    }
  }

  const in0 = inp[0]!;
  const inLast = inp[last]!;
  const out0 = outp[0]!;
  const outLast = outp[last]!;

  return (v: number): T => {
    const x = clampFinite(v);

    if (doClamp) {
      // Numeric endpoints are clampFinite'd (U1): a custom mixer skips the eager
      // output validation, so a non-finite numeric endpoint must be sanitized
      // here too — consistent with the interior path. Non-numeric T: verbatim.
      if (x <= in0) return typeof out0 === 'number' ? (clampFinite(out0 as unknown as number) as unknown as T) : out0;
      if (x >= inLast) return typeof outLast === 'number' ? (clampFinite(outLast as unknown as number) as unknown as T) : outLast;
    }

    // Locate segment k such that inp[k] <= x < inp[k+1] (below-range → k=0,
    // above-range → k=last-1, both giving out-of-[0,1] progress for clamp:false).
    let k = 0;
    if (last > 9) {
      // Длинные шкалы ищем за O(log N); на коротких линейный цикл быстрее из-за ветвлений.
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >>> 1;
        if (x < inp[mid]!) hi = mid;
        else lo = mid;
      }
      k = lo;
    } else {
      while (k < last - 1 && x >= inp[k + 1]!) k++;
    }

    const denom = inp[k + 1]! - inp[k]!; // > 0 by strictly-increasing check
    const p = (x - inp[k]!) / denom;
    const e = easeArr ? easeArr[k] : easeFn;
    const pe = e ? e(p) : p;
    const m = mixer
      ? mixer(outp[k]!, outp[k + 1]!, pe)
      : (lerp(outp[k] as unknown as number, outp[k + 1] as unknown as number, pe) as unknown as T);
    return typeof m === 'number' ? (clampFinite(m) as unknown as T) : m;
  };
}

// ---------------------------------------------------------------------------
// pipe — left-to-right function composition
// ---------------------------------------------------------------------------

/**
 * Compose functions left-to-right: `pipe(f, g, h)(v) === h(g(f(v)))`.
 * `pipe()` is the identity. Heterogeneous overloads (arity 1–3) give precise
 * cross-type inference; a homogeneous `<T>(...fns)` fallback covers the rest.
 * A structural combinator — applies NO clampFinite (each stage owns its own
 * finiteness). Never throws.
 */
export function pipe<A, B>(f1: (a: A) => B): (a: A) => B;
export function pipe<A, B, C>(f1: (a: A) => B, f2: (b: B) => C): (a: A) => C;
export function pipe<A, B, C, D>(
  f1: (a: A) => B,
  f2: (b: B) => C,
  f3: (c: C) => D,
): (a: A) => D;
export function pipe<T>(...fns: Array<(value: T) => T>): (value: T) => T;
export function pipe(
  ...fns: Array<(value: unknown) => unknown>
): (value: unknown) => unknown {
  if (fns.length === 0) return (x: unknown): unknown => x;
  return (x: unknown): unknown => {
    let acc = x;
    for (let i = 0; i < fns.length; i++) acc = fns[i]!(acc);
    return acc;
  };
}
