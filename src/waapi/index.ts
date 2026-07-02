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
 * - repeatType 'loop' → direction 'normal'; 'reverse'/'mirror' → 'alternate';
 * - repeatDelay: у WAAPI нет per-iteration delay (только delay/endDelay) —
 *   пауза ЗАПЕКАЕТСЯ hold-сегментом: цикл растягивается до duration+repeatDelay,
 *   offsets сжимаются, хвост держит последнее значение. Пауза у движка только
 *   МЕЖДУ циклами (totalDuration = d·(repeat+1) + r·repeat, см. keyframes), а
 *   цикл WAAPI несёт hold всегда — поэтому последняя итерация обрезается
 *   ДРОБНЫМИ iterations = repeat + d/(d+r): активная длительность совпадает с
 *   движком точно, Animation.finished не запаздывает на хвостовой hold. Для
 *   'reverse'/'mirror' запекание исказило бы чётные циклы (hold оказался бы в
 *   начале обратного прохода) — комбинация отвергается рано, MotionParamError.
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
  /** Дополнительные повторы (0 = один прогон). Целое >= 0 или Infinity. */
  readonly repeat?: number;
  /** Политика повторов. По умолчанию 'loop'. */
  readonly repeatType?: 'loop' | 'reverse' | 'mirror';
  /** Пауза между циклами (секунды), >= 0. Запекается hold-сегментом. */
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
    throw new MotionParamError(
      `easingToLinear: points должен быть целым >= 2, получено ${points}`,
    );
  }
  const safe = normalizeEasing(fn);
  const stops: string[] = [];
  for (let i = 0; i < points; i++) {
    stops.push(String(Number(safe(i / (points - 1)).toFixed(4))));
  }
  return `linear(${stops.join(', ')})`;
}

// ─── Валидация compileWaapi ──────────────────────────────────────────────────

function validateOptions(o: WaapiCompileOptions): {
  times: readonly number[];
  duration: number;
  repeat: number;
  repeatType: 'loop' | 'reverse' | 'mirror';
  repeatDelay: number;
  segmentEasings: readonly WaapiEasingFn[] | undefined;
} {
  if (typeof o.property !== 'string' || o.property.length === 0) {
    throw new MotionParamError(`compileWaapi: property должен быть непустой строкой`);
  }
  // Эти имена — метаданные WAAPI-кейфрейма: значение перезаписало бы offset/easing
  // кадра. CSS-свойство offset в WAAPI пишется как cssOffset (MDN Keyframe Formats).
  if (o.property === 'offset' || o.property === 'easing' || o.property === 'composite') {
    throw new MotionParamError(
      `compileWaapi: property '${o.property}' конфликтует с полем WAAPI-кейфрейма` +
        (o.property === 'offset' ? `; CSS-свойство offset задаётся как 'cssOffset'` : ''),
    );
  }
  const n = o.values.length;
  if (n < 2) {
    throw new MotionParamError(`compileWaapi: values должен содержать >= 2 значений, получено ${n}`);
  }
  for (const v of o.values) {
    if (!Number.isFinite(v)) {
      throw new MotionParamError(`compileWaapi: values должны быть конечными, получено ${v}`);
    }
  }

  let times: readonly number[];
  if (o.times === undefined) {
    times = o.values.map((_, i) => i / (n - 1));
  } else {
    if (o.times.length !== n) {
      throw new MotionParamError(
        `compileWaapi: длина times (${o.times.length}) должна совпадать с values (${n})`,
      );
    }
    if (o.times[0] !== 0 || o.times[n - 1] !== 1) {
      throw new MotionParamError(`compileWaapi: times[0] должен быть 0, times[last] — 1`);
    }
    for (let i = 0; i < n; i++) {
      const t = o.times[i]!;
      if (!Number.isFinite(t) || (i > 0 && t < o.times[i - 1]!)) {
        throw new MotionParamError(`compileWaapi: times должны быть конечными и неубывающими`);
      }
    }
    times = o.times;
  }

  const duration = o.duration ?? 1;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MotionParamError(`compileWaapi: duration должен быть положительным конечным, получено ${duration}`);
  }

  const repeat = o.repeat ?? 0;
  if (repeat !== Infinity && (!Number.isInteger(repeat) || repeat < 0)) {
    throw new MotionParamError(
      `compileWaapi: repeat должен быть целым >= 0 или Infinity, получено ${repeat}`,
    );
  }

  const repeatDelay = o.repeatDelay ?? 0;
  if (!Number.isFinite(repeatDelay) || repeatDelay < 0) {
    throw new MotionParamError(
      `compileWaapi: repeatDelay должен быть конечным >= 0, получено ${repeatDelay}`,
    );
  }

  const repeatType = o.repeatType ?? 'loop';
  if (repeatType !== 'loop' && repeatType !== 'reverse' && repeatType !== 'mirror') {
    throw new MotionParamError(
      `compileWaapi: repeatType должен быть 'loop', 'reverse' или 'mirror', получено ${String(repeatType)}`,
    );
  }
  if (repeatDelay > 0 && repeat > 0 && repeatType !== 'loop') {
    throw new MotionParamError(
      `compileWaapi: repeatDelay с repeatType '${repeatType}' не поддерживается WAAPI-путём — ` +
        `hold-запекание исказило бы обратные циклы; используйте ./keyframes (rAF-путь) или 'loop'`,
    );
  }

  let segmentEasings: readonly WaapiEasingFn[] | undefined;
  if (o.easing !== undefined) {
    if (typeof o.easing === 'function') {
      segmentEasings = Array.from({ length: n - 1 }, () => o.easing as WaapiEasingFn);
    } else {
      if (!Array.isArray(o.easing)) {
        throw new MotionParamError(
          `compileWaapi: easing должен быть функцией или массивом функций, получено ${typeof o.easing}`,
        );
      }
      if (o.easing.length !== n - 1) {
        throw new MotionParamError(
          `compileWaapi: массив easing (${o.easing.length}) должен иметь length = values.length − 1 (${n - 1})`,
        );
      }
      for (const e of o.easing) {
        if (typeof e !== 'function') {
          throw new MotionParamError(
            `compileWaapi: каждый easing должен быть функцией, получено ${typeof e}`,
          );
        }
      }
      segmentEasings = o.easing;
    }
  }

  return { times, duration, repeat, repeatType, repeatDelay, segmentEasings };
}

// ─── compileWaapi ────────────────────────────────────────────────────────────

/** Чистая компиляция модели движка в аргументы Element.animate(). */
export function compileWaapi(options: WaapiCompileOptions): WaapiCompiled {
  const { times, duration, repeat, repeatType, repeatDelay, segmentEasings } =
    validateOptions(options);
  const { property, values } = options;
  const format = options.format ?? ((v: number): string | number => v);
  const points = options.easingPoints ?? DEFAULT_EASING_POINTS;
  const n = values.length;

  // Hold-запекание паузы между циклами (см. шапку). Без повторов пауза
  // не наблюдаема — нечего запекать.
  const bakeHold = repeatDelay > 0 && repeat > 0;
  const total = bakeHold ? duration + repeatDelay : duration;
  const scale = bakeHold ? duration / total : 1;

  const keyframes: Record<string, string | number>[] = [];
  for (let i = 0; i < n; i++) {
    const frame: Record<string, string | number> = {
      offset: times[i]! * scale,
      [property]: format(values[i]!),
    };
    if (segmentEasings !== undefined && i < n - 1) {
      frame['easing'] = easingToLinear(segmentEasings[i]!, points);
    }
    keyframes.push(frame);
  }
  if (bakeHold) {
    keyframes.push({ offset: 1, [property]: format(values[n - 1]!) });
  }

  return {
    keyframes,
    timing: {
      duration: total * 1000,
      // Пауза движка — только между циклами: при запекании последняя итерация
      // дробная, хвостовой hold обрезается (активная длительность = движковой).
      iterations:
        repeat === Infinity ? Infinity : bakeHold ? repeat + duration / total : repeat + 1,
      direction: repeatType === 'loop' ? 'normal' : 'alternate',
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
    throw new MotionParamError(
      `animateWaapi: цель не поддерживает WAAPI (нет метода animate); проверяйте supportsWaapi() и используйте rAF-путь как фоллбек`,
    );
  }
  const { fill, ...compileOptions } = options;
  const compiled = compileWaapi(compileOptions);
  return el.animate(compiled.keyframes, {
    ...compiled.timing,
    fill: fill ?? compiled.timing.fill,
  });
}
