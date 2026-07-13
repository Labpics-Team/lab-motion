/**
 * motion-value.ts — L3 Headless reactive value driven by spring physics.
 *
 * A MotionValue holds a numeric value and animates it toward a target using
 * a spring solver. When the target changes mid-flight, the current velocity
 * is smoothly injected into the new spring run (no discontinuity / "jank").
 *
 * Invariants (matching the package-level invariants in index.ts):
 *   1. Zero runtime deps — no DOM, no window, no document, no Element.
 *   2. CSS-safe — only finite values emitted via onChange; never NaN/Infinity.
 *   3. Deterministic — clock is injected via requestFrame seam; no global reads.
 *   4. Smooth pickup — setTarget() mid-flight preserves the current velocity as
 *      the initial condition for the new spring run (closed-form solution with
 *      arbitrary initial velocity v0, not just v0=0).
 *   5. Domain purity — requestFrame is the only platform seam; injectable for
 *      tests. No _mockElement, no Element, no querySelector.
 *
 * Physics:
 *   Solves the spring ODE with general initial conditions x(0)=0, x'(0)=v0
 *   (normalized). The standard rest-to-target solution (v0=0) is a special case.
 *   All three regimes (underdamped, critically damped, overdamped) are handled.
 *
 * Frame scheduling:
 *   Reuses the same injectable requestFrame seam as drive.ts. If the injected
 *   clock returns handle=0 (non-draining test step-clock convention), a
 *   setTimeout(0) fallback is installed so the loop always makes progress.
 *   In production, pass `requestAnimationFrame.bind(window)`.
 */

import { type SpringParams, validateSpringParams } from './spring.js';
import { MotionParamError } from './errors.js';
import { solveSpring } from './internal/solver.js';

// ─── Public types ────────────────────────────────────────────────────────────

/** Injectable frame scheduler seam — same contract as in drive.ts. */
export type RequestFrameFn = (cb: (ts?: number) => void) => number;

/** Options for constructing a MotionValue. */
export interface MotionValueOptions {
  /** Initial numeric value. Must be finite. */
  readonly initial: number;
  /** Spring physics parameters. */
  readonly spring: SpringParams;
  /**
   * Injectable requestAnimationFrame substitute.
   * Receives a callback, returns a handle (0 = non-draining test step-clock).
   * If omitted, falls back to the global requestAnimationFrame (if available)
   * or a setTimeout(~16ms) shim for Node environments.
   */
  readonly requestFrame?: RequestFrameFn | undefined;
  /**
   * Clamp emitted values to [from, target].
   *
   * Default `true` (legacy CSS-safe behaviour — required for physically
   * bounded properties like opacity). `false` — honest spring: underdamped
   * overshoot/bounce is EMITTED (the analytic trajectory is followed
   * exactly); the final settle still emits exactly the target, and the
   * non-finite safety net stays in force.
   */
  readonly clamp?: boolean | undefined;
  /**
   * Начальная скорость (units/s) при рождении значения. По умолчанию 0.
   *
   * Нужна для C¹-хендоффа compositor→live (compositor/handoff.ts): live-пружина
   * рождается НЕ в покое, а в точке (value, velocity), снятой замкнутой формой с
   * compositor-трека — первый setTarget() подхватывает эту скорость через штатный
   * smooth-pickup (тот же solveSpring с произвольным v0), поэтому позиция И
   * скорость непрерывны. 0 = штатное рождение в покое (поведение без изменений).
   * NaN/±Infinity → MotionParamError синхронно (fail-fast, как initial/spring).
   */
  readonly initialVelocity?: number | undefined;
}

// ─── Frame-loop constants ────────────────────────────────────────────────────
// Модульные const (не private static): статики не матчат mangle-регэксп /^_/ и
// переживали минификацию дословно; модульный const терсер инлайнит/сжимает.
// Единый контур ядра: те же пороги, что drive/driver (internal/constants).
import { CONVERGENCE_THRESHOLD, MAX_FRAMES, FIXED_DT_S } from './internal/constants.js';

/**
 * Порог численной стабильности: величины меньше него трактуются как ноль.
 * Две роли (обе — защита от вырождения, значение общее): (1) «покой» — скорость
 * ниже EPSILON считается нулевой (snap-if-at-rest в setTarget); (2) знаменатель —
 * |range| ниже EPSILON вырожден, деление на него дало бы ±∞/NaN, поэтому диапазон
 * либо снапается, либо floor'ится к EPSILON. Локален модулю: деления на range в
 * drive/driver защищены early-exit `from === to` (absRange > 0 гарантирован
 * статически), им epsilon-пол не нужен — потому в общий internal/constants не вынесен.
 */
const EPSILON = 1e-10;

/**
 * Единый fail-fast страж конечности публичных числовых входов MotionValue:
 * NaN/±Infinity → MotionParamError синхронно (до Promise и до единого кадра).
 * Один throw-сайт вместо четырёх (initial/initialVelocity/setTarget/snapTo) —
 * заодно размерный шейв под гейт ядра (2220 gz ровно, без люфта).
 */
function assertFinite(v: number, label: string): number {
  if (!Number.isFinite(v)) {
    throw new MotionParamError('LM045');
  }
  return v;
}

// ─── MotionValue ─────────────────────────────────────────────────────────────

/**
 * A headless reactive numeric value that animates toward its target using
 * spring physics with smooth velocity pickup on re-target.
 *
 * Usage:
 *   const mv = new MotionValue({ initial: 0, spring: { mass:1, stiffness:200, damping:20 } });
 *   mv.onChange(v => element.style.opacity = String(v));
 *   mv.setTarget(1);   // starts animating toward 1
 *   mv.setTarget(0.5); // smooth pickup: continues with current velocity
 *   mv.destroy();      // stop and clean up
 */
export class MotionValue {
  // ── Internal state ──────────────────────────────────────────────────────

  /** Current output value (absolute, in caller's units). */
  declare private _value: number;
  /**
   * Current velocity (units/s, in caller's units).
   * Injected as v0 into the next spring run on setTarget().
   */
  declare private _velocity: number;

  /** Active spring params. */
  declare private readonly _spring: SpringParams;

  /** Клэмп-режим: true = легаси CSS-safe; false — честная пружина (overshoot эмитится). */
  declare private readonly _clamp: boolean;

  /** Injected frame scheduler. */
  declare private readonly _requestFrame: RequestFrameFn;

  /** Registered onChange subscribers. */
  private readonly _listeners: Set<(value: number) => void> = new Set();
  /** Caller-owned result солвера: один объект на значение вместо одного на кадр. */
  private readonly _solved = { value: 0, velocity: 0 };

  // ── Animation run state (reset on each setTarget) ───────────────────────

  /** Start value of the current run. */
  declare private _from: number;
  /** Target value of the current run. */
  declare private _target: number;
  /** Представимый solver-range; может быть на один ULP шире нулевого target-range. */
  declare private _range: number;
  /** Start velocity of the current run (normalized by range, for the solver). */
  declare private _v0Normalized: number;
  /** Elapsed seconds since the start of the current run. */
  private _elapsed: number = 0;
  /** Timestamp of the first frame in the current run. */
  declare private _startTs: number | undefined;

  /** Whether a frame loop is currently active. */
  private _running: boolean = false;
  /** Whether destroy() has been called. */
  private _destroyed: boolean = false;
  /** Single-flight re-entrancy guard for the tick body. */
  private _tickActive: boolean = false;
  /** Whether to use setTimeout fallback (handle=0 path). */
  private _useTimeoutFallback: boolean = false;

  /** Frame counter for the current run. */
  private _frameCount: number = 0;
  /**
   * Bumped by stop()/snapTo() to invalidate any frame already handed to the
   * injected requestFrame seam. The seam contract (RequestFrameFn) has no
   * cancel handle, so a frame scheduled before a stop()/snapTo() cannot be
   * pulled back out of the queue — instead each scheduled tick closure
   * captures the generation it was born into, and _tick() no-ops (does not
   * emit, does not reschedule) if that generation is stale. Without this,
   * stop() followed by a resuming setTarget() (or snapTo()) leaves the old
   * frame alive alongside the new one: both re-schedule themselves forever,
   * doubling the effective tick rate every frame (Lit hostDisconnected/
   * hostConnected churn, and reduced-motion mid-flight snaps, both do this).
   */
  private _generation: number = 0;

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(opts: MotionValueOptions) {
    // Цепочка присваиваний: value/from/target рождаются одним (проверенным)
    // числом — и это дешевле трёх чтений opts.initial под гейтом ядра.
    this._value = this._from = this._target = assertFinite(opts.initial, 'initial');
    validateSpringParams(opts.spring);
    this._spring = opts.spring;
    this._clamp = opts.clamp !== false;
    // Скорость рождения (units/s): подхватывается первым setTarget() через
    // smooth-pickup (C¹-хендофф compositor→live). Fail-fast (#93 срез 2, нота
    // CodeRabbit #112): NaN/±Infinity — не «нет сида», а ошибка вызова, как
    // initial/spring; молчаливое проглатывание маскировало бы битый донор
    // скорости (жест/decay/compositor-хендофф). Отсутствие опции = 0 (покой).
    this._velocity = assertFinite(opts.initialVelocity ?? 0, 'initialVelocity');
    this._requestFrame = opts.requestFrame ?? MotionValue._defaultRequestFrame;
  }

  /** Default requestFrame: global rAF or setTimeout(~16ms) shim for Node. */
  private static _defaultRequestFrame(cb: (ts?: number) => void): number {
    if (typeof requestAnimationFrame !== 'undefined') {
      return requestAnimationFrame(cb);
    }
    return setTimeout(cb, FIXED_DT_S * 1000) as unknown as number;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Returns the current value. Always finite. */
  get value(): number {
    return this._value;
  }

  /**
   * Текущая скорость (units/s). Всегда конечна (стражи _tick); в покое —
   * ровно 0 (рождение без initialVelocity, сходимость, snapTo).
   *
   * Зачем публично (#93, единый C¹-контракт): приёмник хендоффа (жест/decay/
   * другая пружина) читает пару (value, velocity) и наследует её как начальные
   * условия — без этого seam'а перехват в полёте стартовал бы из покоя
   * (видимый разрыв первой производной). Это АНАЛИТИЧЕСКАЯ скорость траектории
   * из солвера, не производная клампованного выхода (при clamp:true честный
   * hidden-state пружины — именно его и должен наследовать приёмник).
   */
  get velocity(): number {
    return this._velocity;
  }

  /**
   * Register a listener that receives every emitted value (including the
   * current value immediately on subscription).
   * Returns an unsubscribe function.
  */
  onChange(cb: (value: number) => void): () => void {
    const added = !this._listeners.has(cb);
    this._listeners.add(cb);
    // Подписка становится видимой только вместе с успешной первичной доставкой:
    // иначе бросивший callback навсегда отравляет каждый следующий кадр.
    try {
      cb(this._value);
    } catch (error) {
      // Повторный onChange того же callback не владеет старой Set-записью.
      if (added) this._listeners.delete(cb);
      throw error;
    }
    return () => {
      this._listeners.delete(cb);
    };
  }

  /**
   * Animate the value toward `target` using spring physics.
   *
   * If called while a previous animation is in flight, the current velocity
   * is smoothly carried over as the initial condition for the new run —
   * no discontinuity in the output sequence.
   *
   * @param target - Finite target value.
   */
  setTarget(target: number): void {
    if (this._destroyed) return;
    assertFinite(target, 'setTarget');

    // Snap instantly if already at target with negligible velocity.
    if (target === this._value && Math.abs(this._velocity) < EPSILON) {
      this._target = target;
      return;
    }

    // ── Smooth pickup: capture current velocity before resetting run state ──
    const currentVelocity = this._velocity; // units/s
    const targetRange = target - this._value;
    const range =
      !(Math.abs(targetRange) > EPSILON) && currentVelocity !== 0
        ? Math.sign(currentVelocity) * Math.max(
            EPSILON,
            Math.abs(this._value) * Number.EPSILON,
          )
        : targetRange;

    // Даже конечные операнды могут переполнить частное: солверу нельзя
    // передавать бесконечный v0 из узкого, но невырожденного диапазона.
    const normalized = currentVelocity / range;
    const v0Normalized = Number.isFinite(normalized) ? normalized : 0;

    // ── Reset run state ──────────────────────────────────────────────────
    this._from = this._value;
    this._target = target;
    this._range = range;
    this._v0Normalized = v0Normalized;
    this._elapsed = 0;
    this._startTs = undefined;
    this._frameCount = 0;
    this._useTimeoutFallback = false;

    // ── Start frame loop (idempotent: only one loop runs at a time) ──────
    if (!this._running) {
      this._running = true;
      this._schedule(this._generation);
    }
    // If already running, the active loop will pick up the new _target/_from/_v0Normalized
    // on its next tick (because it re-reads these fields). The loop is already scheduled.
  }

  /**
   * Stop the animation and remove all listeners.
   * After destroy(), setTarget() and onChange() are no-ops.
   */
  destroy(): void {
    this._destroyed = true;
    this._running = false;
    this._listeners.clear();
  }

  /**
   * Halt the running frame loop without destroying the instance: no further
   * ticks fire, but `_destroyed` stays false and listeners are kept — unlike
   * destroy(), a later setTarget() resumes animating normally. For consumers
   * whose host can disconnect and reconnect (e.g. Lit hostDisconnected/
   * hostConnected) without permanently killing the value.
   */
  stop(): void {
    this._running = false;
    this._startTs = undefined;
    this._elapsed = 0;
    this._generation++; // invalidate any frame already scheduled by this run
  }

  /**
   * Instantly set the value to `target`, bypassing spring physics: halts any
   * in-flight run and resyncs `_from`/`_target`/`_velocity` so a later
   * setTarget() starts a fresh, correct run instead of resuming from stale
   * mid-flight state. Backs the reduced-motion CHARACTER-switch in framework
   * bindings (e.g. lit/controller.ts) — the value still reaches its target
   * (not hard-off), it just skips the spring frames. A no-op after destroy().
   *
   * КОНТРАКТ идемпотентности: snapTo(target) в покое ровно на target —
   * no-op БЕЗ emit (паритет с setTarget, который в покое на target тоже не
   * эмитит). Биндингам нельзя опираться на snapTo(sameTarget) как на
   * форсированный re-render — штатный путь для этого host.requestUpdate().
   */
  snapTo(target: number): void {
    if (this._destroyed) return;
    assertFinite(target, 'snapTo');
    // Идемпотентность: уже покоимся ровно в target → нечего менять и незачем
    // эмитить (лишний requestUpdate у Lit-хоста). Живой ран в тот же target —
    // НЕ no-op: его надо прервать и снапнуть.
    if (!this._running && this._value === target && this._target === target) return;
    this._generation++; // invalidate any frame scheduled by the run being replaced
    this._running = false;
    this._startTs = undefined;
    this._elapsed = 0;
    this._frameCount = 0;
    this._value = target;
    this._from = target;
    this._target = target;
    this._range = 0;
    this._velocity = 0;
    this._emit(target);
  }

  // ── Private: animation loop ──────────────────────────────────────────────

  /**
   * Единственный планировщик кадра (первый кадр setTarget и re-schedule _tick —
   * бывшие две копии, ужим под гейт ядра): handle=0 = non-draining step-clock
   * (конвенция repo) → setTimeout(0)-fallback, дальше цикл живёт на нём.
   */
  private _schedule(gen: number): void {
    let sync = true;
    let called = false;
    let timestamp: number | undefined;
    try {
      if (this._useTimeoutFallback) {
        setTimeout(() => this._tick(undefined, gen), 0);
        return;
      }
      const handle = this._requestFrame((ts) => {
        if (sync) {
          called = true;
          timestamp = ts;
        } else if (!this._useTimeoutFallback) {
          this._tick(ts, gen);
        }
      });
      sync = false;
      if (called || handle === 0) {
        // Синхронный host и handle=0 сходятся в один trampoline; callback host-а
        // после возврата уже не может создать второй живой тик.
        this._useTimeoutFallback = true;
        setTimeout(() => this._tick(timestamp, gen), 0);
      }
    } catch (error) {
      if (gen === this._generation) {
        // Host мог поставить callback перед throw: новое поколение делает его
        // инертным, а running=false позволяет следующему setTarget повторить выдачу.
        this.stop();
      }
      throw error;
    }
  }

  private _tick(ts: number | undefined, gen: number): void {
    // A frame scheduled by a run that was since stop()/snapTo()-ed away is
    // stale: it must not emit and must not reschedule (see _generation doc).
    if (gen !== this._generation) return;
    if (!this._running) return;
    if (this._tickActive) return;
    this._tickActive = true;
    try {
      // Advance elapsed time.
      if (ts !== undefined) {
        if (this._startTs === undefined) this._startTs = ts;
        this._elapsed = (ts - this._startTs) / 1000;
      } else {
        this._elapsed += FIXED_DT_S;
      }

      this._frameCount++;

      const range = this._range;
      const absRange = Math.abs(range);

      // Общий солвер (internal/solver.ts) + стражи этого модуля инлайн
      // (value→1, velocity→0 — политика отличается от clampFinite spring.ts).
      const raw = solveSpring(this._spring, this._elapsed, this._v0Normalized, this._solved);
      const normPos = Number.isFinite(raw.value) ? raw.value : 1;
      const normVel = Number.isFinite(raw.velocity) ? raw.velocity : 0;

      // Denormalize: absolute value and velocity.
      const rawValue = this._from + normPos * range;
      const rawVelocity = normVel * range; // units/s

      // Check convergence or hard cap.
      // Единый epsilon-пол знаменателя (двойной Math.max свёрнут в const — ужим).
      const denom = Math.max(absRange, EPSILON);
      const converged =
        // Frame-cap страхует только застывший host-clock. При растущем времени
        // большой переносимый v0 вправе оседать дольше rest-бюджета.
        (this._frameCount >= MAX_FRAMES && this._elapsed <= 0) ||
        !Number.isFinite(range) || // unrepresentable span: |from|+|target| overflowed past MAX_VALUE
        // Реально крошечный span из покоя снапается как раньше. При живом
        // импульсе _range синтетически представим и эта ветка не съедает скорость.
        (absRange < EPSILON && this._v0Normalized === 0) ||
        (Math.abs(rawValue - (this._from + range)) / denom < CONVERGENCE_THRESHOLD &&
          Math.abs(rawVelocity) / denom < CONVERGENCE_THRESHOLD);

      // Emit value. bounded=true (default): CSS-safe clamp to [from, target].
      // bounded=false: honest trajectory — underdamped overshoot is emitted.
      const outputRange = this._target - this._from;
      const lo = outputRange >= 0 ? this._from : this._target;
      const hi = outputRange >= 0 ? this._target : this._from;
      const clampedValue = this._clamp ? Math.max(lo, Math.min(hi, rawValue)) : rawValue;

      // Единый снап-в-target: сходимость ИЛИ финальный CSS-страж (инвариант 2) —
      // даже конечный range может переполнить денормализацию в Inf/NaN на
      // экстремальных величинах; non-finite не эмитится НИКОГДА, единственный
      // контрактно-безопасный исход — снап в (валидированно-конечный) target.
      // Одно тело вместо двух идентичных (converged / non-finite) — семантика
      // бит-в-бит прежняя, ужим под размерный гейт ядра (срез #93).
      if (converged || !Number.isFinite(clampedValue) || !Number.isFinite(rawVelocity)) {
        this._value = this._target;
        this._velocity = 0;
        this._running = false;
        // Сохраняет прежнюю reentrant-семантику финального emit: синхронный
        // scheduler нового setTarget не должен увидеть guard старого рана.
        this._tickActive = false;
        this._emit(this._target);
        return;
      }

      this._value = clampedValue;
      this._velocity = rawVelocity;
      try {
        this._emit(clampedValue);
      } catch (primaryError) {
        // Сначала сохраняем живой ран; transactional _schedule сам сделает его
        // retryable при host-ошибке. Вторичная ошибка не маскирует listener RCA.
        if (gen === this._generation && this._running) {
          try { this._schedule(gen); } catch { /* первична listener-ошибка */ }
        }
        throw primaryError;
      }
      if (gen === this._generation && this._running) this._schedule(gen);
    } finally {
      this._tickActive = false;
    }
  }

  private _emit(value: number): void {
    let failed = false;
    let firstError: unknown;
    for (const cb of this._listeners) {
      try {
        cb(value);
      } catch (error) {
        // Set допускает удаление текущего элемента без snapshot-массива: соседям
        // всё ещё доставляется этот кадр, а дефектный callback больше не вызывается.
        this._listeners.delete(cb);
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }
}
