/**
 * compositor/core.ts — ядро компилятора пружина → compositor-план.
 *
 * Тезис M1 (research «compass_1937 / compass_395597»): незанятая брешь индустрии —
 * ОБЪЕДИНЕНИЕ двух свойств, которых нет вместе ни у Motion, ни у GSAP, ни у Framer
 * Motion: (1) steady-state с НУЛЁМ работы main-потока (пружина скомпилирована один
 * раз в compositor-резидентный linear()-план на transform/opacity — браузер
 * гоняет её на compositor-потоке, переживая любые фризы) И (2) ONE-SHOT хендофф
 * с сохранением скорости фактической serialized-кривой за O(log K), без layout.
 *
 * Наше преимущество перед compositor-путём Motion (у которого spring→linear() —
 * СТАТИЧНЫЙ снимок, не умеющий перенацеливаться): O(log K)-семплер читает (value,
 * velocity) из тех же serialized stops по `Animation.currentTime`, поэтому
 * хендофф НЕ читает DOM (getComputedStyle форсил бы синхронный recalc) —
 * состояние исполняемой кривой держится в плане.
 *
 * ГРАНИЦЫ ПРИМЕНИМОСТИ (фазовая модель, red-team 2026-07-08): этот путь — для
 * АВТОНОМНЫХ переходов и RELEASE-фазы (fire-and-forget). Прерывание —
 * РЕДКОЕ ONE-SHOT событие, стоит ~один commit-кадр хендоффа. НЕПРЕРЫВНЫЙ ретаргет
 * КАЖДЫЙ кадр (gesture-follow: cancel+re-emit на кадр) — АНТИПАТТЕРН: follow-фаза
 * жестов остаётся на MAIN-потоке (существующие drive/MotionValue — НЕ зона этого
 * субпутя). will-change у потребителя — bounded-дисциплина: не плодить слои,
 * снимать после завершения.
 *
 * Что ОТВЕРГНУТО с доказательствами (контрфакты, НЕ реализованы — см. README):
 * - WASM/SIMD для одиночных DOM-пружин: граница JS↔WASM не убирает DOM-запись;
 *   SIMD полезен большим однородным батчам, не одной автономной анимации;
 * - GPU compute: не может писать в DOM (readback-stall), только canvas при 10k+;
 * - движок в Worker: не снижает input→photon для DOM (ввод всё равно через
 *   compositor/main, +hop postMessage), SAB требует COOP/COEP;
 * - анимация CSS custom properties как «compositor-путь»: @property НЕ ускоряется
 *   на compositor, триггерит style invalidation каждый тик.
 *
 * Инварианты (наследуются от ядра): zero-deps, zero-DOM на импорте (SSR-safe),
 * детерминизм, финитность (NaN/∞ никогда в CSS), MotionParamError рано.
 * Ядро solver.ts НЕ тронуто — только импортируется.
 */

import { MotionParamError } from '../errors.js';
import { readSpringUnchecked } from '../internal/read-spring.js';
import {
  type SpringParams,
  validateSpringParams,
} from '../spring.js';
import { supportsWaapi, type WaapiAnimatable } from '../waapi/index.js';
import { MotionValue, type RequestFrameFn } from '../motion-value.js';
import { type SpringNode } from './segmenter.js';
import {
  DEFAULT_CACHE_CAPACITY,
  clearSpringLinearCache,
  createSpringLinearCacheState,
  springLinearCacheCapacity,
  springLinearCacheSize,
} from './cache.js';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  compileSpringEasingUnchecked,
  type SpringExecutionArtifactTuple,
  DEFAULT_TOLERANCE,
  tryCompileSpringExecutionArtifactTupleUnchecked,
  validateTolerance,
} from './curve.js';
import {
  compileSpringRuntimeExecutionTupleUnchecked,
} from './execution.js';
import {
  animationTimeOrFallback,
  sampleSerializedSpringIntoUnchecked,
  scaleSerializedVelocity,
} from './sample.js';
import { handoffToLive } from './handoff.js';
import {
  type CompositorTier,
  type CompositorTierCode,
  type MatchMediaLike,
  COMPOSITOR_TIERS,
  requiresExplicitSpringKeyframes,
  resolveCompositorTier,
  resolveCompositorTierCodeFromInputs,
  supportsLinearEasing,
} from './detect.js';

export { type SpringNode } from './segmenter.js';
export { handoffToLive, type HandoffToLiveOptions } from './handoff.js';
export {
  type CompositorTier,
  resolveCompositorTier,
  supportsLinearEasing,
} from './detect.js';

// ─── Толерантность по умолчанию (перцептивный бюджет) ────────────────────────
//
// Толерантность = макс. отклонение реконструкции в ЕДИНИЦАХ ПРОГРЕССА [0..1].
// Дефолт выведен из субпиксельного бюджета (research «compass_395597»): при
// ~400 ppi / 30 см 1 px ≈ 0.73 угл.мин, порог обнаружения смещения ~0.2–0.5
// угл.мин. 1/400 прогресса при типичной амплитуде UI-перемещения 100 px = 0.25 px
// ≈ 0.18 угл.мин — комфортно ниже порога. Крупнее амплитуда → передайте
// tolerance меньше (ε_progress = ε_px / амплитуда_px).
export { DEFAULT_TOLERANCE } from './curve.js';

/** Порог вырожденного диапазона (деление на ~0 дало бы ±∞/NaN). */
const RANGE_EPSILON = 1e-10;

// ─── compileSpringLinear (общий кэш) ─────────────────────────────────────────

/** Опции компиляции пружины в linear(). */
export interface SpringLinearOptions {
  /** Нормализованная начальная скорость (0 = покой; ≠0 = ретаргет). По умолчанию 0. */
  readonly v0?: number;
  /** Макс. отклонение реконструкции в ед. прогресса. По умолчанию DEFAULT_TOLERANCE. */
  readonly tolerance?: number;
}

/** Общая валидация linear-входов: [v0, tolerance] (дедуп обоих компиляторов). */
function resolveLinearInputs(options?: SpringLinearOptions): [number, number] {
  const v0 = options?.v0 ?? 0;
  if (!Number.isFinite(v0)) {
    throw new MotionParamError('LM008');
  }
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  validateTolerance(tolerance);
  return [v0, tolerance];
}

/**
 * Пружина → CSS linear()-строка с АДАПТИВНЫМ числом узлов (минимум под бюджет
 * ошибки), через общий bounded cache. Чистая, SSR-safe, детерминированная.
 *
 * @param spring    — физические параметры (валидируются рано).
 * @param options   — v0 (нормализ.), tolerance (ед. прогресса).
 */
export function compileSpringLinear(spring: SpringParams, options?: SpringLinearOptions): string {
  validateSpringParams(spring);
  const [v0, tolerance] = resolveLinearInputs(options);
  return compileSpringEasingUnchecked(spring, v0, tolerance);
}

// ─── createSpringLinearCache (изолированный слот-кэш) ────────────────────────

/** Изолированный компилятор пружин со своим bounded cache (для тестов/независимых зон). */
export interface SpringLinearCompiler {
  /** Компилирует (или достаёт из своего кэша) linear()-строку пружины. */
  compile(spring: SpringParams, options?: SpringLinearOptions): string;
  /** Очищает кэш. */
  clear(): void;
  /** Число занятых слотов. */
  readonly size: number;
  /** Ёмкость (число слотов). */
  readonly capacity: number;
}

/** Создаёт изолированный кэш-компилятор пружин с заданной ёмкостью. */
export function createSpringLinearCache(capacity: number = DEFAULT_CACHE_CAPACITY): SpringLinearCompiler {
  const cache = createSpringLinearCacheState<SpringExecutionArtifactTuple>(capacity);
  return {
    compile(spring: SpringParams, options?: SpringLinearOptions): string {
      validateSpringParams(spring);
      const [v0, tolerance] = resolveLinearInputs(options);
      return compileSpringEasingUnchecked(spring, v0, tolerance, cache);
    },
    clear(): void {
      clearSpringLinearCache(cache);
    },
    get size(): number {
      return springLinearCacheSize(cache);
    },
    get capacity(): number {
      return springLinearCacheCapacity(cache);
    },
  };
}

// ─── compileSpringPlan (полный план для Element.animate) ─────────────────────

/** Аргументы Element.animate() + метаданные плана. */
export interface CompositorPlan {
  /** Два крайних кадра с CSS linear(); в WebKit — явные адаптивные кадры. */
  readonly keyframes: Record<string, string | number>[];
  /** CSS linear()-строка либо обычный linear для явных WebKit-кадров. */
  readonly easing: string;
  /** Длительность (миллисекунды; движок считает в секундах). */
  readonly duration: number;
  /** Всегда 1 (пружина не циклична). */
  readonly iterations: number;
  /** Fill (по умолчанию 'both': значение держится после finish). */
  readonly fill: 'none' | 'forwards' | 'backwards' | 'both';
  /** Composite-режим (независимые трансформы → 'add'). */
  readonly composite: 'replace' | 'add' | 'accumulate';
  /** Узлы (прогресс/процент) — для инспекции и байт-паритетных тестов. */
  readonly nodes: readonly SpringNode[];
}

/** Опции compileSpringPlan. */
export interface CompositorPlanOptions {
  readonly spring: SpringParams;
  /** CSS-свойство (camelCase WAAPI, например 'opacity' или 'transform'). Непустое. */
  readonly property: string;
  /** Начальное значение (в единицах свойства). */
  readonly from: number;
  /** Конечное значение. */
  readonly to: number;
  /** Нормализованная начальная скорость. По умолчанию 0. */
  readonly v0?: number;
  /** Толерантность (ед. прогресса). По умолчанию DEFAULT_TOLERANCE. */
  readonly tolerance?: number;
  /**
   * Абсолютный бюджет ошибки реконструкции в ЕДИНИЦАХ свойства from/to (#223):
   * effective tolerance = min(tolerance, maxValueError/|to−from|), один раз до
   * кэша и сегментера — эквивалентные authoring-входы попадают в один artifact.
   * Вырожденный span движения не имеет — деление не выполняется, действует
   * normalized tolerance. Для группы каналов с общей кривой вызывающий обязан
   * свернуть min по каналам (самый строгий контракт). Конечное число > 0,
   * иначе LM170. Единицы — до format (число канала, не строка CSS).
   */
  readonly maxValueError?: number;
  /** Fill. По умолчанию 'both'. */
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both';
  /** Composite. По умолчанию 'replace'. */
  readonly composite?: 'replace' | 'add' | 'accumulate';
  /** Форматтер значения (единицы/шаблоны). По умолчанию число как есть. */
  readonly format?: (v: number) => string | number;
}

function validateFinite(v: number): number {
  if (!Number.isFinite(v)) {
    throw new MotionParamError('LM009');
  }
  return v;
}

/**
 * Пружина + from/to/property → исполнимый план Element.animate(): два крайних
 * кадра с CSS linear() либо явные адаптивные кадры для WebKit. SSR-safe:
 * capability-проба не обращается к DOM и fail-closed вне браузера.
 */
export function compileSpringPlan(options: CompositorPlanOptions): CompositorPlan {
  validateSpringParams(options.spring);
  if (typeof options.property !== 'string' || options.property.length === 0) {
    throw new MotionParamError('LM010');
  }
  // Имена метаданных кейфрейма WAAPI: значение свойства перезаписало бы их.
  if (options.property === 'offset' || options.property === 'easing' || options.property === 'composite') {
    throw new MotionParamError('LM011');
  }
  validateFinite(options.from);
  validateFinite(options.to);
  const v0 = validateFinite(options.v0 ?? 0);
  let tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  validateTolerance(tolerance);
  const maxValueError = options.maxValueError;
  if (maxValueError !== undefined) {
    if (!Number.isFinite(maxValueError) || maxValueError <= 0) {
      throw new MotionParamError('LM170');
    }
    // Закон #223: строже двух бюджетов; вырожденный span не делит (движения
    // нет — абсолютный бюджет не ограничивает normalized-кривую).
    const span = Math.abs(options.to - options.from);
    if (span > RANGE_EPSILON) {
      const absolute = maxValueError / span;
      // Переполненный span (MAX↔−MAX → ∞) или субнормальный бюджет дают 0:
      // нулевой normalized-бюджет непредставим — честный LM170, а не нарушение
      // positive-tolerance инварианта unchecked-границы.
      if (!(absolute > 0)) throw new MotionParamError('LM170');
      tolerance = Math.min(tolerance, absolute);
    }
  }

  // Публичная диагностика — свежий снимок защищённых сериализованных остановок:
  // это реально исполняемая браузером кривая, без второго источника истины.
  const execution = compileSpringRuntimeExecutionTupleUnchecked(
    options.spring,
    options.property,
    options.from,
    options.to,
    v0,
    tolerance,
    options.fill,
    options.composite,
    options.format,
  );
  const samples = execution[5];
  const nodes = new Array<SpringNode>(samples.length / 2);
  for (let i = 0; i < nodes.length; i++) {
    nodes[i] = {
      progress: samples[i * 2 + 1]!,
      percent: samples[i * 2]!,
    };
  }
  return {
    keyframes: execution[0],
    easing: execution[1],
    duration: execution[2],
    iterations: 1,
    fill: execution[3],
    composite: execution[4],
    nodes,
  };
}

// ─── readCompositorSpring (O(1) аналитический reference/diagnostics) ─────────

/** Опции аналитического чтения. */
export interface ReadSpringOptions {
  /** Начальное значение (единицы). По умолчанию 0. */
  readonly from?: number;
  /** Целевое значение. По умолчанию 1. */
  readonly to?: number;
  /** Нормализованная начальная скорость. По умолчанию 0. */
  readonly v0?: number;
  /** Время (секунды) от старта прогона. ≥ 0. */
  readonly t: number;
}

/**
 * O(1) замкнутая форма: (value, velocity) пружины в произвольный момент t —
 * механизм ретаргета с сохранением скорости. НЕ читает DOM (в этом преимущество
 * перед compositor-путём Motion: getComputedStyle форсил бы синхронный recalc).
 * Value в абсолютных единицах [from..to], velocity — units/s. Финитность гарантирована.
 */
export function readCompositorSpring(
  spring: SpringParams,
  options: ReadSpringOptions,
  out?: { value: number; velocity: number },
): { value: number; velocity: number } {
  validateSpringParams(spring);
  const from = validateFinite(options.from ?? 0);
  const to = validateFinite(options.to ?? 1);
  const v0 = validateFinite(options.v0 ?? 0);
  const t = options.t;
  if (!Number.isFinite(t)) {
    throw new MotionParamError('LM012');
  }
  // Граница API проверила входы; hot-path движков зовёт тот же
  // финитный сэмплер без повторного validator/settle-расчёта.
  return readSpringUnchecked(spring, from, to, v0, t, out);
}

// ─── supportsCompositor (capability detection, SSR-safe) ─────────────────────

/**
 * Пригодна ли цель/среда для compositor-пути: WAAPI + исполнимая форма кривой.
 * WebKit использует явные кадры без многостопового linear(); остальные движки —
 * CSS linear(). SSR-safe: среда читается только внутри вызова, без цели
 * проверяется Element.prototype.animate. Оба решения мемоизированы в detect.ts.
 */
export function supportsCompositor(target?: unknown): boolean {
  return supportsWaapi(target) &&
    (requiresExplicitSpringKeyframes() || supportsLinearEasing());
}

// ─── CompositorSpring (контроллер: ретаргет + байт-паритетный fallback) ──────

/**
 * Инжектируемый таймер отложенного старта для FALLBACK-пути. Контракт:
 * (cb, ms) → cancel-функция (идемпотентна). По умолчанию setTimeout/clearTimeout.
 * Возврат cancel-функции (а не handle) — чтобы seam не завязывался на clearTimeout
 * конкретной среды (тот же принцип, что RequestFrameFn: платформа за seam'ом).
 */
export type SetTimerFn = (cb: () => void, ms: number) => () => void;

/** Опции контроллера CompositorSpring. */
export interface CompositorSpringOptions {
  readonly spring: SpringParams;
  /** CSS-свойство. Непустое. */
  readonly property: string;
  /** Начальное значение. */
  readonly from: number;
  /** Целевое значение. */
  readonly to: number;
  /**
   * Цель WAAPI (duck-typed Element с .animate()). Нет/без .animate → fallback на
   * main-thread драйвер (MotionValue).
   */
  readonly target?: WaapiAnimatable | undefined;
  /**
   * Писатель значения для FALLBACK-пути (вызывается на каждый кадр
   * main-thread-драйвера). На compositor-пути НЕ вызывается (значение пишет
   * браузер — в этом суть нулевой работы main-потока). Формат — как в keyframes.
   */
  readonly apply?: ((value: string | number) => void) | undefined;
  readonly tolerance?: number | undefined;
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both' | undefined;
  readonly composite?: 'replace' | 'add' | 'accumulate' | undefined;
  readonly format?: ((v: number) => string | number) | undefined;
  /** Часы (мс) для замера elapsed ретаргета. По умолчанию performance.now/Date.now. */
  readonly now?: (() => number) | undefined;
  /** Инжектируемый requestFrame для fallback-драйвера. */
  readonly requestFrame?: RequestFrameFn | undefined;
  /**
   * Задержка старта (мс, >= 0). По умолчанию 0. На COMPOSITOR-пути — нативный
   * WAAPI-delay (браузер планирует старт off-main-thread, ноль работы main-потока
   * в окне задержки); на FALLBACK-пути — отложенный первый setTarget через
   * setTimer-seam. Применяется ТОЛЬКО к первичному start(); retarget/handoff —
   * события «сейчас» (delay НЕ переигрывается). Основа composited stagger.
   * В тире 'reduced' игнорируется: reduce перекрывает и каскад (снап сразу).
   */
  readonly delay?: number | undefined;
  /**
   * Инжектируемый таймер для FALLBACK-задержки старта (см. SetTimerFn). По
   * умолчанию setTimeout/clearTimeout (SSR-safe). На compositor-пути НЕ нужен
   * (delay нативный); инъекция — для детерминизма тестов.
   */
  readonly setTimer?: SetTimerFn | undefined;
  /**
   * Инжектируемый matchMedia (window.matchMedia.bind(window)). При
   * prefers-reduced-motion: reduce контроллер выбирает тир 'reduced' —
   * мгновенный снап к цели вместо анимации (та же политика доступности, что у
   * drive/keyframes/presets: единый снап во всём пакете, без дрифта). Детекция
   * один раз в конструкторе; смена системного предпочтения в полёте не
   * подхватывается (согласовано с drive — проверка на границе входа).
   */
  readonly matchMedia?: MatchMediaLike | undefined;
}

type CompositorAnimation = {
  cancel?: () => void;
  currentTime?: number | null;
};

/** WAAPI effect и fallback timer взаимоисключающи и делят один owner-слот. */
type HostOwner = CompositorAnimation | (() => void) | null | undefined;

/**
 * Контроллер пружины к значению для АВТОНОМНЫХ переходов и RELEASE-фазы,
 * автоматически выбирающий путь (fire-and-forget one-shot, НЕ per-frame цикл):
 *
 *  • COMPOSITOR (WAAPI + CSS linear()): компилирует план и коммитит в Element.animate().
 *    Steady-state — ноль работы main-потока. retarget() — РЕДКОЕ ONE-SHOT событие:
 *    читает (value, velocity) из serialized stops по `Animation.currentTime`
 *    (без style/layout), отменяет Animation и эмитит новую кривую с этой скоростью.
 *
 *  • ЖИВОЙ rAF (тиры waapi-no-linear / raf / ssr): main-thread драйвер MotionValue,
 *    чей setTarget() уже делает smooth-pickup (перенос скорости). Значения — в apply().
 *
 *  • СНАП (тир reduced, prefers-reduced-motion): мгновенно эмитит финальное значение,
 *    без анимации — единая снап-политика доступности пакета (см. matchMedia-опцию).
 *
 * ПУТЬ ВЫБИРАЕТСЯ ОДИН РАЗ в конструкторе (resolveCompositorTier, detect.ts) —
 * fallback-матрица из 5 тиров; фактический тир виден как `.tier` (телеметрия),
 * `.mode` ('compositor' | 'fallback') сохранён для обратной совместимости.
 * Полная таблица «тир → поведение → что теряем» — в README «Fallback-матрица».
 *
 * ГРАНИЦЫ (red-team 2026-07-08): НЕ вызывать retarget() каждый кадр
 * (gesture-follow) — это АНТИПАТТЕРН (cancel+re-emit на кадр). Follow-фаза жестов
 * живёт на MAIN-потоке (drive/MotionValue). Здесь retarget — дискретное событие
 * (смена цели, прерывание перехода), стоящее ~один commit-кадр хендоффа.
 *
 * ГРАНИЦА НЕПРЕРЫВНОСТИ: в effect-space numeric/affine-канала при активном
 * default fill:'both' новый прогон точно продолжает piecewise position и правый
 * slope (на kink производная неоднозначна, выбран правый сегмент). Это не
 * обещание rendered-pixel C¹ для clamping, non-affine format, composite с
 * меняющимся underlying или fill вне active interval. SSR-safe: конструктор не
 * трогает DOM/часы; native time читается только при прерывании.
 */
export class CompositorSpring {
  private readonly _spring: SpringParams;
  private readonly _property: string;
  private readonly _tolerance: number;
  private readonly _fill: 'none' | 'forwards' | 'backwards' | 'both';
  private readonly _composite: 'replace' | 'add' | 'accumulate';
  private _format: ((v: number) => string | number) | undefined;
  private _target: WaapiAnimatable | undefined;
  private _apply: ((value: string | number) => void) | undefined;
  /** Часы — lifetime-capability: destroy снимает её до любого host cleanup. */
  private _now: (() => number) | undefined;
  private _requestFrame: RequestFrameFn | undefined;
  private readonly _delay: number;
  private _setTimer: SetTimerFn | undefined;
  private readonly _tier: CompositorTierCode;

  private _from: number;
  private _to: number;
  private _v0Norm = 0;
  private _startTime!: number;
  /** Задержка ТЕКУЩЕГО прогона (мс): _delay на первичном start, 0 на retarget/handoff. */
  private _startDelay!: number;
  /** Единственный host-owner; null резервирует незавершённый setTimer. */
  private _host: HostOwner;
  /** Один artifact — SSOT samples и duration текущего compositor-owner. */
  private _artifact: SpringExecutionArtifactTuple | undefined;
  private readonly _sample = { value: 0, velocity: 0 };
  private _mv: MotionValue | undefined;
  /** Монотонный identity-token текущего owner/continuation. */
  private _epoch = 0;
  /** Host cleanup блокирует мутации, пока current-owner continuation не выдаст capability. */
  private _cleaning?: true;

  /**
   * Единый мост «кадр живой пружины → внутреннее значение + apply». Один экземпляр
   * на контроллер, переиспользуется всеми живыми путями (_ensureFallback,
   * compositor→live хендофф, reduced-хендофф) — DRY: правило распространения
   * значения живёт в ОДНОМ месте (иначе тройной дубль тихо расходится). Читает
   * _apply/_format в момент ВЫЗОВА (после конструктора), поэтому bound-поле безопасно.
   */
  private readonly _onLiveFrame = (v: number): void => {
    const epoch = this._epoch;
    this._from = v;
    const value = this._apply && this._format!(v);
    if (this._epoch === epoch) this._apply?.(value!);
  };

  constructor(opts: CompositorSpringOptions) {
    validateSpringParams(opts.spring);
    if (typeof opts.property !== 'string' || opts.property.length === 0) {
      throw new MotionParamError('LM010');
    }
    this._from = validateFinite(opts.from);
    this._to = validateFinite(opts.to);
    // Дефолт валиден по построению — guard «передан ли tolerance» лишний.
    const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
    validateTolerance(tolerance);
    const delay = opts.delay ?? 0;
    if (!Number.isFinite(delay) || delay < 0) {
      throw new MotionParamError('LM013');
    }

    this._spring = opts.spring;
    this._property = opts.property;
    this._tolerance = tolerance;
    this._fill = opts.fill ?? 'both';
    this._composite = opts.composite ?? 'replace';
    this._format = opts.format ?? Number;
    this._target = opts.target;
    this._apply = opts.apply;
    this._requestFrame = opts.requestFrame;
    this._delay = delay;
    this._setTimer = opts.setTimer ?? defaultSetTimer;
    this._now = opts.now ?? defaultNow;
    // Детекция тира — единственное обращение к среде в конструкторе (SSR-safe),
    // один раз. matchMedia (reduce) имеет высший precedence над WAAPI/linear().
    this._tier = resolveCompositorTierCodeFromInputs(
      opts.target,
      opts.matchMedia,
      opts.requestFrame,
    );
  }

  /**
   * Диагностический тир пути деградации (для тестов/телеметрии). Один из
   * 'compositor' | 'waapi-no-linear' | 'raf' | 'reduced' | 'ssr'. Стабилен на
   * весь жизненный цикл контроллера (детекция один раз в конструкторе).
   */
  get tier(): CompositorTier {
    return COMPOSITOR_TIERS[this._tier]!;
  }

  /**
   * Путь исполнения (обратная совместимость). 'compositor' только для одноимённого
   * тира; все прочие тиры (включая reduced/ssr) → 'fallback' (не compositor-поток).
   */
  get mode(): 'compositor' | 'fallback' {
    return this._usesCompositor() ? 'compositor' : 'fallback';
  }

  /** Последнее известное значение контроллера (всегда конечно). */
  get value(): number {
    return this._from;
  }

  /**
   * Запускает анимацию from → to (с учётом стартовой задержки delay, если
   * задана). В тире 'reduced' — мгновенный снап к to; delay ИГНОРИРУЕТСЯ:
   * stagger-хореография (каскад отложенных снапов) — тоже движение, а политика
   * reduce перекрывает всё (единый снап во всём пакете, ноль дрифта).
   */
  start(): void {
    if (!this._now || this._cleaning) return;
    const generation = ++this._epoch;
    let artifact: SpringExecutionArtifactTuple | undefined;
    if (this._usesCompositor()) {
      validateSpringParams(this._spring);
      artifact = tryCompileSpringExecutionArtifactTupleUnchecked(
        this._spring,
        this._v0Norm,
        this._tolerance,
      );
      if (this._epoch !== generation) return;
      if (!artifact) {
        // Writer делает живую деградацию наблюдаемой; без него сохраняем честный
        // fail-fast контракт чистого compositor-контроллера.
        if (!this._apply) {
          compileSpringExecutionArtifactTupleUnchecked(
            this._spring,
            this._v0Norm,
            this._tolerance,
          );
        }
      }
    }
    if (artifact) {
      // Первичный старт несёт задержку (нативный WAAPI-delay, off-main-thread);
      // retarget/handoff вызывают _emitCompositor с delay=0 (события «сейчас»).
      this._emitCompositor(this._from, this._to, this._v0Norm, artifact, generation, this._delay);
      return;
    }

    this._releaseHost();
    if (this._epoch !== generation) return;
    if (this._tier === 3) {
      this._onLiveFrame(this._to);
      return;
    }
    // Живой rAF-путь (waapi-no-linear / raf / ssr).
    if (!this._ensureFallback(generation)) return;
    if (this._delay > 0) {
      // Fallback-каскад: callback атомарно потребляет timer-owner.
      this._adoptTimer(generation, () => this._setTimer!(() => {
        if (this._epoch === generation) {
          this._host = undefined;
          this._epoch++;
          this._mv!.setTarget(this._to);
        }
      }, this._delay));
    } else if (this._epoch === generation) {
      this._mv!.setTarget(this._to);
    }
  }

  /**
   * ONE-SHOT перенацеливание с сохранением effect-space правого slope. Для
   * ДИСКРЕТНЫХ событий (смена цели, прерывание перехода) — НЕ для покадрового
   * gesture-follow (антипаттерн, см. класс). На compositor-пути — O(log K)
   * snapshot (value, velocity) + cancel + пере-эмиссия (стоимость ~один
   * commit-кадр хендоффа); на fallback — MotionValue.setTarget.
   */
  retarget(newTarget: number): void {
    if (!this._now || this._cleaning) return;
    validateFinite(newTarget);
    const generation = ++this._epoch;

    if (this._tier === 3) {
      // reduce активен: снап к новой цели, без анимации.
      this._to = newTarget;
      this._onLiveFrame(newTarget);
      return;
    }

    if (!this._usesCompositor()) {
      // Живой rAF-путь: smooth-pickup MotionValue переносит скорость.
      this._releaseHost(); // retarget = «сейчас»: снимаем delay-owner
      if (this._epoch !== generation || !this._ensureFallback(generation)) return;
      this._to = newTarget;
      this._mv!.setTarget(newTarget);
      return;
    }

    // Compositor-путь.
    if (!this._host) {
      // Ещё не в полёте — просто задаём цель и стартуем свежий прогон.
      this._to = newTarget;
      this.start();
      return;
    }

    // В полёте: читаем фактическое effect-состояние в момент прерывания (без layout).
    const read = this._snapshot(generation);
    if (!read) return;
    const range = newTarget - read.value;
    const v0Norm = Math.abs(range) > RANGE_EPSILON
      ? read.velocity / range
      : read.velocity === 0
        ? 0
        : Infinity; // normalized curve cannot represent absolute impulse at zero range
    validateSpringParams(this._spring);
    const artifact = tryCompileSpringExecutionArtifactTupleUnchecked(
      this._spring,
      v0Norm,
      this._tolerance,
    );
    if (this._epoch !== generation) return;
    if (!artifact) {
      // Без writer live-путь не может сохранить видимый контракт. Ошибка должна
      // случиться ДО cancel: прежний compositor-прогон остаётся владельцем.
      if (!this._apply) {
        compileSpringExecutionArtifactTupleUnchecked(
          this._spring,
          v0Norm,
          this._tolerance,
        );
      }
      const mv = this._liveCandidate(read.value, read.velocity, generation);
      // Новый owner уже активен: отказ hostile host-cancel не должен откатить
      // хендофф или оставить ссылку на прежний Animation.
      this._adoptLive(mv, newTarget, generation);
      return;
    }
    // Donor остаётся owner до успешного возврата successor из animate().
    this._emitCompositor(read.value, newTarget, v0Norm, artifact, generation);
  }

  /**
   * ХЕНДОФФ compositor→live: снимает текущее (value, velocity) из execution stops
   * по native currentTime (без чтения style/layout), отменяет compositor-
   * Animation и продолжает движение ЖИВОЙ rAF-пружиной (MotionValue),
   * рождённой в этой effect-точке — position и выбранный правый slope непрерывны.
   * в follow-фазу жеста (будущая траектория стала интерактивной).
   *
   * newTarget — цель live-пружины: не задан → продолжаем к текущему `to` (хвост
   * воспроизводится точно); задан → сразу едем к новой цели с сохранённой
   * скоростью. Возвращает MotionValue: ПОСЛЕ хендоффа значением управляет
   * вызывающий (setTarget/stop/destroy у него), контроллер отдал владение.
   * stop()/destroy() контроллера всё же остановят/освободят и этот MotionValue
   * (страховка от утечки). SSR-safe: fallback-путь уже живой — вернёт свой mv.
   */
  handoffToLive(newTarget?: number): MotionValue {
    if (newTarget !== undefined) validateFinite(newTarget);

    // После destroy() контроллер мёртв: НЕ поднимаем новую live-петлю (иначе
    // зомби-rAF на уничтоженном элементе — утечка). Возвращаем инертное значение
    // (сконструировано и сразу destroy'нуто → цикл не стартует), сохраняя контракт
    // «всегда возвращает MotionValue». Зеркалит destroyed-инвариант start/retarget.
    if (!this._now || this._cleaning) {
      return this._inertValue();
    }
    const generation = ++this._epoch;

    if (this._tier !== 3 && !this._usesCompositor()) {
      // Живой rAF-путь (waapi-no-linear / raf / ssr): тот же MotionValue,
      // при новой цели — retarget через smooth-pickup.
      const pending = this._host !== undefined;
      // Handoff происходит «сейчас»: pending delay уступает live-owner, а его
      // поздний callback уже отрезан generation и не может повторить запуск.
      if (pending) this._releaseHost();
      if (!this._ensureFallback(generation)) return this._inertValue();
      const mv = this._mv!;
      if (newTarget !== undefined) {
        this._to = newTarget;
      }
      if (pending || newTarget !== undefined) mv.setTarget(this._to);
      return mv;
    }

    // Тир reduced: живой путь НЕ должен анимировать — MotionValue рождается уже
    // на цели (в покое), согласовано со снап-политикой; onChange эмитит текущее
    // значение сразу при подписке → apply(target) вызывается один раз.
    // Compositor-путь: снимок фактически исполняемой effect-кривой.
    const target = newTarget ?? this._to;
    let value = target;
    let velocity = 0;
    if (this._tier !== 3) {
      value = this._from;
      if (this._host) {
        const read = this._snapshot(generation);
        if (!read) return this._inertValue();
        value = read.value;
        velocity = read.velocity;
      }
    }
    const mv = this._liveCandidate(value, velocity, generation);
    this._adoptLive(mv, target, generation);
    return mv;
  }

  /**
   * Останавливает прогон (без разрушения контроллера). Позиция прерывания
   * compositor-эффекта НЕ фиксируется: cancel снимает effect, повторный
   * start()/retarget() запускает контроллер заново от последнего известного
   * значения. Пауза с сохранением позы — контракт handoffToLive(), не stop().
   */
  stop(): void {
    if (!this._now || this._cleaning) return;
    this._epoch++;
    // Сначала инвалидируем уже выданные кадры, затем зовём недоверенный host cleanup.
    this._mv?.stop();
    this._releaseHost();
  }

  /** Полностью останавливает и освобождает ресурсы. */
  destroy(): void {
    if (!this._now) return;
    const mv = this._mv;
    this._mv = undefined;
    // Permanent terminal и retention-разрыв публикуются до недоверенного cleanup.
    this._epoch++;
    this._artifact = this._format = this._setTimer = this._now =
      this._target = this._requestFrame = this._apply = undefined;
    this._releaseHost();
    mv?.destroy();
  }

  // ─── Приватное ──────────────────────────────────────────────────────────────

  private _usesCompositor(): boolean {
    return this._tier === 0 && !this._mv;
  }

  private _inertValue(): MotionValue {
    const value = new MotionValue({ initial: this._from, spring: this._spring });
    value.destroy();
    return value;
  }

  /** На cleanup-стеке только continuation текущего owner получает право мутации. */
  private _resume<A, R>(run: (arg: A) => R, arg: A): R {
    if (!this._cleaning) return run(arg);
    this._cleaning = undefined;
    try {
      return run(arg);
    } finally {
      this._cleaning = true;
    }
  }

  /** Слот снимается до первого недоверенного host-вызова. */
  private _releaseHost(): void {
    const host = this._host;
    this._host = undefined;
    this._cancelHost(host);
  }

  /** Cleanup не меняет identity-token: stale A не может подавить continuation B. */
  private _cancelHost(host: HostOwner): void {
    this._cleaning = true;
    try {
      if (typeof host === 'function') host();
      else host?.cancel?.();
    } catch {
      // Логический owner уже снят.
    }
    // Нетерминальные callers входят только из mutation-capability; destroy уже снял _now.
    this._cleaning = undefined;
  }

  /** CAS-граница setTimer: stale-return оплачивается, новый owner не стирается. */
  private _adoptTimer(generation: number, create: () => () => void): void {
    this._host = null;
    let host: () => void;
    try {
      host = create();
    } catch (error) {
      if (this._host === null) {
        this._host = undefined;
        this._epoch++;
      }
      throw error;
    }
    if (this._epoch === generation) {
      this._host = host;
    } else {
      if (this._host !== host) this._cancelHost(host);
    }
  }

  /** Фактический piecewise-снимок без style/layout-read. */
  private _snapshot(generation: number): { value: number; velocity: number } | undefined {
    const now = this._now!();
    if (this._epoch !== generation) return undefined;
    const currentTime = animationTimeOrFallback(
      this._host as CompositorAnimation,
      now - this._startTime,
    );
    if (this._epoch !== generation) return undefined;
    const sample = sampleSerializedSpringIntoUnchecked(
      this._artifact![1],
      this._artifact![2],
      currentTime,
      this._startDelay,
      this._sample,
    );
    const progress = sample.value;
    const rawValue = progress === 0
      ? this._from
      : progress === 1
        ? this._to
        : (1 - progress) * this._from + progress * this._to;
    // Scratch не пересекает публичную границу: оба вызывающих синхронно
    // копируют поля до следующего snapshot. Это убирает allocation на прерывание.
    sample.value = Number.isFinite(rawValue) ? rawValue : this._to;
    sample.velocity = scaleSerializedVelocity(sample.velocity, this._from, this._to);
    return sample;
  }

  private _emitCompositor(
    from: number,
    to: number,
    v0Norm: number,
    artifact: SpringExecutionArtifactTuple,
    generation: number,
    delayMs = 0,
  ): void {
    const plan = compileSpringRuntimeExecutionTupleUnchecked(
      this._spring,
      this._property,
      from,
      to,
      v0Norm,
      this._tolerance,
      this._fill,
      this._composite,
      this._format,
      artifact,
    );
    if (this._epoch !== generation) return;
    const now = this._now!();
    if (this._epoch !== generation) return;
    const donor = this._host;
    const host = this._target!.animate(plan[0], {
      duration: plan[2],
      easing: plan[1],
      iterations: 1,
      fill: plan[3],
      composite: plan[4],
      // Нативный WAAPI-delay только на первичном старте (delayMs>0); браузер
      // планирует старт off-main-thread — каскад stagger без работы main-потока.
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    }) as CompositorAnimation;
    if (this._epoch !== generation) {
      if (this._host !== host) this._cancelHost(host);
      return;
    }
    // Owner и metadata публикуются одним commit до отмены donor.
    this._host = host;
    this._from = from;
    this._to = to;
    this._v0Norm = v0Norm;
    this._startDelay = delayMs;
    this._startTime = now;
    this._artifact = artifact;
    if (donor !== host) this._cancelHost(donor);
  }

  /** Строит live-кандидата; ошибка не меняет metadata действующего donor. */
  private _liveCandidate(
    value: number,
    velocity: number,
    generation: number,
  ): MotionValue {
    const previous = this._from;
    const requestFrame = this._requestFrame;
    const mv = new MotionValue({
      initial: value,
      initialVelocity: velocity,
      spring: this._spring,
      clamp: false,
      // Capability охватывает весь tick: scheduler IO, все listeners и reschedule.
      requestFrame: requestFrame && ((callback) => this._resume(
        requestFrame,
        (timestamp) => this._resume(callback, timestamp),
      )),
    });
    try {
      mv.onChange(this._onLiveFrame);
      return mv;
    } catch (error) {
      if (this._epoch === generation) this._from = previous;
      mv.destroy();
      throw error;
    }
  }

  /** CAS-публикация live-owner; stale-кандидат оплачивается здесь же. */
  private _adoptLive(
    mv: MotionValue,
    target: number,
    generation: number,
  ): void {
    if (this._epoch === generation) {
      this._releaseHost();
      if (this._epoch === generation) {
        this._to = target;
        this._mv = mv;
        // Commit заканчивается до scheduler-IO: после cancel donor откат уже
        // воскрешал бы чужой owner, поэтому ошибка запуска оставляет mv повторяемым.
        mv.setTarget(target);
        return;
      }
    }
    mv.destroy();
  }

  private _ensureFallback(generation: number): boolean {
    if (this._mv) return this._epoch === generation;
    // clamp:false — честная пружина (overshoot эмитится), паритет с compositor-кривой
    // (linear() несёт overshoot). Тот же solveSpring → байт-паритет в узлах.
    const mv = this._liveCandidate(this._from, 0, generation);
    // Fallback рождается пассивным: start() сам выбирает немедленный setTarget
    // либо timer. Общий handoff-commit здесь преждевременно съедал бы delay.
    if (this._epoch === generation) {
      this._mv = mv;
      return true;
    }
    mv.destroy();
    return false;
  }
}

// Порядок хелперов подобран по gzip-словарю (замер охоты, поведение идентично).
/** Таймер по умолчанию: setTimeout → cancel через clearTimeout (SSR-safe). */
function defaultSetTimer(cb: () => void, ms: number): () => void {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
}

/** Часы по умолчанию: performance.now при наличии, иначе Date.now (SSR-safe). */
function defaultNow(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}
