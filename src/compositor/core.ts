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
  type SpringSerializedSamples,
  DEFAULT_TOLERANCE,
  tryCompileSpringExecutionArtifactTupleUnchecked,
  validateTolerance,
} from './curve.js';
import {
  compileSpringRuntimeExecutionTupleUnchecked,
} from './execution.js';
import {
  animationTimeOrFallback,
  sampleSerializedSpring,
  scaleSerializedVelocity,
} from './sample.js';
import { handoffToLive } from './handoff.js';
import {
  type CompositorTier,
  type MatchMediaLike,
  requiresExplicitSpringKeyframes,
  resolveCompositorTier,
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

/**
 * Пружина → CSS linear()-строка с АДАПТИВНЫМ числом узлов (минимум под бюджет
 * ошибки), через общий bounded cache. Чистая, SSR-safe, детерминированная.
 *
 * @param spring    — физические параметры (валидируются рано).
 * @param options   — v0 (нормализ.), tolerance (ед. прогресса).
 */
export function compileSpringLinear(spring: SpringParams, options?: SpringLinearOptions): string {
  validateSpringParams(spring);
  const v0 = options?.v0 ?? 0;
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(v0)) {
    throw new MotionParamError('LM008');
  }
  validateTolerance(tolerance);
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
      const v0 = options?.v0 ?? 0;
      const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
      if (!Number.isFinite(v0)) {
        throw new MotionParamError('LM008');
      }
      validateTolerance(tolerance);
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
  /** Fill. По умолчанию 'both'. */
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both';
  /** Composite. По умолчанию 'replace'. */
  readonly composite?: 'replace' | 'add' | 'accumulate';
  /** Форматтер значения (единицы/шаблоны). По умолчанию число как есть. */
  readonly format?: (v: number) => string | number;
}

function validateFinite(v: number): void {
  if (!Number.isFinite(v)) {
    throw new MotionParamError('LM009');
  }
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
  const v0 = options.v0 ?? 0;
  validateFinite(v0);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  validateTolerance(tolerance);

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
  const from = options.from ?? 0;
  const to = options.to ?? 1;
  const v0 = options.v0 ?? 0;
  const t = options.t;
  validateFinite(from);
  validateFinite(to);
  validateFinite(v0);
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
  private readonly _format: (v: number) => string | number;
  private readonly _target: WaapiAnimatable | undefined;
  private readonly _apply: ((value: string | number) => void) | undefined;
  private readonly _now: () => number;
  private readonly _requestFrame: RequestFrameFn | undefined;
  private readonly _delay: number;
  private readonly _setTimer: SetTimerFn;
  private readonly _tier: CompositorTier;

  private _from: number;
  private _to: number;
  private _v0Norm = 0;
  private _value: number;
  private _startTime = 0;
  /** Задержка ТЕКУЩЕГО прогона (мс): _delay на первичном start, 0 на retarget/handoff. */
  private _startDelay = 0;
  private _anim: { cancel?: () => void; currentTime?: number | null } | undefined;
  private _samples: SpringSerializedSamples | undefined;
  private _durationMs = 0;
  private readonly _sample = { value: 0, velocity: 0 };
  private _mv: MotionValue | undefined;
  /** Cancel-функция отложенного fallback-старта (пока задержка не истекла). */
  private _timerCancel: (() => void) | undefined;
  private _started = false;
  private _destroyed = false;
  /** Capability остаётся compositor, но конкретный owner может стать live. */
  private _forceLive = false;

  /**
   * Единый мост «кадр живой пружины → внутреннее значение + apply». Один экземпляр
   * на контроллер, переиспользуется всеми живыми путями (_ensureFallback,
   * compositor→live хендофф, reduced-хендофф) — DRY: правило распространения
   * значения живёт в ОДНОМ месте (иначе тройной дубль тихо расходится). Читает
   * _apply/_format в момент ВЫЗОВА (после конструктора), поэтому bound-поле безопасно.
   */
  private readonly _onLiveFrame = (v: number): void => {
    this._value = v;
    if (this._apply !== undefined) this._apply(this._format(v));
  };

  constructor(opts: CompositorSpringOptions) {
    validateSpringParams(opts.spring);
    if (typeof opts.property !== 'string' || opts.property.length === 0) {
      throw new MotionParamError('LM010');
    }
    validateFinite(opts.from);
    validateFinite(opts.to);
    if (opts.tolerance !== undefined) validateTolerance(opts.tolerance);
    const delay = opts.delay ?? 0;
    if (!Number.isFinite(delay) || delay < 0) {
      throw new MotionParamError('LM013');
    }

    this._spring = opts.spring;
    this._property = opts.property;
    this._tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
    this._fill = opts.fill ?? 'both';
    this._composite = opts.composite ?? 'replace';
    this._format = opts.format ?? ((v: number): string | number => v);
    this._target = opts.target;
    this._apply = opts.apply;
    this._requestFrame = opts.requestFrame;
    this._delay = delay;
    this._setTimer = opts.setTimer ?? defaultSetTimer;
    this._now = opts.now ?? defaultNow;
    this._from = opts.from;
    this._to = opts.to;
    this._value = opts.from;
    // Детекция тира — единственное обращение к среде в конструкторе (SSR-safe),
    // один раз. matchMedia (reduce) имеет высший precedence над WAAPI/linear().
    this._tier = resolveCompositorTier({
      target: opts.target,
      matchMedia: opts.matchMedia,
      requestFrame: opts.requestFrame,
    });
  }

  /**
   * Диагностический тир пути деградации (для тестов/телеметрии). Один из
   * 'compositor' | 'waapi-no-linear' | 'raf' | 'reduced' | 'ssr'. Стабилен на
   * весь жизненный цикл контроллера (детекция один раз в конструкторе).
   */
  get tier(): CompositorTier {
    return this._tier;
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
    return this._value;
  }

  /**
   * Запускает анимацию from → to (с учётом стартовой задержки delay, если
   * задана). В тире 'reduced' — мгновенный снап к to; delay ИГНОРИРУЕТСЯ:
   * stagger-хореография (каскад отложенных снапов) — тоже движение, а политика
   * reduce перекрывает всё (единый снап во всём пакете, ноль дрифта).
   */
  start(): void {
    if (this._destroyed) return;
    this._started = true;
    let artifact: SpringExecutionArtifactTuple | undefined;
    if (this._usesCompositor()) {
      validateSpringParams(this._spring);
      artifact = tryCompileSpringExecutionArtifactTupleUnchecked(
        this._spring,
        this._v0Norm,
        this._tolerance,
      );
    }
    if (this._usesCompositor() && artifact === undefined) {
      // Writer делает живую деградацию наблюдаемой; без него сохраняем честный
      // fail-fast контракт чистого compositor-контроллера.
      if (this._apply === undefined) {
        compileSpringExecutionArtifactTupleUnchecked(
          this._spring,
          this._v0Norm,
          this._tolerance,
        );
      }
      this._forceLive = true;
    }
    if (this._usesCompositor()) {
      // Первичный старт несёт задержку (нативный WAAPI-delay, off-main-thread);
      // retarget/handoff вызывают _emitCompositor с delay=0 (события «сейчас»).
      this._emitCompositor(this._from, this._to, this._v0Norm, artifact!, this._delay);
    } else if (this._tier === 'reduced') {
      this._settleImmediately(this._to);
    } else {
      // Живой rAF-путь (waapi-no-linear / raf / ssr).
      this._ensureFallback();
      this._clearTimer();
      if (this._delay > 0) {
        // Fallback-каскад: отложенный первый setTarget через setTimer-seam,
        // чтобы задержка stagger сохранялась и на main-thread пути.
        this._timerCancel = this._setTimer(() => {
          this._timerCancel = undefined;
          if (!this._destroyed) this._mv!.setTarget(this._to);
        }, this._delay);
      } else {
        this._mv!.setTarget(this._to);
      }
    }
  }

  /** Отменяет отложенный fallback-старт, если задержка ещё не истекла. */
  private _clearTimer(): void {
    if (this._timerCancel !== undefined) {
      this._timerCancel();
      this._timerCancel = undefined;
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
    if (this._destroyed) return;
    validateFinite(newTarget);

    if (this._tier === 'reduced') {
      // reduce активен: снап к новой цели, без анимации.
      this._to = newTarget;
      this._settleImmediately(newTarget);
      this._started = true;
      return;
    }

    if (!this._usesCompositor()) {
      // Живой rAF-путь: smooth-pickup MotionValue переносит скорость.
      this._ensureFallback();
      this._clearTimer(); // retarget = «сейчас»: снимаем отложенный старт, если ждёт delay
      this._to = newTarget;
      this._mv!.setTarget(newTarget);
      this._started = true;
      return;
    }

    // Compositor-путь.
    if (!this._started || this._anim === undefined) {
      // Ещё не в полёте — просто задаём цель и стартуем свежий прогон.
      this._to = newTarget;
      this.start();
      return;
    }

    // В полёте: читаем фактическое effect-состояние в момент прерывания (без layout).
    const read = this._snapshot();
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
    if (artifact === undefined) {
      // Без writer live-путь не может сохранить видимый контракт. Ошибка должна
      // случиться ДО cancel: прежний compositor-прогон остаётся владельцем.
      if (this._apply === undefined) {
        compileSpringExecutionArtifactTupleUnchecked(
          this._spring,
          v0Norm,
          this._tolerance,
        );
      }
      const mv = handoffToLive({
        spring: this._spring,
        value: read.value,
        velocity: read.velocity,
        target: newTarget,
        requestFrame: this._requestFrame,
        clamp: false,
        onChange: this._onLiveFrame,
      });
      // Новый owner уже активен: отказ hostile host-cancel не должен откатить
      // хендофф или оставить ссылку на прежний Animation.
      this._cancelAnimation();
      this._forceLive = true;
      this._from = read.value;
      this._to = newTarget;
      this._v0Norm = v0Norm;
      this._mv = mv;
      this._started = true;
      return;
    }
    // Preflight доказал ограниченную кривую; только теперь снимаем старого owner.
    this._cancelAnimation();
    this._emitCompositor(read.value, newTarget, v0Norm, artifact);
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
    if (this._destroyed) {
      const inert = new MotionValue({ initial: this._value, spring: this._spring });
      inert.destroy();
      return inert;
    }

    if (this._tier === 'reduced') {
      // reduce активен: живой путь НЕ должен анимировать. Отдаём MotionValue,
      // рождённый уже на цели (в покое) — согласовано со снап-политикой. Значение
      // эмитится один раз; дальнейшее движение — на усмотрение владельца.
      const target = newTarget ?? this._to;
      this._to = target;
      this._value = target;
      const mv = new MotionValue({
        initial: target,
        spring: this._spring,
        clamp: false,
        requestFrame: this._requestFrame,
      });
      // onChange эмитит текущее значение сразу при подписке (motion-value: «Emit
      // current value immediately») → apply(target) вызывается один раз, снап-семантика.
      mv.onChange(this._onLiveFrame);
      this._mv = mv;
      this._started = true;
      return mv;
    }

    if (!this._usesCompositor()) {
      // Живой rAF-путь (waapi-no-linear / raf / ssr): тот же MotionValue,
      // при новой цели — retarget через smooth-pickup.
      this._ensureFallback();
      if (newTarget !== undefined) {
        this._to = newTarget;
        this._mv!.setTarget(newTarget);
      }
      this._started = true;
      return this._mv!;
    }

    // Compositor-путь: снимок фактически исполняемой effect-кривой.
    let value = this._from;
    let velocity = 0;
    if (this._started && this._anim !== undefined) {
      const read = this._snapshot();
      value = read.value;
      velocity = read.velocity;
      this._cancelAnimation();
    }
    const target = newTarget ?? this._to;
    const mv = handoffToLive({
      spring: this._spring,
      value,
      velocity,
      target,
      requestFrame: this._requestFrame,
      clamp: false,
      onChange: this._onLiveFrame,
    });
    this._to = target;
    this._mv = mv;
    this._forceLive = true;
    this._started = true;
    return mv;
  }

  /** Останавливает прогон (без разрушения; повторный start()/retarget() возобновит). */
  stop(): void {
    this._clearTimer(); // снять отложенный fallback-старт, если задержка не истекла
    // Единый путь для всех тиров: compositor держит _anim, живой/reduced — _mv,
    // снап — ни того ни другого. Отменяем/останавливаем то, что есть.
    this._cancelAnimation();
    // Мог быть отдан live-mv через handoffToLive() — остановить и его (анти-утечка).
    if (this._mv !== undefined) this._mv.stop();
    this._started = false;
  }

  /** Полностью останавливает и освобождает ресурсы. */
  destroy(): void {
    this.stop();
    if (this._mv !== undefined) this._mv.destroy();
    this._destroyed = true;
  }

  // ─── Приватное ──────────────────────────────────────────────────────────────

  private _usesCompositor(): boolean {
    return this._tier === 'compositor' && !this._forceLive;
  }

  /** Снимает host-owner один раз даже при бросающем getter/call cancel. */
  private _cancelAnimation(): void {
    const animation = this._anim;
    if (animation === undefined) return;
    try {
      const cancel = animation.cancel;
      if (typeof cancel === 'function') cancel.call(animation);
    } catch {
      // Host-object не должен удерживать уже логически снятое владение.
    } finally {
      this._anim = undefined;
    }
  }

  /** Фактический piecewise-снимок без style/layout-read. */
  private _snapshot(): { value: number; velocity: number } {
    const currentTime = animationTimeOrFallback(
      this._anim,
      this._now() - this._startTime,
    );
    const sample = sampleSerializedSpring(
      this._samples!,
      this._durationMs,
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
    this._from = from;
    this._to = to;
    this._v0Norm = v0Norm;
    this._value = from;
    this._startDelay = delayMs;
    this._startTime = this._now();
    this._samples = plan[5];
    this._durationMs = plan[2];
    this._anim = this._target!.animate(plan[0], {
      duration: plan[2],
      easing: plan[1],
      iterations: 1,
      fill: plan[3],
      composite: plan[4],
      // Нативный WAAPI-delay только на первичном старте (delayMs>0); браузер
      // планирует старт off-main-thread — каскад stagger без работы main-потока.
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    }) as { cancel?: () => void; currentTime?: number | null };
  }

  /**
   * Снап к value (политика reduced-motion): мгновенно ставит значение и эмитит
   * его один раз в apply, без анимации/цикла/аллокации MotionValue. Единая
   * снап-политика доступности пакета (drive/keyframes/presets тоже резолвятся в
   * финал сразу) — один характер во всём пакете, без дрифта.
   */
  private _settleImmediately(value: number): void {
    this._value = value;
    if (this._apply !== undefined) this._apply(this._format(value));
  }

  private _ensureFallback(): void {
    if (this._mv !== undefined) return;
    // clamp:false — честная пружина (overshoot эмитится), паритет с compositor-кривой
    // (linear() несёт overshoot). Тот же solveSpring → байт-паритет в узлах.
    this._mv = new MotionValue({
      initial: this._from,
      spring: this._spring,
      clamp: false,
      requestFrame: this._requestFrame,
    });
    this._mv.onChange(this._onLiveFrame);
  }
}

/** Часы по умолчанию: performance.now при наличии, иначе Date.now (SSR-safe). */
function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

/** Таймер по умолчанию: setTimeout → cancel через clearTimeout (SSR-safe). */
function defaultSetTimer(cb: () => void, ms: number): () => void {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
}
