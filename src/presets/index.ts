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
import {
  sampleKeyframes,
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

/** Политика повторов — семантика идентична keyframes ('mirror' = алиас 'reverse'). */
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
  /** Easing на сегмент: один общий или массив длиной values.length-1. */
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
  /** Число ДОПОЛНИТЕЛЬНЫХ циклов: целое >= 0 или Infinity. По умолчанию 0. */
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
  readonly repeatType: 'loop' | 'reverse';
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
      easings = track.easing;
    } else if (typeof track.easing === 'function') {
      easings = new Array<EasingFn>(segCount).fill(track.easing);
    } else {
      easings = new Array<EasingFn>(segCount).fill(linearEasing);
    }

    tracks.push({ property, values, times, easings });
  }

  const delay = spec.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new MotionParamError('LM059');
  }

  const repeatRaw = spec.repeat ?? 0;
  if (
    repeatRaw !== Infinity &&
    (!Number.isFinite(repeatRaw) || repeatRaw < 0 || Math.floor(repeatRaw) !== repeatRaw)
  ) {
    throw new MotionParamError('LM060');
  }

  const repeatTypeRaw = spec.repeatType ?? 'loop';
  if (repeatTypeRaw !== 'loop' && repeatTypeRaw !== 'reverse' && repeatTypeRaw !== 'mirror') {
    throw new MotionParamError('LM061');
  }
  const repeatType: 'loop' | 'reverse' = repeatTypeRaw === 'mirror' ? 'reverse' : repeatTypeRaw;

  const repeatDelay = spec.repeatDelay ?? 0;
  if (!Number.isFinite(repeatDelay) || repeatDelay < 0) {
    throw new MotionParamError('LM062');
  }

  return {
    __compiledPreset: true,
    duration,
    delay,
    repeat: repeatRaw,
    repeatType,
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
  const cycles = compiled.repeat === Infinity ? Infinity : compiled.repeat + 1;
  if (cycles === Infinity) return Infinity;
  return compiled.delay + compiled.duration * cycles + compiled.repeatDelay * compiled.repeat;
}

// ─── samplePreset: чистый горячий сэмплер ────────────────────────────────────

/**
 * Значения всех треков пресета в момент tSeconds (от нуля общей шкалы,
 * delay входит в шкалу). Чистая функция без состояния и валидации
 * (контракт: compiled получен из compilePreset).
 *
 * Хостильное t: NaN → поза t=0; -Infinity/отрицательное → поза t=0;
 * +Infinity/за totalDuration → конец последнего цикла (yoyo-aware).
 * Конечность значений гарантируют guards sampleKeyframes (инвариант 2);
 * NaN, дошедший до фазы, нормализуется там же (pClamped → 0).
 */
export function samplePreset(compiled: CompiledPreset, tSeconds: number): PresetValues {
  // Хостильное время → детерминированные края. Ветка NaN load-bearing для
  // reverse-режима: без неё NaN доплывает до cycleIndex, NaN%2===0 даёт
  // false → forward=false → финал вместо позы t=0 (запинено тестом).
  let t: number;
  if (Number.isNaN(tSeconds)) {
    t = 0;
  } else if (tSeconds === Infinity) {
    t = Number.MAX_VALUE;
  } else if (tSeconds === -Infinity || tSeconds < 0) {
    t = 0;
  } else {
    t = tSeconds;
  }

  // Delay-окно: держим позу t=0 (первые значения треков).
  let vt = t - compiled.delay;
  if (vt < 0) vt = 0;

  const { duration, repeat, repeatType, repeatDelay, tracks } = compiled;
  const totalCycles = repeat === Infinity ? Infinity : repeat + 1;
  const cycleLen = duration + repeatDelay;
  const activeTotal =
    totalCycles === Infinity ? Infinity : duration * totalCycles + repeatDelay * repeat;

  // За пределами активной длительности → конец ПОСЛЕДНЕГО цикла (yoyo-aware).
  let cycleIndex: number;
  let phaseP: number;
  if (activeTotal !== Infinity && vt >= activeTotal) {
    cycleIndex = totalCycles - 1;
    phaseP = 1;
  } else {
    cycleIndex = Math.floor(vt / cycleLen);
    if (cycleIndex < 0) cycleIndex = 0;
    if (totalCycles !== Infinity && cycleIndex >= totalCycles) cycleIndex = totalCycles - 1;
    const local = vt - cycleIndex * cycleLen;
    // Окно repeatDelay (local > duration) держит конец цикла: p=1.
    // Не-конечная фаза здесь не нормализуется намеренно: <0/>1 режут края,
    // а NaN нормализует pClamped внутри sampleKeyframes (внешний clamp был
    // бы мёртвым кодом — урок верификации s07).
    phaseP = local <= duration ? local / duration : 1;
    if (phaseP < 0) phaseP = 0;
    else if (phaseP > 1) phaseP = 1;
  }

  const forward = repeatType === 'loop' || cycleIndex % 2 === 0;
  const effectiveP = forward ? phaseP : 1 - phaseP;

  const out: PresetValues = {};
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    out[track.property] = sampleKeyframes(track.values, track.times, track.easings, effectiveP);
  }
  return out;
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
  /** Перемотка к t секунд. NaN → no-op, +Infinity → complete(). */
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
  const onUpdate = opts.onUpdate;

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
        // Safety cap — выходим в ТЕКУЩЕЙ позиции (не «естественный» финал).
        settle(samplePreset(compiled, _vt));
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
        settle(samplePreset(compiled, totalDuration));
        return;
      }

      emit(samplePreset(compiled, _vt));
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

  function ensureLoop(): void {
    if (_loopRunning || _settled || _paused) return;
    _loopRunning = true;
    const h = scheduleFrame(tick);
    if (h === 0) {
      _useTimeoutFallback = true;
      setTimeout(tick, 0);
    }
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
      const active = Math.max(0, _vt - compiled.delay);
      const cycleLen = compiled.duration + compiled.repeatDelay;
      const totalCycles = compiled.repeat === Infinity ? Infinity : compiled.repeat + 1;
      let cycleIndex = Math.floor(active / cycleLen);
      if (totalCycles !== Infinity && cycleIndex >= totalCycles) cycleIndex = totalCycles - 1;
      const local = active - Math.max(0, cycleIndex) * cycleLen;
      const p = local <= compiled.duration ? local / compiled.duration : 1;
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
      emit(samplePreset(compiled, _vt));
    },

    complete(): void {
      if (_settled) return;
      if (compiled.repeat === Infinity) {
        settle(samplePreset(compiled, 0)); // нейтральная поза — у лупа нет финала
        return;
      }
      _vt = totalDuration;
      settle(samplePreset(compiled, totalDuration));
    },

    cancel(): void {
      if (_settled) return;
      settle(samplePreset(compiled, _vt));
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
 * значение вычислено точно (sampleKeyframes), между точками WAAPI
 * интерполирует линейно (timing.easing='linear').
 *
 * transform собирается в фикс-порядке translate → rotate → scale;
 * оси масштаба перемножаются: sx = scale·scaleX, sy = scale·scaleY.
 *
 * @throws MotionParamError при невалидной спеке и при repeatDelay > 0
 *   (в WAAPI нет нативного repeatDelay; честный отказ вместо тихо-неверной
 *   семантики — для repeatDelay используйте runPreset).
 */
export function presetToWaapi(spec: PresetSpec | CompiledPreset): WaapiConversion {
  const compiled = isCompiled(spec) ? spec : compilePreset(spec);
  if (compiled.repeatDelay > 0) {
    throw new MotionParamError('LM071');
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

  // Конечность значений гарантирует sampleKeyframes (см. инвариант 2).
  const sampleTrackAt = (p: PresetProperty, offset: number): number | undefined => {
    const track = compiled.tracks.find((t) => t.property === p);
    if (!track) return undefined;
    return sampleKeyframes(track.values, track.times, track.easings, offset);
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
      duration: compiled.duration * 1000,
      delay: compiled.delay * 1000,
      iterations: compiled.repeat === Infinity ? Infinity : compiled.repeat + 1,
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
 * Разбивает текст для пошагового раскрытия.
 * 'chars' — Unicode-safe посимвольно (Array.from: суррогатные пары эмодзи не
 * рвутся на половинки); 'words' — слова ВМЕСТЕ с пробельными токенами, чтобы
 * join('') восстанавливал исходную строку бит-в-бит.
 * @throws MotionParamError при не-строке или неизвестном режиме.
 */
export function splitText(text: string, mode: SplitMode = 'chars'): readonly string[] {
  if (typeof text !== 'string') {
    throw new MotionParamError('LM072');
  }
  if (mode !== 'chars' && mode !== 'words') {
    throw new MotionParamError('LM073');
  }
  if (text.length === 0) return [];
  if (mode === 'words') return text.split(/(\s+)/).filter(Boolean);
  return Array.from(text);
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
}

/**
 * Печатная машинка поверх runPreset: onUpdate получает растущий префикс.
 * Дефолт длительности — staggerGap.normal (40 мс) НА ГЛИФ: машинка и есть
 * стаггер по глифам, темп печати не должен зависеть от длины текста.
 * Reduced-motion: ровно один эмит полного текста (CHARACTER-switch).
 * @throws MotionParamError при невалидных text/mode/duration/onUpdate.
 */
export function runTypewriter(
  text: string,
  onUpdate: (partial: string) => void,
  opts: TypewriterRunOptions = {},
): PresetControls {
  assertCallback('runTypewriter.onUpdate', onUpdate);
  const parts = splitText(text, opts.mode ?? 'chars');
  const duration =
    opts.duration ?? Math.max((parts.length * staggerGap.normal) / 1000, FIXED_DT_S);
  assertDuration('runTypewriter', duration);
  return runProgressTrack(duration, opts, (p) => onUpdate(typewriterAt(parts, p)));
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
