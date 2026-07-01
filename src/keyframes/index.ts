/**
 * keyframes/index.ts — S4: headless zero-DOM multi-point keyframes subpath.
 *
 * Интерполирует значение через N>=2 опорных точек (`values`) с явными или
 * авто-распределёнными долями (`times`), per-сегментное easing, и опциональный
 * repeat/loop/reverse(mirror=yoyo)/repeatDelay поверх единого виртуального
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

// ─── Публичные типы ───────────────────────────────────────────────────────────

/** Функция easing: нормализованное время сегмента [0,1] → [обычно 0,1]. */
export type EasingFn = (t: number) => number;

/**
 * Политика повторов.
 *   'loop'    — каждый цикл проигрывается заново от values[0] к values[last].
 *   'reverse' — циклы чередуют направление (yoyo): чётный цикл вперёд,
 *               нечётный — назад. Алиас: 'mirror' (то же самое поведение).
 *   'mirror'  — алиас 'reverse' (yoyo). Оставлен как отдельное принимаемое
 *               значение для совместимости именования с WAAPI-подобными API.
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
   * @throws MotionParamError если массив easings не совпадает по длине с числом сегментов.
   */
  readonly easing?: EasingFn | readonly EasingFn[];
  /**
   * Число ДОПОЛНИТЕЛЬНЫХ повторов после первого проигрывания.
   * 0 (по умолчанию) = сыграть один раз. `Infinity` = бесконечный повтор.
   * @throws MotionParamError если не целое неотрицательное число (или Infinity).
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
   * t < 0 → 0, NaN → no-op, +Infinity → complete().
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

// ─── Finiteness guard (mirrors timeline.ts / easing.ts clampFinite) ─────────

function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

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
  const n = values.length;
  const pClamped = Number.isFinite(p) ? p : p === Infinity ? 1 : p === -Infinity ? 0 : 0;

  if (pClamped <= times[0]!) return values[0]!;
  if (pClamped >= times[n - 1]!) return values[n - 1]!;

  // Линейный поиск сегмента — values обычно короткий (авторский keyframe-список).
  let i = 0;
  for (; i < n - 2; i++) {
    if (pClamped < times[i + 1]!) break;
  }

  const t0 = times[i]!;
  const t1 = times[i + 1]!;
  const v0 = values[i]!;
  const v1 = values[i + 1]!;

  // Нулевая ширина сегмента (дубликат times) → мгновенный переход.
  if (t1 <= t0) return v1;

  const localT = clampFinite((pClamped - t0) / (t1 - t0));
  const localTClamped = localT < 0 ? 0 : localT > 1 ? 1 : localT;

  const ease = easings[i] ?? linearEasing;
  const eased = clampFinite(ease(localTClamped));

  const range = v1 - v0;
  const raw = v0 + range * eased;
  // Overflow guard (invariant 2): covers BOTH the case where `range` itself
  // overflowed to ±Infinity (e.g. v0/v1 near opposite ends of MAX_VALUE) AND
  // the case where `range * eased` overflows on its own — `range` finite but
  // `raw` still non-finite is caught by the same check. Verified load-bearing
  // by mutation (see keyframes-property-fuzz.test.ts RED-proof).
  return Number.isFinite(raw) ? raw : v1;
}

// ─── Компиляция/валидация опций ──────────────────────────────────────────────

interface CompiledKeyframes {
  readonly values: readonly number[];
  readonly times: readonly number[];
  readonly easings: readonly EasingFn[];
  readonly duration: number;
  readonly repeat: number;
  readonly repeatType: KeyframesRepeatType;
  readonly repeatDelay: number;
}

function compileKeyframes(opts: KeyframesOptions): CompiledKeyframes {
  const values = opts.values;
  if (!values || values.length < 2) {
    throw new MotionParamError(
      `keyframes: values должен содержать минимум 2 элемента, получено ${values?.length ?? 0}`,
    );
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new MotionParamError(
        `keyframes: values[${i}] должен быть конечным числом, получено ${values[i]}`,
      );
    }
  }

  const n = values.length;
  let times: readonly number[];
  if (opts.times !== undefined) {
    if (opts.times.length !== n) {
      throw new MotionParamError(
        `keyframes: times.length (${opts.times.length}) должен совпадать с values.length (${n})`,
      );
    }
    for (let i = 0; i < n; i++) {
      const t = opts.times[i]!;
      if (!Number.isFinite(t)) {
        throw new MotionParamError(`keyframes: times[${i}] должен быть конечным числом, получено ${t}`);
      }
      if (i > 0 && t < opts.times[i - 1]!) {
        throw new MotionParamError('keyframes: times должны быть неубывающими (ascending)');
      }
    }
    if (opts.times[0] !== 0) {
      throw new MotionParamError(`keyframes: times[0] должен быть 0, получено ${opts.times[0]}`);
    }
    if (opts.times[n - 1] !== 1) {
      throw new MotionParamError(`keyframes: times[last] должен быть 1, получено ${opts.times[n - 1]}`);
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
      throw new MotionParamError(
        `keyframes: easing[].length (${opts.easing.length}) должен совпадать с числом сегментов (${segCount})`,
      );
    }
    easings = opts.easing;
  } else if (typeof opts.easing === 'function') {
    const fn = opts.easing;
    easings = new Array<EasingFn>(segCount).fill(fn);
  } else {
    easings = new Array<EasingFn>(segCount).fill(linearEasing);
  }

  const duration = opts.duration ?? 1;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MotionParamError(`keyframes: duration должен быть положительным конечным числом, получено ${duration}`);
  }

  const repeatRaw = opts.repeat ?? 0;
  if (repeatRaw !== Infinity && (!Number.isFinite(repeatRaw) || repeatRaw < 0 || Math.floor(repeatRaw) !== repeatRaw)) {
    throw new MotionParamError(`keyframes: repeat должен быть неотрицательным целым числом или Infinity, получено ${repeatRaw}`);
  }
  const repeat = repeatRaw;

  const repeatTypeRaw = opts.repeatType ?? 'loop';
  if (repeatTypeRaw !== 'loop' && repeatTypeRaw !== 'reverse' && repeatTypeRaw !== 'mirror') {
    throw new MotionParamError(`keyframes: repeatType должен быть 'loop'|'reverse'|'mirror', получено ${String(repeatTypeRaw)}`);
  }
  // 'mirror' — принимаемый алиас 'reverse' (yoyo); единая внутренняя обработка.
  const repeatType: KeyframesRepeatType = repeatTypeRaw === 'mirror' ? 'reverse' : repeatTypeRaw;

  const repeatDelay = opts.repeatDelay ?? 0;
  if (!Number.isFinite(repeatDelay) || repeatDelay < 0) {
    throw new MotionParamError(`keyframes: repeatDelay должен быть >= 0 и конечным, получено ${repeatDelay}`);
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

  const totalCycles = repeat === Infinity ? Infinity : repeat + 1;
  const cycleLen = duration + repeatDelay;
  const totalDuration =
    totalCycles === Infinity ? Infinity : duration * totalCycles + repeatDelay * repeat;

  const reduce = prefersReducedMotion(opts.matchMedia);

  const scheduleFrame: (cb: (ts?: number) => void) => number =
    opts.requestFrame ??
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
  let _useTimeoutFallback = false;
  let _frameCount = 0;

  let _resolve!: () => void;
  const _promise = new Promise<void>((res) => {
    _resolve = res;
  });

  /** Вычислить интерполированное значение при виртуальном времени vt. */
  function computeAt(vt: number): number {
    let cycleIndex = Math.floor(vt / cycleLen);
    if (totalCycles !== Infinity && cycleIndex >= totalCycles) cycleIndex = totalCycles - 1;
    if (cycleIndex < 0) cycleIndex = 0;

    const local = vt - cycleIndex * cycleLen;
    const phaseP = local <= duration ? clampFinite(local / duration) : 1;
    const phaseClamped = phaseP < 0 ? 0 : phaseP > 1 ? 1 : phaseP;

    const forward = repeatType === 'loop' || cycleIndex % 2 === 0;
    const effectiveP = forward ? phaseClamped : 1 - phaseClamped;

    return clampFinite(sampleKeyframes(values, times, easings, effectiveP));
  }

  function emit(value: number): void {
    if (globalOnStep) globalOnStep(value);
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
        // Safety cap — bail out at CURRENT position (not a real natural-complete).
        settle(computeAt(_vt));
        return;
      }

      let dt: number;
      if (ts !== undefined) {
        dt = _lastRealTs !== undefined ? (ts - _lastRealTs) / 1000 : FIXED_DT_S;
        _lastRealTs = ts;
      } else {
        dt = FIXED_DT_S;
      }
      if (dt <= 0) dt = FIXED_DT_S;

      _vt += dt;

      if (totalDuration !== Infinity && _vt >= totalDuration) {
        _vt = totalDuration;
        settle(lastCycleEndValue());
        return;
      }

      emit(computeAt(_vt));
    } finally {
      _tickActive = false;
    }

    if (_useTimeoutFallback) {
      setTimeout(tick, 0);
    } else {
      const h = scheduleFrame(tick);
      if (h === 0) {
        _useTimeoutFallback = true;
        setTimeout(tick, 0);
      }
    }
  }

  /** Значение на конце ПОСЛЕДНЕГО цикла (учитывает направление yoyo). */
  function lastCycleEndValue(): number {
    if (totalCycles === Infinity) return lastValue; // unreachable in practice
    const lastCycleIndex = totalCycles - 1;
    const forward = repeatType === 'loop' || lastCycleIndex % 2 === 0;
    return forward ? values[values.length - 1]! : values[0]!;
  }

  function ensureLoop(): void {
    if (_loopRunning || _settled || _paused) return;
    _loopRunning = true;
    const h = scheduleFrame(tick);
    if (h === 0) {
      _useTimeoutFallback = true;
      setTimeout(tick, 0);
    }
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
      let cycleIndex = Math.floor(_vt / cycleLen);
      if (totalCycles !== Infinity && cycleIndex >= totalCycles) cycleIndex = totalCycles - 1;
      const local = _vt - Math.max(0, cycleIndex) * cycleLen;
      const p = local <= duration ? local / duration : 1;
      return Math.min(1, Math.max(0, p));
    },

    play(): void {
      if (_settled) return;
      if (!_paused) return;
      _paused = false;
      _lastRealTs = undefined;
      ensureLoop();
    },

    pause(): void {
      _paused = true;
    },

    seek(t: number): void {
      if (_settled) return;
      if (Number.isNaN(t)) return;
      if (t === Infinity) {
        controls.complete();
        return;
      }
      const upper = totalDuration === Infinity ? Number.MAX_VALUE : totalDuration;
      _vt = Math.max(0, Math.min(upper, t));
      _lastRealTs = undefined;
      emit(computeAt(_vt));
    },

    complete(): void {
      if (_settled) return;
      // Совпадает с reduced-motion контрактом: мгновенный snap к финалу.
      _vt = totalDuration === Infinity ? _vt : totalDuration;
      settle(lastValue);
    },

    cancel(): void {
      if (_settled) return;
      settle(computeAt(_vt));
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
