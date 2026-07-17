/**
 * waapi/index.ts — WAAPI-эмит (subpath ./waapi).
 *
 * Закрывает S11 суперсета (compositor-путь, D11): конвертация модели движка
 * (values/times/per-segment easing/repeat) в нативные аргументы
 * Element.animate() — hw-accel и off-main-thread отдаёт браузер.
 *
 * Маппинг (заземлён MDN, цитаты в Graphiti research «S11 WAAPI»):
 * - times[i] → offset (оба: [0,1], по возрастанию);
 * - per-segment easing движка → per-keyframe easing WAAPI: у обоих действие
 *   «от этого кейфрейма до следующего», перенос 1:1; произвольная EasingFn
 *   эмитится строкой CSS linear() (Baseline с 12.2023) — равноудалённое
 *   сэмплирование, проценты не нужны;
 * - repeat (ДОПОЛНИТЕЛЬНЫЕ повторы) → iterations = repeat + 1 (ПОЛНОЕ число);
 * - repeatType 'loop' → direction 'normal'; 'reverse' → 'alternate'; mirror
 *   с repeat fail-closed: WAAPI alternate разворачивает time/easing и не
 *   эквивалентен перестановке generator values;
 * - repeatDelay: у WAAPI нет per-iteration delay. Бесконечный loop запекает
 *   паузу hold-сегментом в повторяемый цикл. Для конечного repeat ни дробная
 *   итерация, ни развёрнутый single-timeline не дают portable terminal/reset
 *   semantics во всех Chromium/Firefox/WebKit, поэтому compileWaapi/animateWaapi
 *   fail-closed с LM161 до host commit. Вызывающий должен направить такой track
 *   в канонический keyframes runner, где finite repeatDelay поддержан полностью.
 * - fill по умолчанию 'both': WAAPI-дефолт 'none' снэпает элемент обратно после
 *   finish — для анимационной библиотеки это сюрприз, не поведение.
 *
 * Детерминизм: чистые функции, сэмплирование фиксированной сеткой, округление
 * до 4 знаков. CSS-safe: выходы easing зашиты normalizeEasing (NaN→0, ±Inf→±MAX).
 * SSR-safe: ноль обращений к DOM-глобалам на импорте; supportsWaapi проверяет
 * среду только внутри вызова, animateWaapi duck-typed (тестируется без DOM).
 */

import { normalizeEasing } from '../easing/index.js';
import { MotionParamError } from '../errors.js';
import {
  isRepeatCount,
  isRepeatScheduleRepresentable,
} from '../internal/repeat-cursor.js';

/** Секция движка: easing-функция t∈[0,1] → значение. */
export type WaapiEasingFn = (t: number) => number;

/** Опции компиляции модели движка в аргументы Element.animate(). */
export interface WaapiCompileOptions {
  /** CSS-свойство кейфрейма (camelCase WAAPI, например 'opacity'). Непустое. */
  readonly property: string;
  /** Опорные значения, длина >= 2, конечные. */
  readonly values: readonly number[];
  /** Длительность одного цикла (секунды движка). > 0. По умолчанию 1. */
  readonly duration?: number;
  /** Доли [0,1] на значение: неубывающие, [0]=0, [last]=1. Нет → равномерно. */
  readonly times?: readonly number[];
  /** Easing на сегмент (один общий или массив length = values.length − 1). */
  readonly easing?: WaapiEasingFn | readonly WaapiEasingFn[];
  /** Дополнительные повторы: целое 0…2_147_483_647 или Infinity. */
  readonly repeat?: number;
  /** Политика повторов. По умолчанию 'loop'. */
  readonly repeatType?: 'loop' | 'reverse' | 'mirror';
  /** Пауза между циклами (секунды), >= 0. */
  readonly repeatDelay?: number;
  /** Форматтер значения (единицы/шаблоны). По умолчанию число как есть. */
  readonly format?: (v: number) => string | number;
  /** Точек сэмплирования на linear()-строку. Целое >= 2. По умолчанию 33. */
  readonly easingPoints?: number;
}

/** Скомпилированные аргументы Element.animate(keyframes, timing). */
export interface WaapiCompiled {
  readonly keyframes: Record<string, string | number>[];
  readonly timing: {
    /** Миллисекунды (конвенция WAAPI; движок считает в секундах). */
    readonly duration: number;
    readonly iterations: number;
    readonly direction: 'normal' | 'alternate';
    readonly fill: 'none' | 'forwards' | 'backwards' | 'both';
  };
}

const DEFAULT_EASING_POINTS = 33;

// ─── easingToLinear ──────────────────────────────────────────────────────────

/**
 * Произвольная EasingFn движка → строка CSS linear(). Равноудалённые стопы
 * (проценты по спеке не требуются), округление до 4 знаков — детерминированно
 * и компактно; выход зашит normalizeEasing (NE1).
 */
export function easingToLinear(fn: WaapiEasingFn, points: number = DEFAULT_EASING_POINTS): string {
  if (!Number.isInteger(points) || points < 2) {
    throw new MotionParamError('LM119');
  }
  const safe = normalizeEasing(fn);
  const stops: string[] = [];
  for (let i = 0; i < points; i++) {
    stops.push(String(Number(safe(i / (points - 1)).toFixed(4))));
  }
  return `linear(${stops.join(', ')})`;
}

// ─── Валидация compileWaapi ──────────────────────────────────────────────────

type ValidatedOptions = readonly [
  property: string,
  values: readonly number[],
  times: readonly number[] | undefined,
  duration: number,
  repeat: number,
  repeatType: 'loop' | 'reverse' | 'mirror',
  repeatDelay: number,
  easing: WaapiEasingFn | readonly WaapiEasingFn[] | undefined,
];

function validateOptions(o: WaapiCompileOptions): ValidatedOptions {
  const property = o.property;
  if (typeof property !== 'string' || property.length === 0) {
    throw new MotionParamError('LM120');
  }
  // Эти имена — метаданные WAAPI-кейфрейма: значение перезаписало бы offset/easing
  // кадра. CSS-свойство offset в WAAPI пишется как cssOffset (MDN Keyframe Formats).
  if (property === 'offset' || property === 'easing' || property === 'composite') {
    throw new MotionParamError('LM121');
  }

  const values = [...o.values];
  const n = values.length;
  if (n < 2) {
    throw new MotionParamError('LM122');
  }
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new MotionParamError('LM123');
    }
  }

  const sourceTimes = o.times;
  const times = sourceTimes === undefined ? undefined : [...sourceTimes];
  if (times !== undefined) {
    if (times.length !== n) {
      throw new MotionParamError('LM124');
    }
    if (times[0] !== 0 || times[n - 1] !== 1) {
      throw new MotionParamError('LM125');
    }
    for (let i = 0; i < n; i++) {
      const t = times[i]!;
      if (!Number.isFinite(t) || (i > 0 && t < times[i - 1]!)) {
        throw new MotionParamError('LM126');
      }
    }
  }

  const duration = o.duration ?? 1;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MotionParamError('LM127');
  }

  const repeat = o.repeat ?? 0;
  if (!isRepeatCount(repeat)) {
    throw new MotionParamError('LM128');
  }

  const repeatDelay = o.repeatDelay ?? 0;
  if (!Number.isFinite(repeatDelay) || repeatDelay < 0) {
    throw new MotionParamError('LM129');
  }

  const repeatType = o.repeatType ?? 'loop';
  if (repeatType !== 'loop' && repeatType !== 'reverse' && repeatType !== 'mirror') {
    throw new MotionParamError('LM130');
  }
  if (!isRepeatScheduleRepresentable(0, duration, repeat, repeatDelay)) {
    throw new MotionParamError('LM161');
  }
  if (repeat > 0 && repeatType === 'mirror') {
    throw new MotionParamError('LM160');
  }
  if (repeatDelay > 0 && repeat > 0 && repeatType !== 'loop') {
    throw new MotionParamError('LM131');
  }
  if (repeatDelay > 0 && repeat > 0 && repeat !== Infinity) {
    throw new MotionParamError('LM161');
  }
  const sourceEasing = o.easing;
  const easing = Array.isArray(sourceEasing) ? [...sourceEasing] : sourceEasing;
  if (easing !== undefined && typeof easing !== 'function') {
      if (!Array.isArray(easing)) {
        throw new MotionParamError('LM132');
      }
      if (easing.length !== n - 1) {
        throw new MotionParamError('LM133');
      }
      for (const e of easing) {
        if (typeof e !== 'function') {
          throw new MotionParamError('LM134');
        }
      }
  }

  return [property, values, times, duration, repeat, repeatType, repeatDelay, easing];
}

// ─── compileWaapi ────────────────────────────────────────────────────────────

/** Чистая компиляция модели движка в аргументы Element.animate(). */
export function compileWaapi(options: WaapiCompileOptions): WaapiCompiled {
  const [property, values, times, duration, repeat, repeatType, repeatDelay, easing] =
    validateOptions(options);
  const n = values.length;

  // После validation hold возможен здесь только у infinite loop. Без повторов
  // repeatDelay ненаблюдаем и не меняет артефакт.
  const bakeHold = repeatDelay > 0 && repeat > 0;
  const total = bakeHold ? duration + repeatDelay : duration;
  const scale = bakeHold ? duration / total : 1;
  const timingDuration = total * 1000;
  const iterations = repeat === Infinity ? Infinity : repeat + 1;
  if (!Number.isFinite(timingDuration) || !(timingDuration > 0) ||
    !Number.isFinite(scale) || !(scale > 0)) {
    throw new MotionParamError('LM162');
  }
  if (repeat !== Infinity && !(iterations > repeat)) {
    throw new MotionParamError('LM161');
  }
  if (repeat !== Infinity && !Number.isFinite(timingDuration * iterations)) {
    throw new MotionParamError('LM162');
  }
  // Positive scaling is monotone mathematically, but two distinct binary64
  // authored stops can round onto one WAAPI offset. Preflight every stop before
  // user format/easing callbacks; authored duplicates remain intentional jumps.
  if (scale !== 1) {
    let previousSource = times === undefined ? 0 : times[0]!;
    let previousOffset = previousSource * scale;
    for (let i = 1; i < n; i++) {
      const source = times === undefined ? i / (n - 1) : times[i]!;
      const offset = source * scale;
      if (source > previousSource && !(offset > previousOffset)) {
        throw new MotionParamError('LM162');
      }
      previousSource = source;
      previousOffset = offset;
    }
  }
  const format = options.format ?? ((v: number): string | number => v);
  const points = options.easingPoints ?? DEFAULT_EASING_POINTS;
  const keyframes: Record<string, string | number>[] = [];
  for (let i = 0; i < n; i++) {
    const frame: Record<string, string | number> = {
      offset: (times === undefined ? i / (n - 1) : times[i]!) * scale,
      [property]: format(values[i]!),
    };
    if (easing !== undefined && i < n - 1) {
      frame['easing'] = easingToLinear(
        typeof easing === 'function' ? easing : easing[i]!,
        points,
      );
    }
    keyframes.push(frame);
  }
  if (bakeHold) {
    keyframes.push({ offset: 1, [property]: format(values[n - 1]!) });
  }

  return {
    keyframes,
    timing: {
      duration: timingDuration,
      iterations,
      direction: repeatType === 'reverse' ? 'alternate' : 'normal',
      fill: 'both',
    },
  };
}

// ─── supportsWaapi / animateWaapi ────────────────────────────────────────────

/**
 * Feature-detect WAAPI. С целью — duck-typing её animate; без цели — проверка
 * среды (Element.prototype.animate), выполняемая только внутри вызова.
 */
export function supportsWaapi(target?: unknown): boolean {
  if (target !== undefined) {
    return (
      target !== null &&
      typeof (target as { animate?: unknown }).animate === 'function'
    );
  }
  return (
    typeof Element !== 'undefined' &&
    typeof (Element as { prototype?: { animate?: unknown } }).prototype?.animate === 'function'
  );
}

/** Минимальный duck-typed контракт цели (реальный Element ему соответствует). */
export interface WaapiAnimatable {
  animate(keyframes: Record<string, string | number>[], timing: object): unknown;
}

/**
 * Тонкий адаптер: компилирует и коммитит в el.animate(). Возвращает нативный
 * Animation (play/pause/reverse/finished — у браузера). Отсутствие WAAPI у
 * цели — MotionParamError рано, до компиляции (конвенция движка).
 */
export function animateWaapi(
  el: WaapiAnimatable,
  options: WaapiCompileOptions & { fill?: WaapiCompiled['timing']['fill'] },
): unknown {
  if (!supportsWaapi(el)) {
    throw new MotionParamError('LM135');
  }
  const { fill, ...compileOptions } = options;
  const compiled = compileWaapi(compileOptions);
  return el.animate(compiled.keyframes, {
    ...compiled.timing,
    fill: fill ?? compiled.timing.fill,
  });
}
