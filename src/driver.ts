/**
 * driver.ts — S7: Scrubbable / playback-controllable animation driver.
 *
 * Строит управляемый хендл (AnimationControls) поверх пружинного решателя
 * (src/spring.ts) и инъектируемого seam виртуального времени из drive.ts.
 *
 * Отличия от drive():
 *   • Виртуальное время `_vt` ведётся явно и допускает scrub (seek).
 *   • timeScale умножает приращение реального dt — управляет скоростью.
 *   • seek(t) устанавливает _vt напрямую, вычисляет и эмитирует позицию пружины.
 *   • Возвращаемый хендл awaitable (thenable / Promise-совместим).
 *   • reduced-motion: CHARACTER-switch (snap-to-target), НЕ hard-off.
 *
 * Инварианты (package North):
 *   1. Zero runtime deps — нет внешних npm-зависимостей.
 *   2. CSS-safe — все эмитируемые значения конечны (никогда NaN/Infinity).
 *   3. Детерминизм — clock инжектируется; одинаковый seam → одинаковый вывод.
 *   4. Reduced-motion — CHARACTER-switch: snap-to-target, не hard-off.
 *   5. Domain purity — matchMedia / requestFrame инжектируются.
 *   6. SSR-safe — нет window/document при импорте.
 */

import { MotionParamError } from './errors.js';
import { type SpringParams, springUnchecked, validateSpringParams } from './spring.js';

// ─── Константы ────────────────────────────────────────────────────────────────

// Единый контур ядра: те же пороги, что drive/motion-value (internal/constants).
import { CONVERGENCE_THRESHOLD, MAX_FRAMES, FIXED_DT_S } from './internal/constants.js';

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Опции для createDriver(). */
export interface DriverOptions {
  /** Начальное значение анимации. Должно быть конечным. */
  readonly from: number;
  /** Конечное значение анимации. Должно быть конечным. */
  readonly to: number;
  /** Параметры пружины. */
  readonly spring: SpringParams;
  /**
   * Колбэк, вызываемый на каждом шаге с текущим значением.
   * При reduce=true вызывается однократно с финальным `to`.
   */
  readonly onStep: (value: number) => void;
  /**
   * Injectable matchMedia. Pass `window.matchMedia.bind(window)` в браузере.
   * undefined = SSR / нет предпочтений (reduce=false).
   */
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
  /**
   * Injectable requestAnimationFrame-заменитель.
   * handle=0 = non-draining step-clock (тест: не вызывает cb автоматически).
   */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /**
   * Начальный коэффициент скорости воспроизведения.
   * 1.0 = нормальная, -1.0 = реверс, 0 = заморожено.
   * По умолчанию: 1.0.
   */
  readonly initialTimeScale?: number | undefined;
  /**
   * Clamp emitted values to [from, to].
   *
   * Default `true` (легаси CSS-safe). `false` — честная пружина: underdamped
   * overshoot/bounce эмитится (аналитическая траектория без среза); финальный
   * settle — ровно `to`, non-finite защита остаётся в силе.
   */
  readonly clamp?: boolean | undefined;
}

/**
 * Управляемый хендл анимации. Возвращается createDriver().
 *
 * Thenable: можно await-ить напрямую — резолвится при завершении анимации
 * (естественная сходимость, complete(), cancel() или stop()).
 */
export interface AnimationControls {
  /**
   * Текущее виртуальное время (секунды с начала анимации, корректируется seek-ами).
   */
  readonly time: number;
  /**
   * Коэффициент скорости воспроизведения.
   * 1.0 = нормальная, -1.0 = реверс, 0 = заморожено. Доступен для записи.
   * NaN игнорируется (не изменяет текущее значение).
   */
  timeScale: number;
  /**
   * Нормированная позиция пружины при текущем виртуальном времени.
   * Зажата в [0, 1]. 0 = at from, 1 = at to.
   */
  readonly progress: number;
  /**
   * Аналитическая скорость (units value/s) при текущем виртуальном времени —
   * чтение live-рана в произвольный момент (#93): приёмник хендоффа наследует
   * пару (эмитнутое value, velocity) как начальные условия. Это hidden-state
   * скорость траектории солвера, НЕ производная клампованного выхода (канон
   * MotionValue.velocity — clamp-режим не влияет). В покое ровно 0: до старта,
   * после сходимости/complete/cancel, вырожденный from === to. Всегда конечна.
   */
  readonly velocity: number;

  /** Возобновить воспроизведение (no-op, если уже играет). */
  play(): void;
  /** Остановить воспроизведение (no-op, если уже на паузе). */
  pause(): void;
  /** Инвертировать знак timeScale — реверс направления. */
  reverse(): void;
  /**
   * Перемотать к виртуальному времени t (секунды).
   * Зажимает: t < 0 → 0, NaN → игнорируется, +Infinity → complete().
   * Эмитирует позицию пружины при новом времени.
   */
  seek(t: number): void;
  /** Немедленно снэпнуть к финальному значению `to` и разрешить Promise. */
  complete(): void;
  /** Остановить анимацию в текущей позиции и разрешить Promise. */
  cancel(): void;
  /** Alias для cancel(). */
  stop(): void;

  /**
   * Thenable — позволяет `await controls` или `controls.then(cb)`.
   * Резолвится с `void` при любом завершении (complete/cancel/natural).
   */
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2>;
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/** Считать предпочтение reduced-motion из инжектируемого matchMedia. */
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

/** Зажать значение в [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─── createDriver ─────────────────────────────────────────────────────────────

/**
 * Создаёт управляемый driver анимации поверх пружинного решателя.
 *
 * Начинает воспроизведение немедленно (auto-play). Для запуска в режиме паузы
 * вызовите `pause()` сразу после создания (до первого raf-колбэка).
 *
 * Возвращаемый хендл thenable: `await createDriver(opts)` резолвится при
 * завершении анимации.
 *
 * @throws {MotionParamError} если from/to не конечны или spring-параметры невалидны.
 */
export function createDriver(opts: DriverOptions): AnimationControls {
  const { from, to, onStep, matchMedia } = opts;

  // ── Валидация входных данных (eagerly, до создания Promise) ───────────────
  if (!Number.isFinite(from)) {
    throw new MotionParamError(`driver: 'from' должно быть конечным числом, получено ${from}`);
  }
  if (!Number.isFinite(to)) {
    throw new MotionParamError(`driver: 'to' должно быть конечным числом, получено ${to}`);
  }
  validateSpringParams(opts.spring);

  const range = to - from;
  const absRange = Math.abs(range);
  const lo = range >= 0 ? from : to;
  const hi = range >= 0 ? to : from;
  // Клэмп-режим: default true; явный false = честная пружина (overshoot эмитится).
  const bounded = opts.clamp !== false;

  // Флаг overflow: |from| + |to| > MAX_VALUE → range = ±Infinity.
  const overflowRange = !Number.isFinite(range);

  // ── Reduced-motion policy ─────────────────────────────────────────────────
  const reduce = prefersReducedMotion(matchMedia);

  // ── Platform driver ───────────────────────────────────────────────────────
  const scheduleFrame: (cb: (ts?: number) => void) => number =
    opts.requestFrame ??
    ((cb) =>
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame(cb)
        : (setTimeout(cb, FIXED_DT_S * 1000) as unknown as number));

  // ── Изменяемое состояние ──────────────────────────────────────────────────

  /** Текущее виртуальное время (секунды). */
  let _vt = 0;
  /** Реальный timestamp последнего кадра. undefined = сбрасывается при паузе/seek. */
  let _lastRealTs: number | undefined;
  /** Коэффициент скорости воспроизведения. */
  let _timeScale: number =
    opts.initialTimeScale !== undefined && !Number.isNaN(opts.initialTimeScale)
      ? opts.initialTimeScale
      : 1.0;
  /** true — воспроизведение приостановлено пользователем. */
  let _paused = false;
  /** true — анимация завершена (settled). Все дальнейшие вызовы — no-op. */
  let _settled = false;
  /**
   * Значение, на котором завершилась анимация.
   * undefined = ещё не завершилась.
   * Используется в progress: if settled at to → 1, at from → 0, else computeProgress.
   */
  let _settledValue: number | undefined;
  /** Ре-энтрантный guard тела tick. */
  let _tickActive = false;
  /** true — loop запущен (tick уже запланирован или выполняется). */
  let _loopRunning = false;
  /** true — использовать setTimeout-fallback вместо scheduleFrame. */
  let _useTimeoutFallback = false;
  /** Счётчик кадров forward-воспроизведения (для MAX_FRAMES). */
  let _fwdFrameCount = 0;
  /** Глобальный счётчик кадров (safety cap для любого timeScale). */
  let _totalFrameCount = 0;

  // ── Promise ───────────────────────────────────────────────────────────────
  let _resolve!: () => void;
  const _promise = new Promise<void>((res) => {
    _resolve = res;
  });

  // ── Вспомогательные методы ────────────────────────────────────────────────

  /**
   * Вычислить позицию пружины при виртуальном времени t.
   * Всегда возвращает конечное значение.
   * @internal
   */
  function computeAt(t: number): number {
    // Degenerate / overflow cases.
    if (from === to) return to;
    if (overflowRange) return to;

    const clamped = Number.isFinite(t) ? Math.max(0, t) : (t > 0 ? Infinity : 0);

    // Очень большое время → пружина сошлась в to.
    if (clamped === Infinity) return to;
    if (clamped === 0) return from;

    const r = springUnchecked(opts.spring, clamped);
    const raw = from + r.value * range;

    // CSS-safety guard: overflow, NaN или ∞ → snap to to.
    if (!Number.isFinite(raw)) return to;
    // bounded=true (default): CSS-safe клэмп; false — честная траектория.
    return bounded ? clamp(raw, lo, hi) : raw;
  }

  /**
   * Вычислить нормированный progress (0..1) при виртуальном времени t.
   * @internal
   */
  function computeProgress(t: number): number {
    if (from === to || overflowRange) return 1;

    const clamped = Number.isFinite(t) ? Math.max(0, t) : (t > 0 ? Infinity : 0);

    if (clamped === Infinity) return 1;
    if (clamped === 0) return 0;

    const r = springUnchecked(opts.spring, clamped);
    return clamp(r.value, 0, 1);
  }

  /**
   * Проверить сходимость пружины при текущем _vt.
   * @internal
   */
  function isConvergedAt(t: number): boolean {
    if (from === to || overflowRange) return true;
    if (!Number.isFinite(t) && t > 0) return true; // t = +Infinity → сошлась

    const safe = Math.max(0, t);
    const r = springUnchecked(opts.spring, safe);
    const v = from + r.value * range;
    const vel = Math.abs(r.velocity) * absRange;

    // Visual-saturation gate — ТОЛЬКО в клэмп-режиме: клампованный вывод
    // насыщен на to → визуально готово. При clamp:false первый же контакт
    // с to (первое пересечение underdamped) — НЕ завершение: честная
    // траектория продолжает overshoot/bounce до истинной сходимости.
    if (bounded && clamp(v, lo, hi) === to) return true;

    // Нормированный порог (range-independent, как в drive.ts).
    return (
      Math.abs(v - to) / absRange < CONVERGENCE_THRESHOLD &&
      vel / absRange < CONVERGENCE_THRESHOLD
    );
  }

  // ── Settlement ────────────────────────────────────────────────────────────

  /**
   * Зафиксировать анимацию: эмитировать snapTo, разрешить Promise.
   * Идемпотентна.
   */
  function settle(snapTo: number): void {
    if (_settled) return;
    _settled = true;
    _settledValue = snapTo;
    _loopRunning = false;
    onStep(snapTo);
    _resolve();
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  function tick(ts?: number): void {
    // Завершённая анимация или ре-энтрантный вызов.
    if (_settled) { _loopRunning = false; return; }
    if (_tickActive) return;

    // Пауза: останавливаем loop, сбрасываем timestamp.
    if (_paused) {
      _loopRunning = false;
      _lastRealTs = undefined;
      return;
    }

    _tickActive = true;
    _totalFrameCount++;

    // ── Глобальный safety cap (любой timeScale, в т.ч. NaN/0) ─────────────
    // Предотвращает бесконечный цикл при timeScale=0/NaN/замороженном состоянии.
    // ×5 к MAX_FRAMES (одно forward-воспроизведение): скраб-драйвер легитимно
    // живёт дольше одного прогона — реверс, повторные проходы на медленном
    // timeScale, качание туда-обратно. Полог = 5 полных длин воспроизведения
    // суммарного скраба до принудительного settle (не привязан к одному прогону).
    const GLOBAL_CAP = MAX_FRAMES * 5;
    if (_totalFrameCount >= GLOBAL_CAP) {
      _tickActive = false;
      settle(computeAt(_vt));
      return;
    }

    // ── Вычислить dt ──────────────────────────────────────────────────────
    let dt: number;
    if (ts !== undefined) {
      dt = _lastRealTs !== undefined ? (ts - _lastRealTs) / 1000 : FIXED_DT_S;
      _lastRealTs = ts;
    } else {
      dt = FIXED_DT_S;
    }

    // Protect against negative/zero dt (repeated ts, paused browser tab wake).
    if (dt <= 0) dt = FIXED_DT_S;

    // ── Продвинуть виртуальное время ─────────────────────────────────────
    // _timeScale может быть ±∞ (намеренно: мгновенная сходимость / реверс к from).
    _vt += dt * _timeScale;

    // ── Проверки границ и сходимости ─────────────────────────────────────
    if (_timeScale > 0 || (!Number.isFinite(_timeScale) && _timeScale > 0)) {
      // Forward path (timeScale > 0 или +Infinity).
      _fwdFrameCount++;
      if (isConvergedAt(_vt) || _fwdFrameCount >= MAX_FRAMES) {
        _tickActive = false;
        settle(to);
        return;
      }
    } else if (_timeScale < 0 || (!Number.isFinite(_timeScale) && _timeScale < 0)) {
      // Reverse path (timeScale < 0 или -Infinity).
      if (_vt <= 0) {
        _vt = 0;
        _tickActive = false;
        settle(from);
        return;
      }
    }
    // timeScale = 0 или NaN: emit current, reschedule без convergence-check
    // (_totalFrameCount GLOBAL_CAP выше является safety escape).

    // ── Эмитировать текущую позицию ───────────────────────────────────────
    const val = computeAt(_vt);
    onStep(val);

    _tickActive = false;

    // ── Перепланировать следующий кадр ────────────────────────────────────
    if (_useTimeoutFallback) {
      setTimeout(tick, 0);
    } else {
      const h = scheduleFrame(tick);
      if (h === 0) {
        // Переходим на setTimeout-fallback (non-draining clock convention).
        _useTimeoutFallback = true;
        setTimeout(tick, 0);
      }
    }
  }

  /** Запустить frame loop, если ещё не запущен. */
  function ensureLoop(): void {
    if (_loopRunning || _settled || _paused) return;
    _loopRunning = true;
    const h = scheduleFrame(tick);
    if (h === 0) {
      _useTimeoutFallback = true;
      // scheduleFrame вернул 0 (non-draining): tick не вызван автоматически.
      // setTimeout(0) форсирует первый вызов.
      setTimeout(tick, 0);
    }
  }

  // ── Мгновенные завершения (degenerate / overflow / reduced-motion) ─────────

  if (from === to) {
    settle(to);
  } else if (overflowRange) {
    // |from| + |to| > MAX_VALUE → range = ±∞ → snap to to.
    settle(to);
  } else if (reduce) {
    // Reduced-motion CHARACTER-switch: snap-to-target, НЕ hard-off.
    settle(to);
  }

  // ── Bootstrap frame loop (если не settled) ────────────────────────────────
  if (!_settled) {
    ensureLoop();
  }

  // ── Public handle ─────────────────────────────────────────────────────────
  const controls: AnimationControls = {
    get time(): number {
      return _vt;
    },

    get timeScale(): number {
      return _timeScale;
    },
    set timeScale(v: number) {
      // NaN отклоняется (не изменяет состояние).
      if (!Number.isNaN(v)) {
        _timeScale = v;
      }
    },

    get progress(): number {
      // Если анимация завершена — возвращаем прогресс на основе settled-значения,
      // а не _vt (который мог остаться 0 при reduce-path).
      if (_settled && _settledValue !== undefined) {
        if (_settledValue === to) return 1;
        if (_settledValue === from) return 0;
        // cancel/stop в промежуточной точке — вычислить из _vt.
      }
      return computeProgress(_vt);
    },

    get velocity(): number {
      // Покой → ровно 0: settled (сходимость/complete/cancel = ран заморожен),
      // вырожденный/overflow range (кадров не было). Симметрия computeAt.
      if (_settled || from === to || overflowRange) return 0;
      const clamped = Number.isFinite(_vt) ? Math.max(0, _vt) : _vt > 0 ? Infinity : 0;
      if (clamped === Infinity || clamped === 0) return 0; // сошлась / ещё не стартовала
      // springUnchecked отдаёт нормированную (progress/s) скорость с конечными
      // стражами; денормализация в units/s — умножение на range (границы
      // солвера — единственное место нормировки, инвариант #93).
      const vel = springUnchecked(opts.spring, clamped).velocity * range;
      return Number.isFinite(vel) ? vel : 0;
    },

    play(): void {
      if (_settled) return;
      if (!_paused) return; // уже играет
      _paused = false;
      _lastRealTs = undefined; // сбрасываем ts, чтобы первый кадр после паузы не имел прыжка dt
      ensureLoop();
    },

    pause(): void {
      _paused = true;
      // loop остановится сам на следующем tick (проверяет _paused в начале).
    },

    reverse(): void {
      _timeScale = -_timeScale;
    },

    seek(t: number): void {
      if (_settled) return;
      // NaN: silently ignore.
      if (Number.isNaN(t)) return;
      // +Infinity: complete.
      if (t === Infinity) {
        controls.complete();
        return;
      }
      // -Infinity или t < 0: clamp to 0.
      _vt = Math.max(0, t);
      _lastRealTs = undefined;
      const val = computeAt(_vt);
      onStep(val);
    },

    complete(): void {
      if (_settled) return;
      settle(to);
    },

    cancel(): void {
      if (_settled) return;
      const val = computeAt(_vt);
      settle(val);
    },

    stop(): void {
      if (_settled) return;
      const val = computeAt(_vt);
      settle(val);
    },

    then<TResult1 = void, TResult2 = never>(
      onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return _promise.then(onfulfilled, onrejected);
    },
  };

  return controls;
}
