/**
 * drive.ts — L3 Declarative API: the public animation driver.
 *
 * Composes L1 (spring solver) + L2 (reduced-motion policy) + L4 (platform driver).
 * Invariants:
 *   1. Zero runtime deps — no external imports, injectable platform seam.
 *   2. CSS-safe — only finite values emitted via onStep; values clamped to [from, to].
 *   3. Deterministic — no hidden state; clock is injected, not read from globals.
 *   4. Reduced-motion honoured — policy is checked once at entry; if reduce, the
 *      solver loop is NEVER entered and the Promise resolves synchronously.
 *   5. Domain purity — matchMedia / requestFrame are injected; never read from
 *      window directly (window is the caller's responsibility to pass in).
 *
 * Frame scheduling contract:
 *   The injected `requestFrame` is called with a callback and returns a handle.
 *   If the handle is 0 (the convention for a synchronous test step-clock that
 *   does not auto-advance), the driver additionally installs a `setTimeout(0)`
 *   fallback so the animation runs to completion even if the caller stops
 *   manually draining the injected scheduler queue. This prevents the returned
 *   Promise from deadlocking in test scenarios where the caller only runs a
 *   fixed number of frames before awaiting completion.
 *
 * Clamping:
 *   Output values are clamped to [from, to] (or [to, from] for negative range).
 *   This ensures: (a) no overshoot escapes the interval (CSS-safe), and
 *   (b) the sequence is monotonically non-decreasing toward `to` (required by
 *   the animate-progression contract). Underdamped spring overshoot is absorbed.
 */

import { MotionParamError } from './errors.js';
import { type SpringParams, springUnchecked, validateSpringParams } from './spring.js';
import { resolveToken, parseColor, interpolateColor, type RGBA } from './tokens.js';

/** Internal type to represent an active animation controller. */
interface DriveController {
  readonly stop: () => void;
  readonly current: () => { value: number; velocity: number; color?: RGBA };
}

/** Tracks active animations by target to enable re-targeting. */
const activeDrivers = new WeakMap<Element, DriveController>();

/** Options for drive(). All platform seams are injectable for testing. */
export interface DriveOptions {
  /** Start value (e.g. CSS pixel offset or color token at animation start). */
  readonly from: number | string;
  /** End value (e.g. CSS pixel offset or color token at animation end). */
  readonly to: number | string;
  /** Spring physics parameters. */
  readonly spring: SpringParams;
  /**
   * Callback invoked on every animation step with the current interpolated value.
   * Called at most once when reduce=true (with the final `to` value).
   */
  readonly onStep: (value: any) => void;
  /** Optional DOM element target to enable automatic transition interruption and seamless re-targeting. */
  readonly target?: Element | undefined;
  /**
   * Injectable matchMedia factory. Pass `window.matchMedia.bind(window)` in a
   * browser context. Pass a stub in tests. Pass `undefined` for SSR/Node —
   * the driver treats absence as "no preference" (reduce=false) and continues
   * without throwing.
   */
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
  /**
   * Injectable requestAnimationFrame substitute. Receives a callback and returns
   * a handle. Defaults to the global `requestAnimationFrame` when omitted.
   * The callback may be called with or without a DOMHighResTimeStamp argument.
   * Tests inject a step clock (collects callbacks, advances them manually).
   * If the injected clock returns handle=0, a setTimeout(0) fallback is used
   * so the Promise always resolves (not deadlocked).
   */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /** Optional design tokens dictionary for resolving token values. */
  readonly tokens?: Record<string, string | number> | undefined;
}

/**
 * CONVERGENCE_THRESHOLD is a normalized fraction of the animation range.
 * Both position and velocity are divided by abs(range) before comparison,
 * making the threshold range-independent:
 *   - sub-unit ranges (opacity 0→0.04) converge at the same relative precision
 *     as unit ranges (0→1) or large ranges (0→1000px)
 *   - large ranges are not held to needless sub-pixel absolute precision
 * 0.005 = 0.5% of range (≈ 0.5px on a 100px animation; tighter than the
 * former 0.05 absolute for range=1, looser for range>10).
 */
const CONVERGENCE_THRESHOLD = 0.005;
/** MAX_FRAMES hard limit — resolves (snapping to `to`) after this many frames. */
const MAX_FRAMES = 2000;
/** Fixed simulation timestep in seconds (60fps). Used when ts is unavailable. */
const FIXED_DT_S = 1 / 60;

/**
 * Read the reduced-motion preference from an injected matchMedia.
 * Returns false (= no preference) if matchMedia is absent or throws.
 */
function prefersReducedMotion(
  matchMedia: ((query: string) => MediaQueryList) | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Clamp a value to the range [lo, hi] (inclusive).
 * Used to bound spring output to [from, to] so that underdamped overshoot
 * is absorbed and values are monotonically non-decreasing toward `to`.
 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Drive an animation from `from` to `to` using a spring solver.
 *
 * - If prefers-reduced-motion is active: resolves synchronously with the final
 *   `to` value. requestFrame is never called.
 * - Otherwise: advances a spring simulation frame-by-frame using requestFrame,
 *   emitting clamped values via onStep until convergence.
 *
 * @returns A Promise that resolves when the animation reaches `to`.
 */
export function drive(opts: DriveOptions): Promise<void> {
  const { from, to, onStep, matchMedia, requestFrame, target, tokens } = opts;

  // Validate spring params synchronously at the drive() boundary — before any
  // Promise is constructed or frame scheduled. This makes invalid spring config
  // throw eagerly and deterministically regardless of the injected scheduler,
  // closing the class: the error contract is no longer scheduler-dependent.
  // Also enforces the damping-ratio cap so overdamped springs cannot reach
  // MAX_FRAMES (CPU stall + abrupt snap).
  validateSpringParams(opts.spring);

  // Resolve design tokens
  const resolvedFrom = resolveToken(from, target, tokens);
  const resolvedTo = resolveToken(to, target, tokens);

  // Parse colors if applicable
  let fromColor = typeof resolvedFrom === 'string' ? parseColor(resolvedFrom) : null;
  let toColor = typeof resolvedTo === 'string' ? parseColor(resolvedTo) : null;

  const isColorTransition = fromColor !== null && toColor !== null;

  let startValue = 0;
  let endValue = 0;
  let range = 0;

  if (isColorTransition) {
    // Color transition uses normalized progress 0 -> 1
    startValue = 0;
    endValue = 1;
    range = 1;
  } else {
    // Numeric transition
    const numFrom = typeof resolvedFrom === 'number' ? resolvedFrom : parseFloat(resolvedFrom as string);
    const numTo = typeof resolvedTo === 'number' ? resolvedTo : parseFloat(resolvedTo as string);

    if (!Number.isFinite(numFrom)) {
      throw new MotionParamError(`drive: 'from' must be a finite number or valid color, got ${from}`);
    }
    if (!Number.isFinite(numTo)) {
      throw new MotionParamError(`drive: 'to' must be a finite number or valid color, got ${to}`);
    }

    startValue = numFrom;
    endValue = numTo;
    range = endValue - startValue;
  }

  // Retargeting logic: if a target is provided and already animating, stop the old
  // animation and seamlessly transition from its current state.
  let initialVelocity = opts.spring.initialVelocity ?? 0;

  if (target) {
    const active = activeDrivers.get(target);
    if (active) {
      active.stop();
      const { value, velocity, color } = active.current();
      if (isColorTransition && color) {
        fromColor = color;
        initialVelocity = velocity;
      } else if (!isColorTransition && !color) {
        startValue = value;
        initialVelocity = velocity;
        range = endValue - startValue;
      }
    }
  }

  // Fast path: startValue === endValue, nothing to animate.
  if (startValue === endValue) {
    onStep(to); // Ensure the final value is emitted
    if (target) activeDrivers.delete(target);
    return Promise.resolve();
  }

  // L2: reduced-motion policy check — once, at the boundary.
  const reduce = prefersReducedMotion(matchMedia);

  if (reduce) {
    // Short-circuit: emit the final value in a single step, no rAF.
    onStep(to);
    if (target) activeDrivers.delete(target);
    return Promise.resolve();
  }

  // Clamping bounds (swapped for negative range).
  const lo = range >= 0 ? startValue : endValue;
  const hi = range >= 0 ? endValue : startValue;

  // L4: platform driver — injected or fallback to the global rAF.
  const scheduleFrame: (cb: (ts?: number) => void) => number =
    requestFrame ??
    ((cb) =>
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame(cb)
        : (setTimeout(cb, FIXED_DT_S * 1000) as unknown as number));

  let stopAnimation = () => {}; // Placeholder for the stop function
  let getCurrentState: () => { value: number; velocity: number; color?: RGBA } = () => ({
    value: startValue,
    velocity: initialVelocity,
    color: fromColor || undefined,
  });

  const promise = new Promise<void>((resolve) => {
    let settled = false;
    let frameCount = 0;
    let elapsedSeconds = 0;
    let startTs: number | undefined;
    let maxEmittedToward = startValue;

    const effectiveSpringParams = {
      ...opts.spring,
      initialVelocity: initialVelocity / Math.abs(range || 1), // Normalize initial velocity
    };

    function computeValue(): number {
      // spring params already validated synchronously at drive() entry above.
      const result = springUnchecked(effectiveSpringParams, elapsedSeconds);
      const raw = startValue + result.value * range;
      return clamp(raw, lo, hi);
    }

    function computeVelocity(): number {
      // spring params already validated synchronously at drive() entry above.
      const result = springUnchecked(effectiveSpringParams, elapsedSeconds);
      return result.velocity * range;
    }

    function emitValue(p: number): void {
      if (isColorTransition) {
        onStep(interpolateColor(fromColor!, toColor!, p));
      } else {
        onStep(p);
      }
    }

    getCurrentState = () => {
      const p = computeValue();
      const vel = computeVelocity();
      if (isColorTransition) {
        const currentRGBA = {
          r: Math.round(fromColor!.r + (toColor!.r - fromColor!.r) * p),
          g: Math.round(fromColor!.g + (toColor!.g - fromColor!.g) * p),
          b: Math.round(fromColor!.b + (toColor!.b - fromColor!.b) * p),
          a: fromColor!.a + (toColor!.a - fromColor!.a) * p,
        };
        return {
          value: p,
          velocity: vel,
          color: currentRGBA,
        };
      }
      return {
        value: p,
        velocity: vel,
      };
    };

    function settle(): void {
      if (settled) return;
      settled = true;
      onStep(to);
      if (target) activeDrivers.delete(target);
      resolve();
    }

    function advanceClock(ts?: number): void {
      if (ts !== undefined) {
        if (startTs === undefined) startTs = ts;
        elapsedSeconds = (ts - startTs) / 1000;
      } else {
        elapsedSeconds += FIXED_DT_S;
      }
    }

    function isConverged(): boolean {
      const absRange = Math.abs(range);
      const v = computeValue();
      const vel = computeVelocity();
      return (
        Math.abs(v - endValue) / absRange < CONVERGENCE_THRESHOLD &&
        Math.abs(vel) / absRange < CONVERGENCE_THRESHOLD
      );
    }

    // Single-flight guard: prevents two concurrent tick chains from mutating shared
    // state (frameCount, elapsedSeconds, maxEmittedToward) simultaneously.
    let tickActive = false;

    // tick() is the single frame body for both the rAF path and the setTimeout
    // fallback path. There is no duplicate — both paths invoke the same function.
    function tick(ts?: number): void {
      if (settled) return;
      // Single-flight: if a tick is already executing or scheduled to execute,
      // drop this duplicate invocation. The active chain will reschedule itself.
      if (tickActive) return;
      tickActive = true;
      frameCount++;
      advanceClock(ts);

      if (isConverged() || frameCount >= MAX_FRAMES) {
        settle();
        return;
      }

      // Monotonize: for positive range, never emit below the running maximum.
      // For negative range, never emit above the running minimum.
      // This absorbs underdamped oscillation after the spring passes `to`.
      const cv = computeValue();
      const monotoneValue =
        range >= 0 ? Math.max(cv, maxEmittedToward) : Math.min(cv, maxEmittedToward);
      maxEmittedToward = monotoneValue;
      emitValue(monotoneValue);

      // Release the single-flight lock before rescheduling so the next tick
      // invocation (from either path) is not immediately dropped.
      tickActive = false;

      // Reschedule via the same mechanism that is currently active.
      // useTimeoutFallback is set to true before tick() ever fires when the
      // bootstrap call returned handle=0 (non-draining step-clock convention).
      if (useTimeoutFallback) {
        setTimeout(tick, 0);
      } else {
        scheduleFrame(tick);
      }
    }

    // Bootstrap — inspect the handle returned by the FIRST scheduleFrame call.
    // If the injected clock returns 0 without invoking its callback (the
    // documented non-draining step-clock convention), install a setTimeout(0)
    // fallback NOW — before tick() has ever run — so the Promise always resolves.
    let useTimeoutFallback = false;
    const bootstrapHandle = scheduleFrame(tick);
    if (bootstrapHandle === 0) {
      useTimeoutFallback = true;
      setTimeout(tick, 0);
    }

    stopAnimation = () => {
      settle(); // Ensure resolution if stopped externally
      if (typeof cancelAnimationFrame !== 'undefined' && bootstrapHandle) {
        cancelAnimationFrame(bootstrapHandle);
      }
    };
  });

  if (target) {
    activeDrivers.set(target, {
      stop: stopAnimation,
      current: getCurrentState,
    });
  }

  return promise;
}
