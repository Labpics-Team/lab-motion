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
import type { MatchMediaLike } from './internal/media-query.js';
import { defaultRequestFrame } from './internal/request-frame.js';
import { solveSpring } from './internal/solver.js';
import { type SpringParams, validateSpringParams } from './spring.js';

/** Options for drive(). All platform seams are injectable for testing. */
export interface DriveOptions {
  /** Start value (e.g. CSS pixel offset at animation start). */
  readonly from: number;
  /** End value (e.g. CSS pixel offset at animation end). */
  readonly to: number;
  /** Spring physics parameters. */
  readonly spring: SpringParams;
  /**
   * Callback invoked on every animation step with the current interpolated value.
   * Called at most once when reduce=true (with the final `to` value).
   */
  readonly onStep: (value: number) => void;
  /**
   * Injectable matchMedia factory. Pass `window.matchMedia.bind(window)` in a
   * browser context. Pass a stub in tests. Pass `undefined` for SSR/Node —
   * the driver treats absence as "no preference" (reduce=false) and continues
   * without throwing.
   */
  readonly matchMedia?: MatchMediaLike | undefined;
  /**
   * Injectable requestAnimationFrame substitute. Receives a callback and returns
   * a handle. Defaults to the global `requestAnimationFrame` when omitted.
   * The callback may be called with or without a DOMHighResTimeStamp argument.
   * Tests inject a step clock (collects callbacks, advances them manually).
   * If the injected clock returns handle=0, a setTimeout(0) fallback is used
   * so the Promise always resolves (not deadlocked).
   */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /**
   * Clamp emitted values to [from, to] and monotonize toward `to`.
   *
   * Default `true` (legacy CSS-safe behaviour: never leaves the range —
   * required for physically bounded properties like opacity).
   *
   * `false` — honest spring: underdamped overshoot/bounce is EMITTED, not
   * absorbed. An underdamped spring (zeta < 1) physically overshoots the
   * target and oscillates — that is its visual identity; the default clamp
   * turns it into a monotone ease-out. With `clamp: false` values follow the
   * analytic trajectory exactly (still finite: the solver is closed-form),
   * convergence is decided by the raw distance-and-velocity threshold, and
   * the final emitted value is exactly `to`.
   */
  readonly clamp?: boolean | undefined;
  /**
   * Начальная скорость v0 (units value/s) на старте прогона. Default 0 —
   * рождение из покоя (прежнее поведение бит-в-бит).
   *
   * Опция — вход единого C¹-контракта (#93): приёмная пружина наследует
   * скорость источника (жест/decay/прерванный полёт) вместо жёсткого v0=0,
   * так что первая производная непрерывна на стыке. NaN/±Infinity →
   * MotionParamError рано (до создания Promise и планирования кадров).
   * Влияет ТОЛЬКО на начальное условие солвера — семантика clamp/сходимости/
   * settle и одноразовость прогона (drive не ретаргетится) не меняются.
   */
  readonly initialVelocity?: number | undefined;
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
 *
 * Единые значения контура ядра — internal/constants.ts (drive/driver/
 * motion-value обязаны сходиться по одинаковым порогам).
 */
import { CONVERGENCE_THRESHOLD, MAX_FRAMES, FIXED_DT_S } from './internal/constants.js';

/**
 * Read the reduced-motion preference from an injected matchMedia.
 * Returns false (= no preference) if matchMedia is absent or throws.
 */
function prefersReducedMotion(matchMedia: MatchMediaLike | undefined): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
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
  const { from, to, onStep, matchMedia, requestFrame } = opts;

  // Validate from/to — non-finite inputs (NaN, Infinity) would propagate
  // verbatim into onStep (consumer CSS) and cause isConverged() to return
  // false forever (NaN comparisons), running the loop to MAX_FRAMES = 2000.
  // Mirror the validation pattern in spring.ts validate().
  if (!Number.isFinite(from)) {
    throw new MotionParamError('LM023');
  }
  if (!Number.isFinite(to)) {
    throw new MotionParamError('LM024');
  }

  // v0 (C¹-хендофф, #93): валидируется так же рано, как from/to — non-finite
  // не должен дожить до нормировки v0/range (NaN молча расползся бы по солверу
  // и гонял бы цикл до MAX_FRAMES, тот же класс, что дыра from/to выше).
  const v0 = opts.initialVelocity ?? 0;
  if (!Number.isFinite(v0)) {
    throw new MotionParamError('LM025');
  }

  // Validate spring params synchronously at the drive() boundary — before any
  // Promise is constructed or frame scheduled. This makes invalid spring config
  // throw eagerly and deterministically regardless of the injected scheduler,
  // closing the class: the error contract is no longer scheduler-dependent.
  // Also enforces the damping-ratio cap so overdamped springs cannot reach
  // MAX_FRAMES (CPU stall + abrupt snap).
  validateSpringParams(opts.spring);

  // Fast path: from === to, nothing to animate.
  if (from === to) {
    return Promise.resolve();
  }

  // Clamping bounds (swapped for negative range).
  const range = to - from;
  // Clamp mode: default true (CSS-safe legacy); explicit false = honest spring.
  const bounded = opts.clamp !== false;

  // Один short-circuit на ДВЕ политики (одно тело вместо двух идентичных —
  // ужим под размерный гейт ядра, семантика бит-в-бит прежняя):
  // (1) L2 reduced-motion — проверяется однажды, на границе; (2) CSS-safety
  // guard overflow-диапазона: |from|+|to| > Number.MAX_VALUE → range = ±∞ —
  // плавная анимация непредставима (0*∞ = NaN при t=0). В обоих случаях —
  // единственный шаг onStep(to), ноль кадров (консистентно с MotionValue._tick).
  if (prefersReducedMotion(matchMedia) || !Number.isFinite(range)) {
    onStep(to);
    return Promise.resolve();
  }

  const lo = range >= 0 ? from : to;
  const hi = range >= 0 ? to : from;

  // Нормировка v0 в progress-пространство солвера (он решает 0→1): units/s ÷
  // range. range конечен и ненулевой (early-exit from===to и overflow-гард выше).
  const v0Normalized = v0 / range;

  // L4: platform driver — injected or fallback to the global rAF.
  const scheduleFrame: (cb: (ts?: number) => void) => number =
    requestFrame ?? defaultRequestFrame;

  return new Promise<void>((resolve) => {
    // Один буфер на запуск: солвер переписывает его на месте, поэтому горячий
    // кадр не создаёт короткоживущий объект и не давит на GC.
    const solved = { value: 0, velocity: v0Normalized };
    let settled = false;
    let frameCount = 0;
    let elapsedSeconds = 0;
    let startTs: number | undefined;
    // Track the highest emitted value (for from < to) so the sequence is
    // monotonically non-decreasing even when an underdamped spring oscillates
    // back after overshooting the clamped ceiling.
    let maxEmittedToward = from;

    function settle(): void {
      if (settled) return;
      settled = true;
      onStep(to);
      resolve();
    }

    // Single-flight guard: prevents two concurrent tick chains from mutating shared
    // state (frameCount, elapsedSeconds, maxEmittedToward) simultaneously.
    // Root cause of Finding 3: when handle===0 both scheduleFrame(tick) and
    // setTimeout(tick,0) fire — if the injected clock returns 0 AND later delivers
    // its callback (e.g. a draining clock whose scheduler happens to return 0 as a
    // valid handle), two independent tick loops run, double-emitting and double-
    // advancing the clock. The `settled` guard only blocks AFTER convergence, not
    // concurrent in-flight ticks. tickActive makes the tick body re-entrant-safe:
    // whichever invocation arrives second yields immediately and the active chain
    // reschedules itself normally.
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
      // Продвинуть часы (бывший advanceClock, единственный вызов — инлайн).
      if (ts !== undefined) {
        if (startTs === undefined) startTs = ts;
        elapsedSeconds = (ts - startTs) / 1000;
      } else {
        elapsedSeconds += FIXED_DT_S;
      }

      // ОДИН вызов солвера на кадр: прежние computeValue/computeVelocity/
      // isConverged делали до трёх идентичных вызовов чистой детерминированной
      // функции — значения бит-в-бит те же, машинерия втрое легче.
      // Канон солвера — solveSpring(params, t, v0) (internal/solver.ts, как в
      // projection/driver): при v0Normalized=0 формы бит-в-бит равны прежнему
      // springUnchecked-пути. Стражи конечности — на cv ниже (политика этого
      // модуля: снап в `to`, как MotionValue._tick).
      // spring params already validated synchronously at drive() entry above.
      const result = solveSpring(opts.spring, elapsedSeconds, v0Normalized, solved);
      const rawValue = from + result.value * range;
      // bounded=true (default): CSS-safe clamp to [from, to]. bounded=false:
      // honest trajectory — overshoot is the point, no clamp.
      const cv = bounded ? Math.max(lo, Math.min(hi, rawValue)) : rawValue;
      // absRange > 0 guaranteed by the from===to early-exit above.
      const absRange = Math.abs(range);

      // Convergence:
      // 1) Visual-saturation early-exit — once the monotone emitter has committed
      //    to `to` (maxEmittedToward === to), no value distinct from `to` can ever
      //    be emitted; the raw velocity tail beyond the clamp boundary is invisible
      //    (holding the Promise for it broke the resolution contract: an accepted
      //    underdamped spring at the floor zeta=0.2, omega0=2.0 kept it pending
      //    ~3.9s after visual completion).
      // 2) The threshold is range-independent: the position term is divided by
      //    absRange; velocity from solveSpring is already in normalized
      //    progress-space, so it is compared to the threshold directly.
      // The visual-saturation early-exit (maxEmittedToward === to) is a property
      // of the MONOTONE emitter only: with the clamp off, values legitimately
      // pass through `to` while the spring still carries velocity, so the
      // threshold test is the sole convergence criterion there.
      const converged =
        (bounded && maxEmittedToward === to) ||
        (Math.abs(cv - to) / absRange < CONVERGENCE_THRESHOLD &&
          Math.abs(result.velocity) < CONVERGENCE_THRESHOLD);

      // CSS-страж (инвариант 2) в том же снапе: сырой солвер с произвольным v0
      // может дать NaN/±∞ на экстремумах (переполнение денормализации при
      // clamp:false, вырожденный v0/range). Non-finite НЕ эмитится никогда —
      // единственный контрактно-безопасный исход — settle в (конечный) `to`.
      if (converged || frameCount >= MAX_FRAMES || !Number.isFinite(cv)) {
        settle();
        return;
      }

      if (bounded) {
        // Monotonize: for positive range, never emit below the running maximum.
        // For negative range, never emit above the running minimum.
        // This absorbs underdamped oscillation after the spring passes `to`.
        const monotoneValue =
          range >= 0 ? Math.max(cv, maxEmittedToward) : Math.min(cv, maxEmittedToward);
        maxEmittedToward = monotoneValue;
        onStep(monotoneValue);
      } else {
        // Honest spring: emit the trajectory as solved, bounce included.
        onStep(cv);
      }

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
    // This is the fix for the deadlock: the bootstrap handle was previously
    // discarded, so the handle=0 detection inside tick() was never reached.
    //
    // useTimeoutFallback is set before setTimeout fires, so tick() always reads
    // the correct scheduler on its first (and every subsequent) invocation.
    let useTimeoutFallback = false;
    if (scheduleFrame(tick) === 0) {
      useTimeoutFallback = true;
      setTimeout(tick, 0);
    }
  });
}
