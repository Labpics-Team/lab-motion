/**
 * compositor/stagger.ts — composited stagger: каскад групп на КОМПОЗИТОРЕ
 * (публичный subpath ./compositor/stagger).
 *
 * ТЕЗИС: каскадный (staggered) запуск группы элементов, где ЗАДЕРЖКИ каждого
 * элемента реализованы нативным WAAPI-delay поверх ОДНОЙ запечённой linear()-
 * кривой пружины — а не покадровой работой main-потока. Пружина компилируется
 * ОДИН раз (общий LRU-кэш ./compositor отдаёт всем элементам одну и ту же
 * linear()-строку: идентичная пружина → cache hit), а per-element сдвиг во
 * времени задаёт браузер на compositor-потоке. Steady-state каскада — НОЛЬ
 * работы main-потока, как и у одиночного compositor-перехода M1.
 *
 * ДВА СЛОЯ (в духе ./compositor: чистый планировщик + контроллер):
 *   1. compileStaggerPlan — ЧИСТАЯ функция: общий план пружины (compileSpringPlan)
 *      + массив per-element задержек (headless ./stagger). SSR-safe, детерминизм,
 *      без DOM — это и есть «компиляция + планирование», которое меряет бенч.
 *   2. CompositorStaggerGroup — контроллер над N целями: держит по одному
 *      CompositorSpring на элемент (с его задержкой) и оркестрирует жизненный цикл.
 *
 * СОГЛАСОВАНИЕ С M2 (честная граница — что per-group, что per-element):
 *   • КАСКАД (start) = per-GROUP. Стартовые задержки — свойство ФАЗЫ ЗАПУСКА
 *     группы; это и есть composited-выигрыш. Планируется один раз, живёт на
 *     компоьзиторе.
 *   • РЕТАРГЕТ = per-ELEMENT. Примитив M2 ретаргета — ДИСКРЕТНОЕ one-shot событие
 *     на ОДНОМ элементе (serialized effect-снимок + cancel + пере-эмиссия с
 *     сохранением правого slope). Групповой retargetAll
 *     раскладывается в N НЕЗАВИСИМЫХ per-element ретаргетов, но НЕ переигрывает
 *     каскад: ретаргет — редкое прерывание, а не новый парад. Пере-stagger'ить
 *     ретаргет = копить латентность и нарушить фазовую модель «ретаргет редок, не
 *     покадров». Нужен каскадный ретаргет → это НОВЫЙ каскад (новый start).
 *   • ХЕНДОФФ = per-ELEMENT ТОЛЬКО. Хендофф отдаёт ОДИН элемент в live-пружину
 *     (тот, что стал интерактивным — палец перехватил именно его). «Группа целиком
 *     стала интерактивной» — не сценарий хендоффа, поэтому группового handoff нет.
 *
 * Инварианты наследуются от ./compositor (zero-DOM на импорте, детерминизм,
 * финитность, MotionParamError рано) и ./stagger (детерминизм расписания,
 * reduced-motion CHARACTER-switch: все задержки → 0, элементы всё равно анимируются).
 */

import { MotionParamError } from '../errors.js';
import { type SpringParams } from '../spring.js';
import { type WaapiAnimatable } from '../waapi/index.js';
import { MotionValue, type RequestFrameFn } from '../motion-value.js';
import { type StaggerFrom, type StaggerGridOptions } from '../stagger/index.js';
import { MAX_STAGGER_COUNT, scheduleStagger } from '../stagger/scheduler.js';
import { type SpringNode } from './segmenter.js';
import {
  compileSpringPlan,
  CompositorSpring,
  type SetTimerFn,
} from './core.js';

// ─── Общие опции распределения (база планировщика и контроллера) ─────────────

/** Общая база: пружина + свойство + границы + распределение stagger. */
interface StaggerPlanBase {
  readonly spring: SpringParams;
  /** CSS-свойство (camelCase WAAPI, например 'opacity' или 'transform'). Непустое. */
  readonly property: string;
  /** Начальное значение (единицы свойства). Общее для всех элементов. */
  readonly from: number;
  /** Конечное значение. Общее для всех элементов. */
  readonly to: number;
  /** Толерантность реконструкции (ед. прогресса). По умолчанию DEFAULT_TOLERANCE. */
  readonly tolerance?: number;
  /** Fill. По умолчанию 'both'. */
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both';
  /** Composite. По умолчанию 'replace'. */
  readonly composite?: 'replace' | 'add' | 'accumulate';
  /** Форматтер значения (единицы/шаблоны). По умолчанию число как есть. */
  readonly format?: (v: number) => string | number;

  // ── Распределение stagger (проксирует ./stagger; 'from' переименован в
  //    'staggerFrom', чтобы не конфликтовать со spring-from выше) ──
  /** Базовый шаг задержки между соседними элементами (мс). По умолчанию 50. */
  readonly gap?: number;
  /** Точка отсчёта каскада (какой элемент стартует первым). По умолчанию 'first'. */
  readonly staggerFrom?: StaggerFrom;
  /** Easing на нормализованную позицию элемента в каскаде. По умолчанию linear. */
  readonly staggerEasing?: (t: number) => number;
  /** 2D-сетка для дистанции каскада. */
  readonly grid?: StaggerGridOptions;
  /** Reduced-motion: все задержки → 0 (каскад схлопывается, элементы анимируются). */
  readonly reducedMotion?: boolean;
}

/** Опции чистого планировщика compileStaggerPlan (число элементов задаётся явно). */
export interface CompositorStaggerOptions extends StaggerPlanBase {
  /** Допустимое неотрицательное целое число элементов группы. */
  readonly count: number;
  /**
   * Нормализованная начальная скорость пружины (форма кривой). По умолчанию 0.
   * Знобка чистого плана; групповой контроллер стартует элементы из покоя
   * (скорость приходит лишь через retarget smooth-pickup, C¹).
   */
  readonly v0?: number;
}

/** План composited stagger: ОБЩАЯ кривая + per-element задержки. */
export interface CompositorStaggerPlan {
  /** Общие крайние кадры либо явные адаптивные кадры для WebKit. */
  readonly keyframes: Record<string, string | number>[];
  /** Общая linear()-строка (пружинная траектория) — одна на всю группу. */
  readonly easing: string;
  /** Общая длительность (мс). */
  readonly duration: number;
  /** Всегда 1 (пружина не циклична). */
  readonly iterations: number;
  /** Fill. */
  readonly fill: 'none' | 'forwards' | 'backwards' | 'both';
  /** Composite. */
  readonly composite: 'replace' | 'add' | 'accumulate';
  /** Узлы пружины (общие) — для инспекции/байт-паритетных тестов. */
  readonly nodes: readonly SpringNode[];
  /**
   * Per-element стартовые задержки (мс) из ./stagger. delays[i] — WAAPI-delay
   * i-го элемента поверх ОБЩЕЙ кривой. Длина всегда равна проверенному count;
   * reduced-motion → все 0.
   */
  readonly delays: readonly number[];
  /** Число элементов, для которого посчитаны задержки. */
  readonly count: number;
}

/**
 * ЧИСТО компилирует план composited stagger: общий план пружины (одна компиляция,
 * общий кэш) + массив per-element задержек (headless ./stagger). SSR-safe,
 * детерминирована, без DOM — это SSOT расписания группы (то, что таймит бенч).
 *
 * @throws MotionParamError при невалидных count/spring/property/from/to (рано).
 */
function compileStaggerPlanForCount(
  options: StaggerPlanBase & { readonly v0?: number },
  count: number,
): CompositorStaggerPlan {
  if (!Number.isInteger(count) || count < 0 || count > MAX_STAGGER_COUNT) {
    throw new MotionParamError('LM017');
  }

  // Общий план пружины — ОДНА компиляция на всю группу. Общий LRU-кэш ./compositor
  // отдаёт идентичным пружинам одну linear()-строку, поэтому N элементов делят
  // одну кривую (валидация spring/property/from/to/v0/tolerance — внутри).
  const plan = compileSpringPlan({
    spring: options.spring,
    property: options.property,
    from: options.from,
    to: options.to,
    v0: options.v0,
    tolerance: options.tolerance,
    fill: options.fill,
    composite: options.composite,
    format: options.format,
  });

  // Оба публичных stagger-входа делят одно ядро, но compositor передаёт уже
  // строго проверенный count и не создаёт промежуточный options-carrier.
  const delays = scheduleStagger(
    count,
    false,
    options.gap,
    options.staggerFrom,
    options.staggerEasing,
    options.grid?.columns,
    options.reducedMotion,
  );

  // Публичный value-object не делит мутабельную идентичность с базовым планом.
  return { ...plan, delays, count };
}

export function compileStaggerPlan(options: CompositorStaggerOptions): CompositorStaggerPlan {
  return compileStaggerPlanForCount(options, options.count);
}

// ─── CompositorStaggerGroup (контроллер группы) ──────────────────────────────

/** Опции контроллера группы. Число элементов = targets.length. */
export interface CompositorStaggerGroupOptions extends StaggerPlanBase {
  /**
   * Цели анимации (по одной на элемент группы). Элемент с undefined целью
   * (или без .animate) уходит на FALLBACK-путь (main-thread), сохраняя задержку
   * через setTimer. Число элементов = targets.length.
   */
  readonly targets: ReadonlyArray<WaapiAnimatable | undefined>;
  /**
   * Писатель значения FALLBACK-пути: (индекс элемента, значение) → void.
   * На compositor-пути НЕ вызывается (значение пишет браузер).
   */
  readonly apply?: ((index: number, value: string | number) => void) | undefined;
  /** Часы (мс) для замера elapsed ретаргета/хендоффа. По умолчанию performance.now. */
  readonly now?: (() => number) | undefined;
  /** Инжектируемый requestFrame для fallback-драйверов. */
  readonly requestFrame?: RequestFrameFn | undefined;
  /** Инжектируемый таймер для fallback-задержки старта. По умолчанию setTimeout. */
  readonly setTimer?: SetTimerFn | undefined;
}

/**
 * Контроллер composited-stagger группы: держит по одному CompositorSpring на
 * элемент (с его stagger-задержкой) и оркестрирует старт/ретаргет/хендофф.
 *
 * КАСКАД (start) — per-group: все элементы получают ОДНУ кривую и свой WAAPI-delay
 * (compositor-путь) или отложенный старт (fallback). Ноль работы main-потока на
 * compositor-пути в steady-state.
 *
 * РЕТАРГЕТ/ХЕНДОФФ — per-element (см. шапку файла: примитивы M2 поэлементны).
 * retarget(i)/handoffToLive(i) действуют на один элемент; retargetAll — fan-out
 * без пере-каскада. Effect-space гарантия ретаргета/хендоффа — как у одиночного
 * CompositorSpring (execution-snapshot + reseed скорости).
 */
export class CompositorStaggerGroup {
  private readonly _plan: CompositorStaggerPlan;
  private readonly _springs: CompositorSpring[];
  private _destroyed = false;

  constructor(opts: CompositorStaggerGroupOptions) {
    if (!Array.isArray(opts.targets)) {
      throw new MotionParamError('LM018');
    }
    const count = opts.targets.length;
    // Компиляция общего плана + задержек (валидация spring/свойств/границ внутри).
    this._plan = compileStaggerPlanForCount(opts, count);
    // compileSpringPlan уже посеял единый artifact; N детей получают hit без
    // отдельного WebKit-pool и без повторной сетки/RDP.

    const delays = this._plan.delays;
    const apply = opts.apply;
    const springs = new Array<CompositorSpring>(count);
    // CompositorSpring синхронно захватывает значения опций и не удерживает
    // объект. Один переиспользуемый carrier убирает N краткоживущих option-
    // объектов перед первым кадром большого каскада.
    const child = {
      spring: opts.spring,
      property: opts.property,
      from: opts.from,
      to: opts.to,
      delay: 0,
      target: undefined as WaapiAnimatable | undefined,
      apply: undefined as ((value: string | number) => void) | undefined,
      tolerance: opts.tolerance,
      fill: opts.fill,
      composite: opts.composite,
      format: opts.format,
      now: opts.now,
      requestFrame: opts.requestFrame,
      setTimer: opts.setTimer,
    };
    for (let i = 0; i < count; i++) {
      child.delay = delays[i]!;
      child.target = opts.targets[i];
      child.apply = apply && ((value: string | number): void => apply(i, value));
      springs[i] = new CompositorSpring(child);
    }
    this._springs = springs;
  }

  /** Путь исполнения группы (по первому элементу; пустая группа → 'fallback'). */
  get mode(): 'compositor' | 'fallback' {
    return this._springs[0]?.mode ?? 'fallback';
  }

  /** Число элементов группы. */
  get count(): number {
    return this._springs.length;
  }

  /** Per-element стартовые задержки (мс), общий план. */
  get delays(): readonly number[] {
    return this._plan.delays;
  }

  /** Скомпилированный план (общая кривая + задержки) — для инспекции/тестов. */
  get plan(): CompositorStaggerPlan {
    return this._plan;
  }

  /** Последнее известное значение i-го элемента (или NaN при выходе индекса). */
  valueAt(index: number): number {
    return this._springs[index]?.value ?? NaN;
  }

  /** Запускает КАСКАД: каждый элемент стартует со своей stagger-задержкой (per-group). */
  start(): void {
    if (this._destroyed) return;
    for (const s of this._springs) s.start();
  }

  /**
   * ONE-SHOT ретаргет ОДНОГО элемента с сохранением effect-space slope —
   * per-element примитив M2. index вне диапазона → MotionParamError.
   */
  retarget(index: number, newTarget: number): void {
    if (this._destroyed) return;
    const s = this._springs[index];
    if (s === undefined) {
      throw new MotionParamError('LM019');
    }
    s.retarget(newTarget);
  }

  /**
   * Ретаргет ВСЕЙ группы на общий newTarget: fan-out в N НЕЗАВИСИМЫХ per-element
   * ретаргетов, ОДНОВРЕМЕННО (каскад НЕ переигрывается — ретаргет есть дискретное
   * прерывание, не новый парад; см. шапку). Каждый элемент сохраняет свой slope.
   */
  retargetAll(newTarget: number): void {
    if (this._destroyed) return;
    for (const s of this._springs) s.retarget(newTarget);
  }

  /**
   * ХЕНДОФФ ОДНОГО элемента compositor→live (per-element примитив M2): снимает
   * (value, velocity) из execution stops, отменяет compositor-Animation и отдаёт
   * элемент живой rAF-пружине (MotionValue). Возвращает MotionValue — им дальше
   * управляет вызывающий. Группового хендоффа нет (см. шапку). index вне
   * диапазона → MotionParamError.
   */
  handoffToLive(index: number, newTarget?: number): MotionValue {
    const s = this._springs[index];
    if (s === undefined) {
      throw new MotionParamError('LM020');
    }
    return s.handoffToLive(newTarget);
  }

  /** Останавливает все элементы (без разрушения; повторный start() возобновит). */
  stop(): void {
    for (const s of this._springs) s.stop();
  }

  /** Полностью останавливает и освобождает ресурсы всех элементов. */
  destroy(): void {
    for (const s of this._springs) s.destroy();
    this._destroyed = true;
  }

}
