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

import { type SpringParams, validateSpringForFrameLoop } from './spring.js';
import { MotionParamError } from './errors.js';
import { defaultRequestFrame } from './internal/request-frame.js';
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

/** Синхронный output-сcratch солвера: _tick копирует оба числа до callback-границы. */
const solverSample = { value: 0, velocity: 0 };

/** Терминальная отписка не удерживает экземпляр или callback новой подписки. */
const noopUnsubscribe = () => {};

/**
 * Единый fail-fast страж конечности публичных числовых входов MotionValue:
 * NaN/±Infinity → MotionParamError синхронно (до Promise и до единого кадра).
 * Один throw-сайт не даёт четырём публичным входам разойтись в политике.
 */
function assertFinite(v: number): number {
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

  /** Пользовательские параметры; null означает необратимо завершённого владельца. */
  declare private _spring: SpringParams | null;

  /** Клэмп-режим: true = легаси CSS-safe; false — честная пружина (overshoot эмитится). */
  declare private readonly _clamp: boolean;

  /** Планировщик живого владельца; null после destroy(). */
  declare private _requestFrame: RequestFrameFn | null;

  /** Реестр callback и его единственной функции отзыва. */
  private readonly _listeners = new Map<(value: number) => void, () => void>();

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
  declare private _elapsed: number;
  /** Начало текущей траектории в timestamp-координате инжектированного клока. */
  declare private _startTs: number | undefined;

  /**
   * Объект принадлежит одному активному циклу; null означает покой.
   * Только setTarget создаёт его после проверки живого владельца, поэтому
   * активный цикл всегда имеет spring и scheduler. Отзыв перед очисткой
   * отсекает уже выданные host callbacks, даже после следующего запуска.
   */
  private _run: object | null = null;
  /** Single-flight re-entrancy guard for the tick body. */
  private _tickActive: boolean = false;
  /** Whether to use setTimeout fallback (handle=0 path). */
  private _useTimeoutFallback: boolean = false;

  /** Frame counter for the current run. */
  declare private _frameCount: number;

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(opts: MotionValueOptions) {
    // В покое существует только наблюдаемый snapshot. Поля траектории
    // инициализирует setTarget до первого обращения к планировщику.
    this._value = this._target = assertFinite(opts.initial);
    validateSpringForFrameLoop(opts.spring);
    this._spring = opts.spring;
    this._clamp = opts.clamp !== false;
    // Скорость рождения (units/s): подхватывается первым setTarget() через
    // smooth-pickup (C¹-хендофф compositor→live). Fail-fast (#93 срез 2, нота
    // CodeRabbit #112): NaN/±Infinity — не «нет сида», а ошибка вызова, как
    // initial/spring; молчаливое проглатывание маскировало бы битый донор
    // скорости (жест/decay/compositor-хендофф). Отсутствие опции = 0 (покой).
    this._velocity = assertFinite(opts.initialVelocity ?? 0);
    this._requestFrame = opts.requestFrame ?? defaultRequestFrame;
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
    if (!this._spring) return noopUnsubscribe;
    let listeners: typeof this._listeners | null = this._listeners;
    const existing = listeners.get(cb);
    if (existing) {
      // Повторная доставка не владеет существующей подпиской.
      cb(this._value);
      return existing;
    }
    const off = () => {
      // Отзыв освобождает оба захвата; старый handle не удаляет новую подписку.
      listeners?.delete(cb);
      listeners = null;
      cb = noopUnsubscribe;
    };
    listeners.set(cb, off);
    // Подписка становится видимой только вместе с успешной первичной доставкой.
    try {
      cb(this._value);
    } catch (error) {
      off();
      throw error;
    }
    return off;
  }

  /**
   * Animate the value toward `target` using spring physics.
   *
   * If called while a previous animation is in flight, the current velocity
   * is smoothly carried over as the initial condition for the new run —
   * no discontinuity in the output sequence.
   *
   * В активном движении origin берётся из последнего опубликованного кадра.
   * Следующий timestamp учитывает время после него, а не начинает отсчёт снова.
   * Повтор активной цели — no-op; пачка целей между кадрами оставляет последнюю.
   * Без timestamp каждый callback по-прежнему продвигает FIXED_DT.
   *
   * @param target - Finite target value.
   */
  setTarget(target: number): void {
    if (!this._spring) return;
    assertFinite(target);

    // Повтор цели сохраняет подготовленную траекторию и её часы. Проверка
    // активного цикла важна: stop() не запрещает снова двигаться к той же цели.
    if (this._run && target === this._target) return;

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
    // Новый origin принадлежит последнему опубликованному snapshot, а не
    // будущему callback. Иначе поток setTarget перед каждым кадром навсегда
    // держит elapsed=0. Глобальные часы не читаются; до первого кадра epoch нет.
    this._startTs = this._run && this._startTs !== undefined
      ? this._startTs + this._elapsed * 1000
      : undefined;
    this._elapsed = 0;
    this._frameCount = 0;

    // ── Start frame loop (idempotent: only one loop runs at a time) ──────
    if (!this._run) {
      this._useTimeoutFallback = false;
      // Новый цикл не наследует guard отозванного tick, ещё исполняющего getter/listener.
      this._tickActive = false;
      this._run = {};
      this._schedule(this._run);
    }
    // If already running, the active loop will pick up the new _target/_from/_v0Normalized
    // on its next tick (because it re-reads these fields). The loop is already scheduled.
  }

  /**
   * Stop the animation and remove all listeners.
   * After destroy(), setTarget() and onChange() are no-ops.
   */
  destroy(): void {
    this._run = null;
    // Параметры могут содержать ссылки на компонент; terminal больше не исполняет физику.
    this._spring = this._requestFrame = null;
    this._listeners.forEach((off) => off());
  }

  /**
   * Останавливает текущий цикл, сохраняя параметры пружины и подписки.
   * Следующий setTarget возобновляет движение. Подходит для временного
   * отключения хоста (например, Lit hostDisconnected/hostConnected);
   * необратимое завершение остаётся за destroy().
   */
  stop(): void {
    this._run = null;
    // Не сбрасываем неактивную траекторию: следующий setTarget — её единственный
    // инициализатор. Отозванный объект отсекает callback до чтения её полей.
  }

  /**
   * Instantly set the value to `target`, bypassing spring physics: halts any
   * in-flight run and publishes the new value, target and zero velocity.
   * A later setTarget() initializes its trajectory from that snapshot, never
   * from inactive run parameters. Backs the reduced-motion CHARACTER-switch in framework
   * bindings (e.g. lit/controller.ts) — the value still reaches its target
   * (not hard-off), it just skips the spring frames. A no-op after destroy().
   *
   * КОНТРАКТ идемпотентности: snapTo(target) в покое ровно на target —
   * no-op БЕЗ emit (паритет с setTarget, который в покое на target тоже не
   * эмитит). Биндингам нельзя опираться на snapTo(sameTarget) как на
   * форсированный re-render — штатный путь для этого host.requestUpdate().
   */
  snapTo(target: number): void {
    if (!this._spring) return;
    assertFinite(target);
    // Идемпотентность: уже покоимся ровно в target → нечего менять и незачем
    // эмитить (лишний requestUpdate у Lit-хоста). Живой ран в тот же target —
    // НЕ no-op: его надо прервать и снапнуть.
    if (!this._run && this._value === target && this._target === target) return;
    this._run = null;
    this._value = target;
    this._target = target;
    this._velocity = 0;
    this._emit(target);
  }

  // ── Private: animation loop ──────────────────────────────────────────────

  /**
   * Единственный планировщик кадра (первый кадр setTarget и re-schedule _tick —
   * бывшие две копии, ужим под гейт ядра): handle=0 = non-draining step-clock
   * (конвенция repo) → setTimeout(0)-fallback, дальше цикл живёт на нём.
   */
  private _schedule(run: object): void {
    // Единственный вход в host IO принадлежит только текущему живому циклу.
    if (run !== this._run) return;
    let sync = true;
    let called = false;
    let timestamp: number | undefined;
    try {
      if (!this._useTimeoutFallback) {
        const handle = this._requestFrame!((ts) => {
          if (sync) {
            called = true;
            timestamp = ts;
          } else if (!this._useTimeoutFallback) {
            this._tick(ts, run);
          }
        });
        sync = false;
        // Host мог завершить владельца до возврата handle или синхронного callback.
        if (run !== this._run) return;
        if (!called && handle !== 0) return;
        // Синхронный host и handle=0 сходятся в один trampoline; callback host-а
        // после возврата уже не может создать второй живой тик.
        this._useTimeoutFallback = true;
      }
      // Первый fallback сохраняет timestamp host-а; последующие используют FIXED_DT.
      setTimeout(() => this._tick(timestamp, run), 0);
    } catch (error) {
      if (run === this._run) {
        // Host мог поставить callback перед throw: отзыв делает его инертным
        // и позволяет следующему setTarget повторить выдачу.
        this.stop();
      }
      throw error;
    }
  }

  private _tick(ts: number | undefined, run: object): void {
    // Отозванный цикл не публикует кадры и не ставит новые, даже если
    // setTarget уже начал другой цикл на том же экземпляре.
    if (run !== this._run || this._tickActive) return;
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
      const raw = solveSpring(this._spring!, this._elapsed, this._v0Normalized, solverSample);
      // Getter мог завершить владельца или сменить цикл внутри solver.
      if (run !== this._run) return;
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
        this._run = null;
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
        try { this._schedule(run); } catch { /* первична listener-ошибка */ }
        throw primaryError;
      }
      this._schedule(run);
    } finally {
      this._tickActive = false;
    }
  }

  private _emit(value: number): void {
    let failed = false;
    let firstError: unknown;
    this._listeners.forEach((off, cb) => {
      try {
        cb(value);
      } catch (error) {
        // Map передал исходную отписку до callback; преемник не отзывается.
        off();
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    });
    if (failed) throw firstError;
  }
}
