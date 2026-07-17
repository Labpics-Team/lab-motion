/**
 * keyframes/index.ts — S4: headless zero-DOM multi-point keyframes subpath.
 *
 * Интерполирует значение через N>=2 опорных точек (`values`) с явными или
 * авто-распределёнными долями (`times`), per-сегментное easing, и опциональный
 * repeat/loop/reverse/mirror/repeatDelay поверх единого виртуального
 * времени (тот же injectable-clock seam, что и timeline/driver/spring).
 *
 * Инварианты (North):
 *   1. Zero runtime deps — нет внешних npm-зависимостей.
 *   2. CSS-safe — эмитируемые значения ВСЕГДА конечны (NaN/Infinity запрещены),
 *      включая overflow-края (range = values[i+1] − values[i] → ±Infinity).
 *   3. Детерминизм — clock инжектируется (`requestFrame`); одинаковый seam →
 *      бит-идентичный вывод. Нет Date.now/Math.random/window на верхнем уровне.
 *   4. Reduced-motion — CHARACTER-switch: мгновенный snap к ПОСЛЕДНЕМУ
 *      keyframe (values[last]), НЕ hard-off. Repeat/direction игнорируются —
 *      "reduced" означает «покажи финал сразу», а не «просчитай all iterations».
 *   5. Domain purity — никаких querySelector/document/window/DOM внутри ядра.
 *   6. SSR-safe — нет window/document при импорте модуля.
 */

import { MotionParamError } from '../errors.js';
import { createFrameRequester } from '../internal/frame-requester.js';
import {
  isRepeatScheduleRepresentable,
  isRepeatCount,
  repeatCursor,
  repeatDuration,
  type RepeatDirection,
} from '../internal/repeat-cursor.js';
import { sampleKeyframesUnchecked } from '../internal/sample-keyframes.js';

// ─── Публичные типы ───────────────────────────────────────────────────────────

/** Функция easing: нормализованное время сегмента [0,1] → [обычно 0,1]. */
export type EasingFn = (t: number) => number;

/**
 * Политика повторов.
 *   'loop'    — каждый цикл проигрывается заново от values[0] к values[last].
 *   'reverse' — нечётный цикл воспроизводит исходный track и easing назад.
 *   'mirror'  — нечётный цикл меняет порядок values, сохраняя easing вперёд.
 */
export type KeyframesRepeatType = 'loop' | 'reverse' | 'mirror';

/** Структурный подвид MediaQueryList — только то, что нужно keyframes(). */
export interface MatchMediaResult {
  readonly matches: boolean;
}

export interface KeyframesOptions {
  /**
   * Опорные значения. Длина >= 2. Каждое значение должно быть конечным числом.
   * @throws MotionParamError если длина < 2 или содержит не-конечное значение.
   */
  readonly values: readonly number[];
  /**
   * Длительность ОДНОГО цикла (секунды виртуального времени). > 0, конечна.
   * По умолчанию: 1.
   */
  readonly duration?: number;
  /**
   * Доли [0,1] для каждого значения — длина должна совпадать с `values`.
   * Должны быть неубывающими, times[0]===0, times[last]===1, все конечны.
   * Не задано → авто-распределение: times[i] = i / (values.length - 1).
   * @throws MotionParamError при несовпадении длины/невалидных долях.
   */
  readonly times?: readonly number[];
  /**
   * Easing на каждый сегмент (между соседними values).
   * Один общий easing — применяется ко всем сегментам.
   * Массив — по одному easing на сегмент, длина = values.length - 1.
   * Не задано → линейная идентичность.
   * Выход любого easing зашивается finiteness-guard'ом (NaN→0, ±Infinity→±MAX_VALUE).
   * @throws MotionParamError если массив не совпадает по длине с числом
   *   сегментов или содержит не-функцию.
   */
  readonly easing?: EasingFn | readonly EasingFn[];
  /**
   * Число ДОПОЛНИТЕЛЬНЫХ повторов после первого проигрывания.
   * 0 (по умолчанию) = сыграть один раз. `Infinity` = бесконечный повтор.
   * @throws MotionParamError если не целое 0…2_147_483_647 (или Infinity).
   */
  readonly repeat?: number;
  /** Политика направления повторов. По умолчанию: 'loop'. */
  readonly repeatType?: KeyframesRepeatType;
  /**
   * Пауза между циклами (секунды), значение держится на конце цикла.
   * >= 0, конечна. По умолчанию: 0.
   */
  readonly repeatDelay?: number;
  /** Колбэк на каждый шаг — текущее интерполированное значение. */
  readonly onStep?: (value: number) => void;
  /** Injectable requestAnimationFrame-заменитель. Возврат 0 = non-draining (тесты). */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /** Injectable matchMedia. undefined = SSR / нет предпочтений (reduce=false). */
  readonly matchMedia?: ((query: string) => MatchMediaResult) | undefined;
}

/** Управляемый хендл keyframes-анимации. Возвращается keyframes(). Thenable. */
export interface KeyframesControls {
  /**
   * Суммарная длительность ВСЕЙ последовательности повторов (секунды).
   * `Infinity`, если `repeat === Infinity` (соответствует WAAPI
   * `activeDuration` для `iterations: Infinity`) — метаданные, НЕ эмитируемое
   * значение; invariant 2 (CSS-safety) на это поле не распространяется.
   */
  readonly totalDuration: number;
  /** Текущее виртуальное время (секунды) от начала первого цикла. */
  readonly time: number;
  /**
   * Прогресс ТЕКУЩЕГО цикла [0,1] (не всей последовательности повторов —
   * при repeat=Infinity общий прогресс не определён по построению).
   */
  readonly progress: number;

  /** Возобновить воспроизведение (no-op если уже играет или завершён). */
  play(): void;
  /** Остановить воспроизведение (no-op если уже завершён). */
  pause(): void;
  /**
   * Перемотать к виртуальному времени t (секунды) от начала первого цикла.
   * t < 0 → 0, NaN → no-op. +Infinity завершает конечный schedule, но для
   * repeat=Infinity даёт LM166; явное завершение доступно через complete().
   */
  seek(t: number): void;
  /** Немедленно снэпнуть к финальному keyframe (values[last]) и разрешить Promise. */
  complete(): void;
  /** Остановить в текущей позиции и разрешить Promise (эмитирует текущее значение). */
  cancel(): void;
  /** Thenable — `await keyframes(...)` резолвится при complete/cancel/natural. */
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2>;
}

// ─── Внутренние константы ────────────────────────────────────────────────────

const FIXED_DT_S = 1 / 60;
/** Safety-cap кадров — идентичен timeline/index.ts MAX_FRAMES. */
const MAX_FRAMES = 100_000;

function linearEasing(t: number): number {
  return t;
}

function prefersReducedMotion(
  matchMedia: ((query: string) => MatchMediaResult) | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ─── Публичная чистая функция: сэмплирование по нормализованному прогрессу ──

/**
 * Интерполирует значение по массиву опорных точек `values` при нормализованном
 * прогрессе `p` (обычно [0,1], но защищено от хостильных входов).
 *
 * Чистая headless-функция без состояния — экспортирована отдельно от
 * `keyframes()`, чтобы её можно было тестировать/использовать напрямую
 * (differential-oracle тесты, статичная выборка кадра без frame-loop).
 *
 * Контракт:
 *   - `values.length` должен быть >= 2, `times.length === values.length`,
 *     `easings.length === values.length - 1`. Вызывающая сторона (`keyframes()`)
 *     гарантирует это через `compileKeyframes` — сама функция не валидирует
 *     заново (hot path), но ВСЕГДА возвращает конечное число (invariant 2).
 *   - p <= times[0] → values[0]. p >= times[last] → values[last].
 *   - Совпадающие соседние `times` (нулевая ширина сегмента) → мгновенный
 *     переход к values[i+1] при p >= times[i] (без деления на 0).
 *   - overflow (values[i+1] − values[i] не конечно) → snap к values[i+1],
 *     мирроря timeline.ts `hasOverflowRange` дисциплину.
 */
export function sampleKeyframes(
  values: readonly number[],
  times: readonly number[],
  easings: readonly EasingFn[],
  p: number,
): number {
  return sampleKeyframesUnchecked(values, times, easings, p);
}

// ─── Компиляция/валидация опций ──────────────────────────────────────────────

interface CompiledKeyframes {
  readonly values: readonly number[];
  readonly times: readonly number[];
  readonly easings: readonly EasingFn[];
  readonly duration: number;
  readonly repeat: number;
  readonly repeatType: RepeatDirection;
  readonly repeatDelay: number;
}

function compileKeyframes(opts: KeyframesOptions): CompiledKeyframes {
  const values = opts.values;
  if (!values || values.length < 2) {
    throw new MotionParamError('LM033');
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new MotionParamError('LM034');
    }
  }

  const n = values.length;
  let times: readonly number[];
  if (opts.times !== undefined) {
    if (opts.times.length !== n) {
      throw new MotionParamError('LM035');
    }
    for (let i = 0; i < n; i++) {
      const t = opts.times[i]!;
      if (!Number.isFinite(t)) {
        throw new MotionParamError('LM036');
      }
      if (i > 0 && t < opts.times[i - 1]!) {
        throw new MotionParamError('LM037');
      }
    }
    if (opts.times[0] !== 0) {
      throw new MotionParamError('LM038');
    }
    if (opts.times[n - 1] !== 1) {
      throw new MotionParamError('LM039');
    }
    times = opts.times;
  } else {
    // Авто-распределение равными долями.
    const auto = new Array<number>(n);
    for (let i = 0; i < n; i++) auto[i] = i / (n - 1);
    times = auto;
  }

  const segCount = n - 1;
  let easings: readonly EasingFn[];
  if (Array.isArray(opts.easing)) {
    if (opts.easing.length !== segCount) {
      throw new MotionParamError('LM040');
    }
    for (let i = 0; i < segCount; i++) {
      if (typeof opts.easing[i] !== 'function') {
        throw new MotionParamError('LM163');
      }
    }
    easings = opts.easing;
  } else if (typeof opts.easing === 'function') {
    const fn = opts.easing;
    easings = new Array<EasingFn>(segCount).fill(fn);
  } else if (opts.easing === undefined) {
    easings = new Array<EasingFn>(segCount).fill(linearEasing);
  } else {
    throw new MotionParamError('LM163');
  }

  const duration = opts.duration ?? 1;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MotionParamError('LM041');
  }

  const repeatRaw = opts.repeat ?? 0;
  if (!isRepeatCount(repeatRaw)) {
    throw new MotionParamError('LM042');
  }
  const repeat = repeatRaw;

  const repeatTypeRaw = opts.repeatType ?? 'loop';
  if (repeatTypeRaw !== 'loop' && repeatTypeRaw !== 'reverse' && repeatTypeRaw !== 'mirror') {
    throw new MotionParamError('LM043');
  }
  const repeatType: RepeatDirection = repeatTypeRaw === 'reverse' ? 1 : repeatTypeRaw === 'mirror' ? 2 : 0;

  const repeatDelay = opts.repeatDelay ?? 0;
  if (!Number.isFinite(repeatDelay) || repeatDelay < 0) {
    throw new MotionParamError('LM044');
  }
  if (!isRepeatScheduleRepresentable(0, duration, repeat, repeatDelay)) {
    throw new MotionParamError('LM161');
  }

  return { values, times, easings, duration, repeat, repeatType, repeatDelay };
}

// ─── keyframes() — controllable frame-loop поверх sampleKeyframes ───────────

/**
 * Создаёт управляемую keyframes-анимацию из последовательности опорных точек.
 * Начинает воспроизведение немедленно (если не reduced-motion).
 *
 * @throws MotionParamError при структурно невалидных опциях (см. KeyframesOptions).
 */
export function keyframes(opts: KeyframesOptions): KeyframesControls {
  const compiled = compileKeyframes(opts);
  const { values, times, easings, duration, repeat, repeatType, repeatDelay } = compiled;
  const globalOnStep = opts.onStep;
  const lastValue = values[values.length - 1]!;

  const totalDuration = repeatDuration(duration, repeat, repeatDelay);

  const reduce = prefersReducedMotion(opts.matchMedia);

  const injectedFrame = opts.requestFrame;
  if (injectedFrame !== undefined && typeof injectedFrame !== 'function') {
    throw new MotionParamError('LM165');
  }

  const scheduleFrame: (cb: (ts?: number) => void) => number =
    injectedFrame ??
    ((cb) =>
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame(cb)
        : (setTimeout(cb, FIXED_DT_S * 1000) as unknown as number));

  // ── Изменяемое состояние ──────────────────────────────────────────────────
  let _vt = 0;
  let _lastRealTs: number | undefined;
  let _paused = false;
  let _settled = false;
  let _loopRunning = false;
  let _tickActive = false;
  let _frameCount = 0;
  let _operation = 0;
  let _samplingPhase: 0 | 1 | 2 = 0;
  let _publicationQueued = false;
  let _queuedSettling = false;
  let _queuedCursor: number | undefined;

  let _resolve!: () => void;
  const _promise = new Promise<void>((res) => {
    _resolve = res;
  });

  function sampleCursor(cursor: number): number {
    return sampleKeyframesUnchecked(
      values,
      times,
      easings,
      cursor < 0 ? -1 - cursor : cursor,
      cursor < 0,
    );
  }

  /** Вычислить интерполированное значение при виртуальном времени vt. */
  function computeAt(vt: number): number {
    return sampleCursor(repeatCursor(vt, 0, duration, repeat, repeatDelay, repeatType));
  }

  function emit(value: number): void {
    if (!globalOnStep) return;
    try {
      globalOnStep(value);
    } catch {
      // Isolate user-callback errors so the frame loop / promise stay resilient.
    }
  }

  function settle(finalValue: number): void {
    if (_settled) return;
    _settled = true;
    _loopRunning = false;
    try {
      emit(finalValue);
    } finally {
      _resolve();
    }
  }

  /**
   * A reentrant control gets one deferred sample. Further sampling controls
   * raised by that easing are ignored so it cannot recurse or livelock.
   */
  function samplePublication(provenCursor: number | undefined, phase: 1 | 2): number {
    _samplingPhase = phase;
    try {
      return provenCursor === undefined ? computeAt(_vt) : sampleCursor(provenCursor);
    } finally {
      _samplingPhase = 0;
    }
  }

  function publishCurrent(settling: boolean, provenCursor?: number): void {
    let owner = ++_operation;
    if (_samplingPhase !== 0) {
      _publicationQueued = true;
      _queuedSettling = settling;
      _queuedCursor = provenCursor;
      return;
    }

    // A throwing easing can leave only a stale private intent behind.
    _publicationQueued = false;
    let value = samplePublication(provenCursor, 1);
    if (_publicationQueued) {
      _publicationQueued = false;
      if (_settled) return;
      owner = _operation;
      settling = _queuedSettling;
      value = samplePublication(_queuedCursor, 2);
    }

    if (owner !== _operation || _settled) return;
    if (settling) settle(value);
    else emit(value);
  }

  function tick(ts?: number): void {
    if (_settled) { _loopRunning = false; return; }
    if (_tickActive) return;

    if (_paused) {
      _loopRunning = false;
      _lastRealTs = undefined;
      return;
    }

    _tickActive = true;
    try {
      _frameCount++;
      if (_frameCount >= MAX_FRAMES) {
        _frameCount = 0;
        if (totalDuration !== Infinity) {
          // Safety cap — bail out at CURRENT position (not a real natural-complete).
          publishCurrent(true);
          return;
        }
      }

      let dt = FIXED_DT_S;
      let nextRealTs = _lastRealTs;
      // Omitted timestamps preserve the last real anchor; a present timestamp
      // is parsed into local transaction state first.
      if (ts !== undefined) {
        if (Number.isFinite(ts)) {
          const previous = _lastRealTs;
          nextRealTs = ts;
          if (previous !== undefined) {
            const elapsed = (ts - previous) / 1000;
            if (Number.isFinite(elapsed) && elapsed > 0) dt = elapsed;
            else if (!Number.isFinite(elapsed)) nextRealTs = undefined;
          }
        } else {
          nextRealTs = undefined;
        }
      }
      const nextVt = _vt + dt;
      let provenCursor: number | undefined;
      // Infinite schedules own an exact parity horizon. Prove the candidate
      // before committing either clock coordinate; LM166 leaves a resumable
      // owner at the last valid sample.
      if (totalDuration === Infinity) {
        provenCursor = repeatCursor(nextVt, 0, duration, repeat, repeatDelay, repeatType);
      }
      _lastRealTs = nextRealTs;
      _vt = nextVt;

      if (totalDuration !== Infinity && _vt >= totalDuration) {
        _vt = totalDuration;
        _operation++;
        settle(lastCycleEndValue());
        return;
      }

      publishCurrent(false, provenCursor);
    } catch (error) {
      _loopRunning = false;
      throw error;
    } finally {
      _tickActive = false;
    }

    if (_settled || _paused) {
      _loopRunning = false;
      return;
    }
    requestNextFrame();
  }

  const requestNextFrame = createFrameRequester(
    scheduleFrame,
    tick,
    injectedFrame !== undefined,
  );

  /** Значение на конце ПОСЛЕДНЕГО цикла (учитывает направление yoyo). */
  function lastCycleEndValue(): number {
    return repeatType === 0 || repeat % 2 === 0 ? lastValue : values[0]!;
  }

  function ensureLoop(): void {
    if (_loopRunning || _settled || _paused) return;
    _loopRunning = true;
    requestNextFrame();
  }

  // ── Reduced-motion CHARACTER-switch (invariant 4) ─────────────────────────
  // Снэп СИНХРОННО к последнему keyframe, игнорируя repeat/direction —
  // "reduced" = мгновенно покажи финал, а не просчитывай all iterations.
  if (reduce) {
    settle(lastValue);
  } else if (!_settled) {
    ensureLoop();
  }

  const controls: KeyframesControls = {
    get totalDuration(): number {
      return totalDuration;
    },
    get time(): number {
      return _vt;
    },
    get progress(): number {
      if (_settled) return 1;
      // Public progress is the iteration clock, independent of direction.
      // Reuse the schedule oracle so value/progress cannot disagree exactly
      // at a representable iteration boundary.
      return repeatCursor(_vt, 0, duration, repeat, repeatDelay, 0);
    },

    play(): void {
      if (_settled) return;
      if (!_paused) {
        ensureLoop();
        return;
      }
      _operation++;
      _publicationQueued = false;
      _paused = false;
      _lastRealTs = undefined;
      ensureLoop();
    },

    pause(): void {
      if (_settled || _paused) return;
      _operation++;
      _publicationQueued = false;
      _paused = true;
    },

    seek(t: number): void {
      if (_settled || _samplingPhase === 2) return;
      if (Number.isNaN(t)) return;
      if (t === Infinity) {
        if (repeat === Infinity) throw new MotionParamError('LM166');
        controls.complete();
        return;
      }
      const upper = totalDuration === Infinity ? Number.MAX_VALUE : totalDuration;
      const next = Math.max(0, Math.min(upper, t));
      if (repeat === Infinity) repeatCursor(next, 0, duration, repeat, repeatDelay, 0);
      _vt = next;
      _lastRealTs = undefined;
      publishCurrent(false);
    },

    complete(): void {
      if (_settled || _samplingPhase === 2) return;
      _operation++;
      // Совпадает с reduced-motion контрактом: мгновенный snap к финалу.
      _vt = totalDuration === Infinity ? _vt : totalDuration;
      settle(lastValue);
    },

    cancel(): void {
      if (_settled || _samplingPhase === 2) return;
      publishCurrent(true);
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
