/**
 * presets/index.ts — generic-пресеты анимаций: headless словарь движений.
 *
 * Зачем: потребители уровня иконок/микро-UI (lab-icons и др.) собирают
 * семантические хореографии («зрачок пульсирует», «курсор мигает», «искры
 * разлетаются каскадом») из небольшого словаря generic-движений. Пресет —
 * это ЧИСТАЯ параметризованная спецификация мультитрековых кейфреймов
 * (PresetSpec), а не привязка к DOM: один момент времени t → значение каждого
 * трека (scale/rotate/x/y/opacity/progress). Канал `progress` — generic 0→1
 * (потребитель мапит его на draw-on clip-reveal и т.п.).
 *
 * Инварианты (North, наследуют keyframes/stagger):
 *   1. Zero runtime deps — нет внешних npm-зависимостей.
 *   2. CSS-safe — сэмплы ВСЕГДА конечны: values валидированы compilePreset,
 *      нормализацию хостильного времени делает samplePreset, конечность
 *      значений гарантируют внутренние guards sampleKeyframes.
 *   3. Детерминизм — samplePreset чист; runPreset использует injectable clock
 *      (requestFrame seam); одинаковые входы → бит-идентичный вывод.
 *   4. Reduced-motion — CHARACTER-switch в runPreset: конечный repeat →
 *      мгновенный снэп к финальной позе; repeat=Infinity (ambient-луп) →
 *      нейтральная поза t=0. НЕ hard-off: поза эмитируется ровно один раз.
 *   5. Domain purity / SSR-safe — ни DOM, ни window/document на верхнем уровне.
 *   6. Валидация ТОЛЬКО в compilePreset (MotionParamError, по-русски,
 *      префикс "presets:"); samplePreset — горячий путь без проверок.
 */

import { easeOut, sineInOut } from '../easing/index.js';
import { MotionParamError } from '../errors.js';
import { createFrameRequester } from '../internal/frame-requester.js';
import {
  isRepeatScheduleRepresentable,
  isRepeatCount,
  repeatCursor,
  repeatEndTime,
  type RepeatDirection,
} from '../internal/repeat-cursor.js';
import { sampleKeyframesUnchecked } from '../internal/sample-keyframes.js';
import {
  type EasingFn,
  type MatchMediaResult,
} from '../keyframes/index.js';
import { duration as durationTokens, staggerGap } from '../tokens/index.js';

export type { EasingFn, MatchMediaResult };

// ─── Публичные типы ──────────────────────────────────────────────────────────

/**
 * Анимируемое свойство трека. Закрытый перечень:
 * трансформы (scale/scaleX/scaleY/rotate/x/y), opacity и generic-канал
 * progress (0→1, потребитель интерпретирует: draw-on, variable-color-порог…).
 */
export type PresetProperty =
  | 'scale'
  | 'scaleX'
  | 'scaleY'
  | 'rotate'
  | 'x'
  | 'y'
  | 'opacity'
  | 'progress';

/** Политика повторов — семантика идентична keyframes. */
export type PresetRepeatType = 'loop' | 'reverse' | 'mirror';

/** Один трек пресета: опорные значения одного свойства во времени цикла. */
export interface PresetTrack {
  /** Свойство из закрытого перечня PresetProperty. Уникально в рамках спеки. */
  readonly property: PresetProperty;
  /** Опорные значения. Длина >= 2, каждое конечно. */
  readonly values: readonly number[];
  /**
   * Доли [0,1] на каждое значение (как в keyframes): неубывающие,
   * times[0]=0, times[last]=1. Не задано → равномерное авто-распределение.
   */
  readonly times?: readonly number[];
  /** Easing на сегмент: функция или массив функций длиной values.length-1. */
  readonly easing?: EasingFn | readonly EasingFn[];
}

/** Спецификация пресета: мультитрековые кейфреймы одного цикла + повторы. */
export interface PresetSpec {
  /** Длительность ОДНОГО цикла (секунды). > 0, конечна. */
  readonly duration: number;
  /** Треки. Минимум один; property уникальны. */
  readonly tracks: readonly PresetTrack[];
  /**
   * Задержка старта (секунды, >= 0). До истечения delay сэмплер держит
   * позу t=0 (первые значения треков) — слой видим и статичен, не «пуст».
   */
  readonly delay?: number;
  /** Дополнительные циклы: целое 0…2_147_483_647 или Infinity. По умолчанию 0. */
  readonly repeat?: number;
  /** Политика направления повторов. По умолчанию 'loop'. */
  readonly repeatType?: PresetRepeatType;
  /** Пауза между циклами (секунды, >= 0), держит конец цикла. По умолчанию 0. */
  readonly repeatDelay?: number;
}

/** Сэмпл пресета: значения ТОЛЬКО тех свойств, что есть в треках спеки. */
export type PresetValues = Partial<Record<PresetProperty, number>>;

/**
 * Скомпилированный пресет — нормализованная валидная форма для горячего
 * сэмплирования. Получается ТОЛЬКО через compilePreset(); поля readonly,
 * структура брендирована маркером от подсовывания сырой PresetSpec.
 */
export interface CompiledPreset {
  /** Брендирующий маркер — защита от подсовывания сырой PresetSpec. */
  readonly __compiledPreset: true;
  readonly duration: number;
  readonly delay: number;
  readonly repeat: number;
  readonly repeatType: PresetRepeatType;
  readonly repeatDelay: number;
  readonly tracks: readonly CompiledTrack[];
}

interface CompiledTrack {
  readonly property: PresetProperty;
  readonly values: readonly number[];
  readonly times: readonly number[];
  readonly easings: readonly EasingFn[];
}

// ─── Внутренние константы/хелперы ────────────────────────────────────────────

const PRESET_PROPERTIES: readonly PresetProperty[] = [
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'x',
  'y',
  'opacity',
  'progress',
];

function linearEasing(t: number): number {
  return t;
}

// ─── compilePreset: валидация и нормализация ─────────────────────────────────

/**
 * Валидирует и нормализует PresetSpec. Единственная точка валидации subpath:
 * всё структурно невалидное падает здесь MotionParamError (по-русски),
 * а не превращается тихо в NaN на кадре.
 *
 * @throws MotionParamError при невалидной спеке.
 */
export function compilePreset(spec: PresetSpec): CompiledPreset {
  if (!spec || typeof spec !== 'object') {
    throw new MotionParamError('LM046');
  }

  const duration = spec.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MotionParamError('LM047');
  }

  const rawTracks = spec.tracks;
  if (!rawTracks || rawTracks.length < 1) {
    throw new MotionParamError('LM048');
  }

  const seen = new Set<PresetProperty>();
  const tracks: CompiledTrack[] = [];
  for (let ti = 0; ti < rawTracks.length; ti++) {
    const track = rawTracks[ti]!;
    const property = track.property;
    if (!PRESET_PROPERTIES.includes(property)) {
      throw new MotionParamError('LM049');
    }
    if (seen.has(property)) {
      throw new MotionParamError('LM050');
    }
    seen.add(property);

    const values = track.values;
    if (!values || values.length < 2) {
      throw new MotionParamError('LM051');
    }
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i])) {
        throw new MotionParamError('LM052');
      }
    }

    const n = values.length;
    let times: readonly number[];
    if (track.times !== undefined) {
      if (track.times.length !== n) {
        throw new MotionParamError('LM053');
      }
      for (let i = 0; i < n; i++) {
        const t = track.times[i]!;
        if (!Number.isFinite(t)) {
          throw new MotionParamError('LM054');
        }
        if (i > 0 && t < track.times[i - 1]!) {
          throw new MotionParamError('LM055');
        }
      }
      if (track.times[0] !== 0) {
        throw new MotionParamError('LM056');
      }
      if (track.times[n - 1] !== 1) {
        throw new MotionParamError('LM057');
      }
      times = track.times;
    } else {
      const auto = new Array<number>(n);
      for (let i = 0; i < n; i++) auto[i] = i / (n - 1);
      times = auto;
    }

    const segCount = n - 1;
    let easings: readonly EasingFn[];
    if (Array.isArray(track.easing)) {
      if (track.easing.length !== segCount) {
        throw new MotionParamError('LM058');
      }
      for (let i = 0; i < segCount; i++) {
        if (typeof track.easing[i] !== 'function') {
          throw new MotionParamError('LM164');
        }
      }
      easings = track.easing;
    } else if (typeof track.easing === 'function') {
      easings = new Array<EasingFn>(segCount).fill(track.easing);
    } else if (track.easing === undefined) {
      easings = new Array<EasingFn>(segCount).fill(linearEasing);
    } else {
      throw new MotionParamError('LM164');
    }

    tracks.push({ property, values, times, easings });
  }

  const delay = spec.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new MotionParamError('LM059');
  }

  const repeatRaw = spec.repeat ?? 0;
  if (!isRepeatCount(repeatRaw)) {
    throw new MotionParamError('LM060');
  }

  const repeatTypeRaw = spec.repeatType ?? 'loop';
  if (repeatTypeRaw !== 'loop' && repeatTypeRaw !== 'reverse' && repeatTypeRaw !== 'mirror') {
    throw new MotionParamError('LM061');
  }
  const repeatDelay = spec.repeatDelay ?? 0;
  if (!Number.isFinite(repeatDelay) || repeatDelay < 0) {
    throw new MotionParamError('LM062');
  }
  if (!isRepeatScheduleRepresentable(delay, duration, repeatRaw, repeatDelay)) {
    throw new MotionParamError('LM161');
  }

  return {
    __compiledPreset: true,
    duration,
    delay,
    repeat: repeatRaw,
    repeatType: repeatTypeRaw,
    repeatDelay,
    tracks,
  };
}

// ─── Длительность ────────────────────────────────────────────────────────────

/**
 * Суммарная длительность пресета с учётом delay/repeat/repeatDelay (секунды).
 * Infinity при repeat=Infinity — метаданные, не эмитируемое значение.
 */
export function presetTotalDuration(compiled: CompiledPreset): number {
  return repeatEndTime(
    compiled.delay,
    compiled.duration,
    compiled.repeat,
    compiled.repeatDelay,
  );
}

// ─── samplePreset: чистый горячий сэмплер ────────────────────────────────────

/**
 * Значения всех треков пресета в момент tSeconds (от нуля общей шкалы,
 * delay входит в шкалу). Чистая функция без состояния и валидации
 * (контракт: compiled получен из compilePreset).
 *
 * Хостильное t: NaN → поза t=0; -Infinity/отрицательное → поза t=0;
 * конечный schedule после terminal → последняя поза (yoyo-aware).
 * Infinite schedule за точным integer-горизонтом, включая +Infinity, → LM166.
 * Нормализация принадлежит единому repeat cursor; конечность значений —
 * внутреннему keyframe sampler (инвариант 2).
 * @throws MotionParamError LM166, если infinite sample требует неточный индекс.
 */
function samplePresetCursor(compiled: CompiledPreset, cursor: number): PresetValues {
  const { tracks } = compiled;
  const progress = cursor < 0 ? -1 - cursor : cursor;
  const mirrored = cursor < 0;

  const out: PresetValues = {};
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    out[track.property] = sampleKeyframesUnchecked(
      track.values,
      track.times,
      track.easings,
      progress,
      mirrored,
    );
  }
  return out;
}

export function samplePreset(compiled: CompiledPreset, tSeconds: number): PresetValues {
  const { duration, repeat, repeatType, repeatDelay } = compiled;
  const direction: RepeatDirection = repeatType === 'reverse' ? 1 : repeatType === 'mirror' ? 2 : 0;
  const cursor = repeatCursor(
    tSeconds,
    compiled.delay,
    duration,
    repeat,
    repeatDelay,
    direction,
  );
  return samplePresetCursor(compiled, cursor);
}

// ─── Фабрики пресетов ────────────────────────────────────────────────────────
//
// Дефолты калиброваны по вкусовому эталону владельца (4 Lottie с lab.pics,
// разбор: .agents/research/animated-icons-domain/lab-pics-lottie/REFS-LABPICS.md):
// мягкие амплитуды (scale-пульс ~0.12, wiggle ~8°), 3-7 опорных точек,
// identity-краевые позы (после анимации иконка выглядит как статическая),
// тайминги: ~0.5-1с акцент / 2-3с сюжет / ~5с ambient-луп.
//
// Фабрика возвращает НЕкомпилированную PresetSpec — потребитель может
// расширить спредом ({...pulse(), repeat: 2}) и компилирует при использовании.

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new MotionParamError('LM063');
  }
}

function assertDuration(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MotionParamError('LM064');
  }
}

export interface PulseOptions {
  /** Амплитуда прироста масштаба в пике. По умолчанию 0.12 (мягкий пульс). */
  readonly amount?: number;
  /** Длительность цикла, с. По умолчанию 0.9. */
  readonly duration?: number;
}

/** Пульс масштаба: 1 → 1+amount → 1 (зрачок из эталона ref-1). */
export function pulse(opts: PulseOptions = {}): PresetSpec {
  const amount = opts.amount ?? 0.12;
  const duration = opts.duration ?? 0.9;
  assertFinite('pulse.amount', amount);
  assertDuration('pulse', duration);
  if (amount <= -1) {
    throw new MotionParamError('LM065');
  }
  return {
    duration,
    tracks: [{ property: 'scale', values: [1, 1 + amount, 1], easing: sineInOut }],
  };
}

export interface BlinkOptions {
  /** Минимальная непрозрачность в провале, [0,1]. По умолчанию 0. */
  readonly min?: number;
  /** Длительность цикла, с. По умолчанию 1 (курсор из эталона ref-2). */
  readonly duration?: number;
}

/** Мигание непрозрачности: 1 → min → 1, бесконечный луп (курсор терминала). */
export function blink(opts: BlinkOptions = {}): PresetSpec {
  const min = opts.min ?? 0;
  const duration = opts.duration ?? 1;
  assertFinite('blink.min', min);
  assertDuration('blink', duration);
  if (min < 0 || min > 1) {
    throw new MotionParamError('LM066');
  }
  return {
    duration,
    repeat: Infinity,
    tracks: [{ property: 'opacity', values: [1, min, 1], easing: sineInOut }],
  };
}

export interface WiggleOptions {
  /** Максимальный угол отклонения, градусы. По умолчанию 8 (мягкое покачивание). */
  readonly degrees?: number;
  /** Число свингов (смен направления). Целое >= 1. По умолчанию 3. */
  readonly cycles?: number;
  /** Длительность, с. По умолчанию 0.8. */
  readonly duration?: number;
}

/**
 * Покачивание вокруг якоря с затухающей амплитудой: 0 → +d → −d·k → … → 0
 * (колокольчик уведомлений). Первый свинг — в ПЛЮС (по часовой), затухание
 * линейное: движение читаемое, не дёрганое. Направление первого свинга —
 * часть контракта (запинено тестом).
 */
export function wiggle(opts: WiggleOptions = {}): PresetSpec {
  const degrees = opts.degrees ?? 8;
  const cycles = opts.cycles ?? 3;
  const duration = opts.duration ?? 0.8;
  assertFinite('wiggle.degrees', degrees);
  assertDuration('wiggle', duration);
  if (!Number.isFinite(cycles) || cycles < 1 || Math.floor(cycles) !== cycles) {
    throw new MotionParamError('LM067');
  }
  const values: number[] = [0];
  for (let k = 1; k <= cycles; k++) {
    const amp = (degrees * (cycles - k + 1)) / cycles;
    values.push(k % 2 === 1 ? amp : -amp);
  }
  values.push(0);
  return {
    duration,
    tracks: [{ property: 'rotate', values, easing: sineInOut }],
  };
}

export interface SpinOptions {
  /** Число оборотов (отрицательное — против часовой). По умолчанию 1. */
  readonly turns?: number;
  /** Длительность, с. По умолчанию 1. */
  readonly duration?: number;
}

/** Оборот: rotate 0 → 360×turns (обновление/загрузка). */
export function spin(opts: SpinOptions = {}): PresetSpec {
  const turns = opts.turns ?? 1;
  const duration = opts.duration ?? 1;
  assertFinite('spin.turns', turns);
  assertDuration('spin', duration);
  return {
    duration,
    tracks: [{ property: 'rotate', values: [0, 360 * turns], easing: sineInOut }],
  };
}

export interface BreatheOptions {
  /** Амплитуда прироста масштаба. По умолчанию 0.05 (заметно мягче pulse). */
  readonly amount?: number;
  /** Длительность цикла, с. По умолчанию 2.6 (ambient). */
  readonly duration?: number;
}

/** Дыхание: медленный мягкий пульс масштаба, бесконечный ambient-луп. */
export function breathe(opts: BreatheOptions = {}): PresetSpec {
  const amount = opts.amount ?? 0.05;
  const duration = opts.duration ?? 2.6;
  assertFinite('breathe.amount', amount);
  assertDuration('breathe', duration);
  if (amount <= -1) {
    throw new MotionParamError('LM068');
  }
  return {
    duration,
    repeat: Infinity,
    tracks: [{ property: 'scale', values: [1, 1 + amount, 1], easing: sineInOut }],
  };
}

export interface PopOptions {
  /** Пик перелёта масштаба перед оседанием в 1. По умолчанию 1.18. */
  readonly overshoot?: number;
  /** Длительность, с. По умолчанию 0.5. */
  readonly duration?: number;
}

/** Появление с перелётом: scale 0 → overshoot → 1 (Appear-класс). */
export function pop(opts: PopOptions = {}): PresetSpec {
  const overshoot = opts.overshoot ?? 1.18;
  const duration = opts.duration ?? 0.5;
  assertFinite('pop.overshoot', overshoot);
  assertDuration('pop', duration);
  if (overshoot <= 0) {
    throw new MotionParamError('LM069');
  }
  return {
    duration,
    tracks: [
      {
        property: 'scale',
        values: [0, overshoot, 1],
        times: [0, 0.7, 1],
        easing: [easeOut, sineInOut],
      },
    ],
  };
}

export interface BounceYOptions {
  /** Высота подскока, единицы координат (для 24px-иконки ~2-4). По умолчанию 2.5. */
  readonly height?: number;
  /** Длительность, с. По умолчанию 0.6. */
  readonly duration?: number;
}

/** Подскок: y 0 → −height → 0 → −height·0.35 → 0 (второй отскок ниже). */
export function bounceY(opts: BounceYOptions = {}): PresetSpec {
  const height = opts.height ?? 2.5;
  const duration = opts.duration ?? 0.6;
  assertFinite('bounceY.height', height);
  assertDuration('bounceY', duration);
  return {
    duration,
    tracks: [
      {
        property: 'y',
        values: [0, -height, 0, -height * 0.35, 0],
        times: [0, 0.3, 0.6, 0.8, 1],
        easing: sineInOut,
      },
    ],
  };
}

export interface DriftOptions {
  /** Дрейф по x (единицы координат). По умолчанию 0 — трек не создаётся. */
  readonly dx?: number;
  /** Дрейф по y. По умолчанию −1.5 (лёгкий подъём, звёзды из эталона ref-3). */
  readonly dy?: number;
  /** Длительность цикла, с. По умолчанию 5 (ambient). */
  readonly duration?: number;
}

/** Ambient-дрейф: плавный уход к (dx,dy) и возврат, бесконечный луп. */
export function drift(opts: DriftOptions = {}): PresetSpec {
  const dx = opts.dx ?? 0;
  const dy = opts.dy ?? -1.5;
  const duration = opts.duration ?? 5;
  assertFinite('drift.dx', dx);
  assertFinite('drift.dy', dy);
  assertDuration('drift', duration);
  if (dx === 0 && dy === 0) {
    throw new MotionParamError('LM070');
  }
  const tracks: PresetTrack[] = [];
  if (dx !== 0) tracks.push({ property: 'x', values: [0, dx, 0], easing: sineInOut });
  if (dy !== 0) tracks.push({ property: 'y', values: [0, dy, 0], easing: sineInOut });
  return { duration, repeat: Infinity, tracks };
}

export interface FadeSlideOptions {
  /** Начальное смещение по x (движение к 0). По умолчанию 0 — трек не создаётся. */
  readonly dx?: number;
  /** Начальное смещение по y. По умолчанию 4. */
  readonly dy?: number;
  /** Длительность, с. По умолчанию 0.35. */
  readonly duration?: number;
}

/** Появление со сдвигом: opacity 0→1, смещение (dx,dy)→0 (Appear-класс). */
export function fadeSlide(opts: FadeSlideOptions = {}): PresetSpec {
  const dx = opts.dx ?? 0;
  const dy = opts.dy ?? 4;
  const duration = opts.duration ?? 0.35;
  assertFinite('fadeSlide.dx', dx);
  assertFinite('fadeSlide.dy', dy);
  assertDuration('fadeSlide', duration);
  const tracks: PresetTrack[] = [
    { property: 'opacity', values: [0, 1], easing: easeOut },
  ];
  if (dx !== 0) tracks.push({ property: 'x', values: [dx, 0], easing: easeOut });
  if (dy !== 0) tracks.push({ property: 'y', values: [dy, 0], easing: easeOut });
  return { duration, tracks };
}

export interface DrawOnOptions {
  /** Длительность рисования, с. По умолчанию 1.2. */
  readonly duration?: number;
}

/**
 * Канал прогресса рисования: progress 0→1 монотонно (BL-002 «кисточка рисует»).
 * Потребитель мапит progress на технику раскрытия (clip-path вдоль guide-пути,
 * variable-draw порог и т.п.) — сам пресет остаётся headless-числом.
 */
export function drawOn(opts: DrawOnOptions = {}): PresetSpec {
  const duration = opts.duration ?? 1.2;
  assertDuration('drawOn', duration);
  return {
    duration,
    tracks: [{ property: 'progress', values: [0, 1], easing: sineInOut }],
  };
}

// ─── runPreset: управляемый frame-loop ───────────────────────────────────────

const FIXED_DT_S = 1 / 60;
/** Safety-cap кадров — идентичен keyframes/timeline MAX_FRAMES. */
const MAX_FRAMES = 100_000;

/** Опции runPreset — injectable seams в дисциплине keyframes(). */
export interface RunPresetOptions {
  /** Колбэк на каждый шаг: значения ВСЕХ треков в текущий момент. */
  readonly onUpdate?: (values: PresetValues) => void;
  /** Injectable requestAnimationFrame-заменитель. Возврат 0 = timeout-fallback. */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /** Injectable matchMedia. undefined = SSR / нет предпочтений (reduce=false). */
  readonly matchMedia?: ((query: string) => MatchMediaResult) | undefined;
}

/** Управляемый хендл пресета. Thenable — `await runPreset(...)`. */
export interface PresetControls {
  /** Суммарная длительность c delay/repeat (секунды); Infinity при repeat=∞. */
  readonly totalDuration: number;
  /** Текущее виртуальное время (секунды) от старта (delay входит в шкалу). */
  readonly time: number;
  /** Прогресс ТЕКУЩЕГО цикла [0,1]. */
  readonly progress: number;
  /** Возобновить (no-op если играет или завершён). */
  play(): void;
  /** Пауза (замораживает виртуальное время). */
  pause(): void;
  /** NaN → no-op; +Infinity завершает finite, а для repeat=∞ даёт LM166. */
  seek(t: number): void;
  /** Снэп к финальной позе (repeat=∞ → нейтральная поза t=0) и резолв. */
  complete(): void;
  /** Остановиться в текущей позиции и резолвить. */
  cancel(): void;
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2>;
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

function isCompiled(spec: PresetSpec | CompiledPreset): spec is CompiledPreset {
  return (spec as CompiledPreset).__compiledPreset === true;
}

/**
 * Проигрывает пресет ОДНИМ frame-loop'ом на все треки (детерминизм: один clock,
 * один сэмпл на кадр). Начинает немедленно (если не reduced-motion).
 *
 * Reduced-motion CHARACTER-switch (инвариант 4): конечный repeat → синхронный
 * снэп к финальной позе; repeat=Infinity (ambient-луп без финала) → нейтральная
 * поза t=0. Поза эмитируется ровно один раз — потребитель ПОЛУЧАЕТ статичную
 * валидную позу, а не «ничего» (НЕ hard-off).
 *
 * @throws MotionParamError при невалидной спеке (через compilePreset).
 */
export function runPreset(
  spec: PresetSpec | CompiledPreset,
  opts: RunPresetOptions = {},
): PresetControls {
  const compiled = isCompiled(spec) ? spec : compilePreset(spec);
  const totalDuration = presetTotalDuration(compiled);
  const repeatDirection: RepeatDirection = compiled.repeatType === 'reverse'
    ? 1
    : compiled.repeatType === 'mirror'
      ? 2
      : 0;
  const onUpdate = opts.onUpdate;

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
  let _queuedTime = 0;
  let _queuedSettling = false;
  let _queuedCursor: number | undefined;

  let _resolve!: () => void;
  const _promise = new Promise<void>((res) => {
    _resolve = res;
  });

  function emit(values: PresetValues): void {
    if (!onUpdate) return;
    try {
      onUpdate(values);
    } catch {
      // Изоляция ошибок пользовательского колбэка — луп/промис живут дальше.
    }
  }

  function settle(finalValues: PresetValues): void {
    if (_settled) return;
    _settled = true;
    _loopRunning = false;
    try {
      emit(finalValues);
    } finally {
      _resolve();
    }
  }

  /**
   * A reentrant control gets one deferred sample. Further sampling controls
   * raised by that easing are ignored so it cannot recurse or livelock.
   */
  function samplePublication(
    time: number,
    provenCursor: number | undefined,
    phase: 1 | 2,
  ): PresetValues {
    _samplingPhase = phase;
    try {
      return provenCursor === undefined
        ? samplePreset(compiled, time)
        : samplePresetCursor(compiled, provenCursor);
    } finally {
      _samplingPhase = 0;
    }
  }

  function publishAt(time: number, settling: boolean, provenCursor?: number): void {
    let owner = ++_operation;
    if (_samplingPhase !== 0) {
      _publicationQueued = true;
      _queuedTime = time;
      _queuedSettling = settling;
      _queuedCursor = provenCursor;
      return;
    }

    // A throwing easing can leave only a stale private intent behind.
    _publicationQueued = false;
    let values = samplePublication(time, provenCursor, 1);
    if (_publicationQueued) {
      _publicationQueued = false;
      if (_settled) return;
      owner = _operation;
      settling = _queuedSettling;
      values = samplePublication(_queuedTime, _queuedCursor, 2);
    }

    if (owner !== _operation || _settled) return;
    if (settling) settle(values);
    else emit(values);
  }

  function tick(ts?: number): void {
    if (_settled) {
      _loopRunning = false;
      return;
    }
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
          // Safety cap — выходим в ТЕКУЩЕЙ позиции (не «естественный» финал).
          publishAt(_vt, true);
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
      if (totalDuration === Infinity) {
        provenCursor = repeatCursor(
          nextVt,
          compiled.delay,
          compiled.duration,
          compiled.repeat,
          compiled.repeatDelay,
          repeatDirection,
        );
      }
      _lastRealTs = nextRealTs;
      _vt = nextVt;

      if (totalDuration !== Infinity && _vt >= totalDuration) {
        _vt = totalDuration;
        publishAt(_vt, true);
        return;
      }

      publishAt(_vt, false, provenCursor);
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

  function ensureLoop(): void {
    if (_loopRunning || _settled || _paused) return;
    _loopRunning = true;
    requestNextFrame();
  }

  // ── Reduced-motion CHARACTER-switch — синхронно, до старта лупа ───────────
  if (reduce) {
    if (compiled.repeat === Infinity) {
      settle(samplePreset(compiled, 0)); // нейтральная поза ambient-лупа
    } else {
      _vt = totalDuration;
      settle(samplePreset(compiled, totalDuration)); // финальная поза
    }
  } else {
    ensureLoop();
  }

  const controls: PresetControls = {
    get totalDuration(): number {
      return totalDuration;
    },
    get time(): number {
      return _vt;
    },
    get progress(): number {
      if (_settled) return 1;
      return repeatCursor(
        _vt,
        compiled.delay,
        compiled.duration,
        compiled.repeat,
        compiled.repeatDelay,
        0,
      );
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
        if (compiled.repeat === Infinity) throw new MotionParamError('LM166');
        controls.complete();
        return;
      }
      const upper = totalDuration === Infinity ? Number.MAX_VALUE : totalDuration;
      const next = Math.max(0, Math.min(upper, t));
      if (compiled.repeat === Infinity) {
        repeatCursor(
          next,
          compiled.delay,
          compiled.duration,
          compiled.repeat,
          compiled.repeatDelay,
          0,
        );
      }
      _vt = next;
      _lastRealTs = undefined;
      publishAt(_vt, false);
    },

    complete(): void {
      if (_settled || _samplingPhase === 2) return;
      if (compiled.repeat === Infinity) {
        publishAt(0, true); // нейтральная поза — у лупа нет финала
        return;
      }
      _vt = totalDuration;
      publishAt(_vt, true);
    },

    cancel(): void {
      if (_settled || _samplingPhase === 2) return;
      publishAt(_vt, true);
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

// ─── presetToWaapi: чистый конвертер в данные element.animate() ─────────────

/** Один WAAPI-кейфрейм: offset + собранные CSS-свойства. */
export interface WaapiKeyframe {
  readonly offset: number;
  readonly transform?: string;
  readonly opacity?: number;
}

/** Тайминг для element.animate(): длительности в МИЛЛИСЕКУНДАХ. */
export interface WaapiTiming {
  readonly duration: number;
  readonly delay: number;
  readonly iterations: number;
  readonly direction: 'normal' | 'alternate';
  readonly fill: 'both';
  readonly easing: 'linear';
}

/** Канал progress: не выражается CSS-свойством, потребитель ведёт его сам. */
export interface WaapiProgressTrack {
  readonly offsets: readonly number[];
  readonly values: readonly number[];
}

export interface WaapiConversion {
  readonly keyframes: readonly WaapiKeyframe[];
  readonly timing: WaapiTiming;
  readonly progressTrack?: WaapiProgressTrack;
}

/** Плотность равномерной сетки offset'ов (интервалов) поверх точек times. */
const WAAPI_GRID_INTERVALS = 24;

/**
 * Конвертирует пресет в данные для element.animate() — headless: производит
 * ТОЛЬКО данные (keyframes + timing), DOM-вызов делает потребитель.
 *
 * Семантика easing сохраняется плотной сеткой offset'ов: в каждой точке
 * значение вычислено точно (sampleKeyframesUnchecked), между точками WAAPI
 * интерполирует линейно (timing.easing='linear').
 *
 * transform собирается в фикс-порядке translate → rotate → scale;
 * оси масштаба перемножаются: sx = scale·scaleX, sy = scale·scaleY.
 *
 * @throws MotionParamError при невалидной спеке, repeatDelay > 0 между
 *   повторами или mirror с повтором: WAAPI alternate разворачивает easing.
 *
 * При repeat > 0 и repeatDelay > 0
 *   (в WAAPI нет нативного repeatDelay; честный отказ вместо тихо-неверной
 *   семантики — для repeatDelay используйте runPreset).
 */
export function presetToWaapi(spec: PresetSpec | CompiledPreset): WaapiConversion {
  const compiled = isCompiled(spec) ? spec : compilePreset(spec);
  if (compiled.repeat > 0 && compiled.repeatDelay > 0) {
    throw new MotionParamError('LM071');
  }
  if (compiled.repeat > 0 && compiled.repeatType === 'mirror') {
    throw new MotionParamError('LM159');
  }
  const timingDuration = compiled.duration * 1000;
  const timingDelay = compiled.delay * 1000;
  const timingIterations = compiled.repeat === Infinity ? Infinity : compiled.repeat + 1;
  if (!Number.isFinite(timingDuration) || !(timingDuration > 0) ||
    !Number.isFinite(timingDelay) || timingDelay < 0) {
    throw new MotionParamError('LM162');
  }
  if (compiled.repeat !== Infinity && !(timingIterations > compiled.repeat)) {
    throw new MotionParamError('LM161');
  }
  if (compiled.repeat !== Infinity &&
    !Number.isFinite(timingDelay + timingDuration * timingIterations)) {
    throw new MotionParamError('LM162');
  }

  // Offsets: точки times всех треков ∪ равномерная сетка (дедуп через Set).
  const offsetSet = new Set<number>();
  for (let i = 0; i <= WAAPI_GRID_INTERVALS; i++) offsetSet.add(i / WAAPI_GRID_INTERVALS);
  for (const track of compiled.tracks) {
    for (const t of track.times) offsetSet.add(t);
  }
  const offsets = [...offsetSet].sort((a, b) => a - b);

  const has = (p: PresetProperty): boolean =>
    compiled.tracks.some((track) => track.property === p);
  const hasTranslate = has('x') || has('y');
  const hasRotate = has('rotate');
  const hasScale = has('scale') || has('scaleX') || has('scaleY');
  const hasOpacity = has('opacity');
  const hasProgress = has('progress');
  const hasCss = hasTranslate || hasRotate || hasScale || hasOpacity;

  // Конечность значений гарантирует sampleKeyframesUnchecked (см. инвариант 2).
  const sampleTrackAt = (p: PresetProperty, offset: number): number | undefined => {
    const track = compiled.tracks.find((t) => t.property === p);
    if (!track) return undefined;
    return sampleKeyframesUnchecked(track.values, track.times, track.easings, offset);
  };

  const keyframes: WaapiKeyframe[] = [];
  const progressOffsets: number[] = [];
  const progressValues: number[] = [];

  for (const offset of offsets) {
    if (hasCss) {
      const parts: string[] = [];
      if (hasTranslate) {
        const x = sampleTrackAt('x', offset) ?? 0;
        const y = sampleTrackAt('y', offset) ?? 0;
        parts.push(`translate(${x}px, ${y}px)`);
      }
      if (hasRotate) {
        parts.push(`rotate(${sampleTrackAt('rotate', offset)!}deg)`);
      }
      if (hasScale) {
        const s = sampleTrackAt('scale', offset) ?? 1;
        const sx = s * (sampleTrackAt('scaleX', offset) ?? 1);
        const sy = s * (sampleTrackAt('scaleY', offset) ?? 1);
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
          throw new MotionParamError('LM162');
        }
        parts.push(`scale(${sx}, ${sy})`);
      }
      const kf: { offset: number; transform?: string; opacity?: number } = { offset };
      if (parts.length > 0) kf.transform = parts.join(' ');
      if (hasOpacity) kf.opacity = sampleTrackAt('opacity', offset)!;
      keyframes.push(kf);
    }
    if (hasProgress) {
      progressOffsets.push(offset);
      progressValues.push(sampleTrackAt('progress', offset)!);
    }
  }

  const conversion: {
    keyframes: readonly WaapiKeyframe[];
    timing: WaapiTiming;
    progressTrack?: WaapiProgressTrack;
  } = {
    keyframes,
    timing: {
      duration: timingDuration,
      delay: timingDelay,
      iterations: timingIterations,
      direction: compiled.repeatType === 'reverse' ? 'alternate' : 'normal',
      fill: 'both',
      easing: 'linear',
    },
  };
  if (hasProgress) {
    conversion.progressTrack = { offsets: progressOffsets, values: progressValues };
  }
  return conversion;
}

// ─── Текстовые/числовые сахара (перенос ценного из PR#79 языком дома) ───────
//
// Почему здесь, а не в субпутях ./text ./number ./ticker (как в PR#79):
// субпуть-зоопарк дробит словарь движений и плодит параллельные конвенции.
// Сахара — те же headless-пресеты: чистые мапперы «прогресс 0→1 → строка»
// (дисциплина samplePreset: горячий путь без валидации) + тонкие раннеры
// поверх runPreset — один clock, reduced-motion CHARACTER-switch и
// детерминизм наследуются, а не реализуются заново. Дефолты длительностей —
// из ./tokens (единый источник правды темпа).

export type SplitMode = 'chars' | 'words';

/**
 * Минимальный контракт Unicode-segmenter ponyfill. Реализация обязана вернуть
 * точные extended grapheme clusters в исходном порядке; splitText дополнительно
 * проверяет отсутствие пустых сегментов, потерь и перестановок.
 *
 * Intl.Segmenter структурно совместим с этим контрактом.
 */
export interface GraphemeSegmenter {
  segment(text: string): Iterable<{ readonly segment: string }>;
}

let cachedSegmenterConstructor: typeof Intl.Segmenter | undefined;
let cachedNativeSegmenter: GraphemeSegmenter | undefined;

/** Конструирование Intl.Segmenter дорого; экземпляр лениво кэшируется. */
function nativeGraphemeSegmenter(): GraphemeSegmenter | undefined {
  const Segmenter = (globalThis as {
    Intl?: { Segmenter?: typeof Intl.Segmenter };
  }).Intl?.Segmenter;
  if (Segmenter === undefined) return undefined;
  if (cachedNativeSegmenter === undefined || cachedSegmenterConstructor !== Segmenter) {
    const candidate = new Segmenter(undefined, { granularity: 'grapheme' });
    cachedSegmenterConstructor = Segmenter;
    cachedNativeSegmenter = candidate;
  }
  return cachedNativeSegmenter;
}

function invalidGraphemeSegmenter(): never {
  throw new MotionParamError('LM158');
}

function segmentGraphemes(text: string, segmenter: GraphemeSegmenter): readonly string[] {
  let segment: unknown;
  try {
    segment = segmenter?.segment;
  } catch {
    invalidGraphemeSegmenter();
  }
  if (typeof segment !== 'function') invalidGraphemeSegmenter();

  const parts: string[] = [];
  let consumedCodeUnits = 0;
  let invalid = false;
  try {
    const iterable = Reflect.apply(segment, segmenter, [text]) as Iterable<unknown>;
    for (const value of iterable) {
      if (
        value === null
        || (typeof value !== 'object' && typeof value !== 'function')
      ) {
        invalid = true;
        break;
      }
      const part = (value as { segment?: unknown }).segment;
      if (
        typeof part !== 'string'
        || part.length === 0
        || !text.startsWith(part, consumedCodeUnits)
      ) {
        invalid = true;
        break;
      }
      consumedCodeUnits += part.length;
      parts.push(part);
    }
  } catch {
    invalid = true;
  }
  if (invalid || consumedCodeUnits !== text.length) invalidGraphemeSegmenter();
  return parts;
}

function requireSplitTextInput(text: unknown, mode: unknown): asserts text is string {
  if (typeof text !== 'string') throw new MotionParamError('LM072');
  if (mode !== 'chars' && mode !== 'words') throw new MotionParamError('LM073');
}

/**
 * Разбивает текст для пошагового раскрытия.
 * 'chars' — по extended grapheme clusters при наличии Intl.Segmenter или
 * явного ponyfill; в старой среде сохраняется прежний code-point fallback,
 * поэтому суррогатные пары не рвутся и обновление не ломает существующий вызов.
 * 'words' сохраняет пробельные токены, чтобы join('') восстановил строку.
 * @throws MotionParamError при не-строке, неизвестном режиме или нарушении
 * контракта доступного/injected segmenter.
 */
export function splitText(
  text: string,
  mode: SplitMode = 'chars',
  segmenter?: GraphemeSegmenter,
): readonly string[] {
  requireSplitTextInput(text, mode);
  if (text.length === 0) return [];
  if (mode === 'words') return text.split(/(\s+)/).filter(Boolean);
  let exactSegmenter: GraphemeSegmenter | undefined;
  try {
    exactSegmenter = segmenter === undefined ? nativeGraphemeSegmenter() : segmenter;
  } catch {
    invalidGraphemeSegmenter();
  }
  if (exactSegmenter === undefined) return Array.from(text);
  return segmentGraphemes(text, exactSegmenter);
}

/** Клэмп прогресса в [0,1]; NaN → 0. CSS-safe: эмитим только валидные кадры. */
function clampProgress(progress: number): number {
  return progress > 0 ? (progress < 1 ? progress : 1) : 0;
}

/**
 * Кадр печатной машинки: префикс parts при прогрессе p.
 * Горячий путь — без валидации (дисциплина samplePreset, инвариант 6).
 */
export function typewriterAt(parts: readonly string[], progress: number): string {
  const k = Math.floor(clampProgress(progress) * parts.length);
  return k <= 0 ? '' : parts.slice(0, k).join('');
}

/** mulberry32 — крошечный seeded RNG: детерминизм скрэмбла без зависимостей. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const SCRAMBLE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SCRAMBLE_DEFAULT_SEED = 0xdeadbeef;

export interface ScrambleAtOptions {
  /** Seed шума: один (text, p, seed) → бит-идентичный кадр (реплеи, тесты). */
  readonly seed?: number;
  /** Алфавит шума. По умолчанию латиница+цифры. Unicode-safe (Array.from). */
  readonly alphabet?: string;
}

/**
 * Скрэмбл-кадр: раскрытые глифы цели + seeded-шум в хвосте. ЧИСТАЯ функция
 * (text, p, seed) → строка: RNG пересоздаётся на каждый вызов, поэтому кадр
 * НЕ зависит от частоты кадров. В PR#79 rng тёк сквозь кадры — вывод зависел
 * от fps, реплей ломался; здесь это исправлено по инварианту 3 (детерминизм).
 * p=1 → точный text. Горячий путь — без валидации.
 */
export function scrambleAt(
  text: string,
  progress: number,
  opts: ScrambleAtOptions = {},
): string {
  const target = Array.from(text);
  const len = target.length;
  if (len === 0) return '';
  const glyphs = Array.from(opts.alphabet ?? SCRAMBLE_ALPHABET);
  const rng = mulberry32(opts.seed ?? SCRAMBLE_DEFAULT_SEED);
  const reveal = Math.floor(clampProgress(progress) * len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += i < reveal ? target[i]! : glyphs[Math.floor(rng() * glyphs.length)]!;
  }
  return out;
}

export interface NumberFormatOptions {
  /** BCP-47 локали Intl. undefined → локаль хоста (en-US не навязываем). */
  readonly locales?: string | string[];
  /** Опции Intl.NumberFormat: currency/unit/notation и т.д. */
  readonly format?: Intl.NumberFormatOptions;
}

/**
 * Одноразовое Intl-форматирование КОНЕЧНОГО числа.
 * @throws MotionParamError при неконечном value — строку "NaN"/"∞" в UI не
 * эмитим (тот же класс гарантий, что CSS-safe инвариант 2).
 */
export function formatNumber(value: number, opts: NumberFormatOptions = {}): string {
  assertFinite('formatNumber.value', value);
  return new Intl.NumberFormat(opts.locales, opts.format).format(value);
}

/**
 * Ячейки тикера/одометра: ВСЕ глифы отформатированной строки (Unicode-safe).
 * Почему НЕ фильтруем «нецифровое» регэкспом (как в PR#79): фильтр ломает
 * локали — арабо-индийские цифры, валютные символы и группировочные пробелы
 * исчезали бы. Что рендерить по ячейкам — решает потребитель.
 * Отдельного runTicker нет намеренно: тикер = runNumber + tickerCells.
 */
export function tickerCells(formatted: string): readonly string[] {
  return Array.from(formatted);
}

/** Общие опции раннеров-сахаров (прогресс-трек поверх runPreset). */
export interface SugarRunOptions {
  /** Длительность, с. Дефолт — у каждого раннера свой, из ./tokens. */
  readonly duration?: number;
  /** Изинг прогресса. По умолчанию линейный (равномерное раскрытие). */
  readonly easing?: EasingFn;
  /** Injectable matchMedia (reduced-motion), как в RunPresetOptions. */
  readonly matchMedia?: ((query: string) => MatchMediaResult) | undefined;
  /** Injectable requestFrame (virtual-time тесты), как в RunPresetOptions. */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
}

function assertCallback(name: string, fn: unknown): void {
  if (typeof fn !== 'function') {
    throw new MotionParamError('LM074');
  }
}

/** Единый прогресс-раннер сахаров: спека с одним progress-треком 0→1. */
function runProgressTrack(
  durationSeconds: number,
  opts: SugarRunOptions,
  onProgress: (p: number) => void,
): PresetControls {
  const track: PresetTrack = opts.easing
    ? { property: 'progress', values: [0, 1], easing: opts.easing }
    : { property: 'progress', values: [0, 1] };
  return runPreset(
    { duration: durationSeconds, tracks: [track] },
    {
      onUpdate: (values) => onProgress(values.progress ?? 1),
      matchMedia: opts.matchMedia,
      requestFrame: opts.requestFrame,
    },
  );
}

export interface TypewriterRunOptions extends SugarRunOptions {
  /** Режим разбиения текста. По умолчанию 'chars'. */
  readonly mode?: SplitMode;
  /** Exact Unicode ponyfill вместо совместимого code-point fallback. */
  readonly segmenter?: GraphemeSegmenter;
}

/**
 * Печатная машинка поверх runPreset: onUpdate получает растущий префикс.
 * Дефолт длительности — staggerGap.normal (40 мс) НА ГЛИФ: машинка и есть
 * стаггер по глифам, темп печати не должен зависеть от длины текста.
 * Reduced-motion: ровно один эмит полного текста без сегментации и кадров;
 * default totalDuration схлопывается до минимального шага раннера.
 * @throws MotionParamError при невалидных text/mode/duration/onUpdate.
 */
export function runTypewriter(
  text: string,
  onUpdate: (partial: string) => void,
  opts: TypewriterRunOptions = {},
): PresetControls {
  assertCallback('runTypewriter.onUpdate', onUpdate);
  const mode = opts.mode ?? 'chars';
  requireSplitTextInput(text, mode);
  const durationInput = opts.duration;
  if (durationInput !== undefined) assertDuration('runTypewriter', durationInput);
  const easing = opts.easing;
  const matchMedia = opts.matchMedia;
  const requestFrame = opts.requestFrame;
  const reduce = prefersReducedMotion(matchMedia);
  if (reduce) {
    const duration = durationInput ?? FIXED_DT_S;
    return runProgressTrack(
      duration,
      { easing, requestFrame, matchMedia: () => ({ matches: true }) },
      () => onUpdate(text),
    );
  }
  const parts = splitText(text, mode, opts.segmenter);
  const duration = durationInput
    ?? Math.max((parts.length * staggerGap.normal) / 1000, FIXED_DT_S);
  assertDuration('runTypewriter', duration);
  return runProgressTrack(
    duration,
    { easing, requestFrame, matchMedia: () => ({ matches: false }) },
    (p) => onUpdate(typewriterAt(parts, p)),
  );
}

export interface ScrambleRunOptions extends SugarRunOptions, ScrambleAtOptions {}

/**
 * Скрэмбл: расшифровка к цели с seeded-шумом. Дефолт — duration.slower
 * (500 мс из ./tokens): при 60 fps это ~30 кадров шума — эффект читается,
 * не мельтешит. Фиксированный seed делает реплеи бит-идентичными.
 * @throws MotionParamError при невалидных text/seed/alphabet/duration/onUpdate.
 */
export function runScramble(
  text: string,
  onUpdate: (scrambled: string) => void,
  opts: ScrambleRunOptions = {},
): PresetControls {
  assertCallback('runScramble.onUpdate', onUpdate);
  if (typeof text !== 'string') {
    throw new MotionParamError('LM075');
  }
  const seed = opts.seed ?? SCRAMBLE_DEFAULT_SEED;
  assertFinite('runScramble.seed', seed);
  const alphabet = opts.alphabet ?? SCRAMBLE_ALPHABET;
  if (typeof alphabet !== 'string' || alphabet.length === 0) {
    throw new MotionParamError('LM076');
  }
  const duration = opts.duration ?? durationTokens.slower / 1000;
  assertDuration('runScramble', duration);
  const frameOpts: ScrambleAtOptions = { seed, alphabet };
  return runProgressTrack(duration, opts, (p) => onUpdate(scrambleAt(text, p, frameOpts)));
}

export interface NumberRunOptions extends SugarRunOptions, NumberFormatOptions {}

/**
 * Счётчик: ведёт число from→to, эмитит Intl-строку + сырое значение.
 * Форматтер создаётся ОДИН раз — конструкция Intl.NumberFormat дорогая,
 * в кадровом цикле ей не место. Дефолт — duration.slow (300 мс из ./tokens).
 * Значения гарантированно конечны: from/to валидированы, p ∈ [0,1].
 * @throws MotionParamError при неконечных from/to, невалидных duration/onUpdate.
 */
export function runNumber(
  from: number,
  to: number,
  onUpdate: (formatted: string, value: number) => void,
  opts: NumberRunOptions = {},
): PresetControls {
  assertCallback('runNumber.onUpdate', onUpdate);
  assertFinite('runNumber.from', from);
  assertFinite('runNumber.to', to);
  const duration = opts.duration ?? durationTokens.slow / 1000;
  assertDuration('runNumber', duration);
  const fmt = new Intl.NumberFormat(opts.locales, opts.format);
  return runProgressTrack(duration, opts, (p) => {
    const value = from + (to - from) * p;
    onUpdate(fmt.format(value), value);
  });
}
