/**
 * compositor/index.ts — компилятор пружина → compositor-план (subpath ./compositor).
 *
 * Тезис M1 (research «compass_1937 / compass_395597»): незанятая брешь индустрии —
 * ОБЪЕДИНЕНИЕ двух свойств, которых нет вместе ни у Motion, ни у GSAP, ни у Framer
 * Motion: (1) steady-state с НУЛЁМ работы main-потока (пружина скомпилирована один
 * раз в compositor-резидентный linear()-план на transform/opacity/filter — браузер
 * гоняет её на compositor-потоке, переживая любые фризы) И (2) ONE-SHOT хендофф с
 * СОХРАНЕНИЕМ СКОРОСТИ за O(1) (замкнутая форма читает позицию+скорость в момент
 * события, cancel + пере-эмиссия новой кривой, засеянной этой скоростью — C¹).
 *
 * Наше преимущество перед compositor-путём Motion (у которого spring→linear() —
 * СТАТИЧНЫЙ снимок, не умеющий перенацеливаться): closed-form солвер даёт (value,
 * velocity) аналитически, поэтому хендофф НЕ читает DOM (getComputedStyle форсил
 * бы синхронный recalc, побеждая compositor) — состояние держится в плане.
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
 * - WASM/SIMD для одиночных пружин: наш замер precompute-контрфакта −24.6%
 *   (Graphiti «lab-motion перф», bench.mjs) — closed-form уже в физ. оптимуме;
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
import { solveSpring } from '../internal/solver.js';
import {
  type SpringParams,
  settleTimeUpperBound,
  validateSpringParams,
} from '../spring.js';
import { supportsWaapi, type WaapiAnimatable } from '../waapi/index.js';
import { MotionValue, type RequestFrameFn } from '../motion-value.js';
import { buildSpringNodes, type SpringNode } from './segmenter.js';
import { SpringLinearCache, DEFAULT_CACHE_CAPACITY } from './cache.js';
import { handoffToLive } from './handoff.js';

export { type SpringNode } from './segmenter.js';
export { handoffToLive, type HandoffToLiveOptions } from './handoff.js';
export {
  compileStaggerPlan,
  CompositorStaggerGroup,
  type CompositorStaggerOptions,
  type CompositorStaggerPlan,
  type CompositorStaggerGroupOptions,
} from './stagger.js';

// ─── Толерантность по умолчанию (перцептивный бюджет) ────────────────────────
//
// Толерантность = макс. отклонение реконструкции в ЕДИНИЦАХ ПРОГРЕССА [0..1].
// Дефолт выведен из субпиксельного бюджета (research «compass_395597»): при
// ~400 ppi / 30 см 1 px ≈ 0.73 угл.мин, порог обнаружения смещения ~0.2–0.5
// угл.мин. 1/400 прогресса при типичной амплитуде UI-перемещения 100 px = 0.25 px
// ≈ 0.18 угл.мин — комфортно ниже порога. Крупнее амплитуда → передайте
// tolerance меньше (ε_progress = ε_px / амплитуда_px).
export const DEFAULT_TOLERANCE = 1 / 400;

// ─── Квантование ключа кэша ──────────────────────────────────────────────────
//
// Ключ кэша — пять квантованных целых. Шаг мелкий: компиляция идёт по
// ДЕ-квантованным параметрам, дельта ≪ tolerance (перцептивно невидима), так что
// план всегда соответствует ключу. Идентичные пружины-константы (staggered-списки,
// повторные интеракции) хешируются одинаково → делят один план.
const Q_MASS = 1e6;
const Q_STIFF = 1e4;
const Q_DAMP = 1e4;
const Q_V0 = 1e6;
const Q_TOL = 1e9;
/** Порог безопасного целого для квантованного ключа (за ним теряется точность). */
const SAFE_Q = 2 ** 52;

/** Порог вырожденного диапазона (деление на ~0 дало бы ±∞/NaN). */
const RANGE_EPSILON = 1e-10;

// ─── Финитные стражи (политика прогресса: не-конечное → цель/покой) ──────────

function clampToFinite(x: number, snap: number): number {
  return Number.isFinite(x) ? x : snap;
}

// ─── Эмиссия linear()-строки ─────────────────────────────────────────────────

/** Строит linear()-строку из узлов (округление: прогресс 4 знака, процент 3). */
function emitLinear(params: SpringParams, v0: number, tolerance: number): string {
  const nodes = buildSpringNodes(params, v0, tolerance);
  let out = 'linear(';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const p = Number(n.progress.toFixed(4));
    const pct = Number(n.percent.toFixed(3));
    out += `${p} ${pct}%`;
    if (i < nodes.length - 1) out += ', ';
  }
  return out + ')';
}

// ─── compileSpringLinear (общий кэш) ─────────────────────────────────────────

/** Опции компиляции пружины в linear(). */
export interface SpringLinearOptions {
  /** Нормализованная начальная скорость (0 = покой; ≠0 = ретаргет). По умолчанию 0. */
  readonly v0?: number;
  /** Макс. отклонение реконструкции в ед. прогресса. По умолчанию DEFAULT_TOLERANCE. */
  readonly tolerance?: number;
}

/** Общий (module-singleton) кэш — staggered-списки делят планы между элементами. */
const sharedCache = new SpringLinearCache(DEFAULT_CACHE_CAPACITY);

function validateTolerance(tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1) {
    throw new MotionParamError(
      `compositor: tolerance должен быть конечным в (0, 1), получено ${tolerance}`,
    );
  }
}

function quantizeKey(
  params: SpringParams,
  v0: number,
  tolerance: number,
): { a: number; b: number; c: number; d: number; e: number } | null {
  const a = Math.round(params.mass * Q_MASS);
  const b = Math.round(params.stiffness * Q_STIFF);
  const c = Math.round(params.damping * Q_DAMP);
  const d = Math.round(v0 * Q_V0);
  const e = Math.round(tolerance * Q_TOL);
  // Кэшируемо, только если ключ в безопасных целых И де-квантование не вырождает
  // физику (иначе — некэшируемая компиляция по СЫРЫМ params, корректность важнее).
  if (
    Math.abs(a) >= SAFE_Q || Math.abs(b) >= SAFE_Q || Math.abs(c) >= SAFE_Q ||
    Math.abs(d) >= SAFE_Q || Math.abs(e) >= SAFE_Q
  ) {
    return null;
  }
  if (!(a / Q_MASS > 0) || !(b / Q_STIFF > 0) || !(c / Q_DAMP >= 0)) return null;
  return { a, b, c, d, e };
}

/**
 * Пружина → CSS linear()-строка с АДАПТИВНЫМ числом узлов (минимум под бюджет
 * ошибки), через общий LRU-кэш. Чистая, SSR-safe, детерминированная.
 *
 * @param spring    — физические параметры (валидируются рано).
 * @param options   — v0 (нормализ.), tolerance (ед. прогресса).
 */
export function compileSpringLinear(spring: SpringParams, options?: SpringLinearOptions): string {
  validateSpringParams(spring);
  const v0 = options?.v0 ?? 0;
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(v0)) {
    throw new MotionParamError(`compositor: v0 должен быть конечным, получено ${v0}`);
  }
  validateTolerance(tolerance);

  const q = quantizeKey(spring, v0, tolerance);
  if (q === null) {
    // Некэшируемый край: компилируем по сырым параметрам без кэша (корректность).
    return emitLinear(spring, v0, tolerance);
  }
  // Ветка попадания возвращает строку ДО любой аллокации (zero-alloc hot-path).
  const hit = sharedCache.lookup(q.a, q.b, q.c, q.d, q.e);
  if (hit !== undefined) return hit;
  // Промах: компиляция по ДЕ-квантованным параметрам (план соответствует ключу).
  const s = emitLinear(
    { mass: q.a / Q_MASS, stiffness: q.b / Q_STIFF, damping: q.c / Q_DAMP },
    q.d / Q_V0,
    q.e / Q_TOL,
  );
  sharedCache.store(q.a, q.b, q.c, q.d, q.e, s);
  return s;
}

// ─── createSpringLinearCache (изолированный слот-кэш) ────────────────────────

/** Изолированный компилятор пружин со своим LRU (для тестов/независимых зон). */
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

/** Создаёт изолированный кэш-компилятор пружин с заданной ёмкостью LRU. */
export function createSpringLinearCache(capacity: number = DEFAULT_CACHE_CAPACITY): SpringLinearCompiler {
  const cache = new SpringLinearCache(capacity);
  return {
    compile(spring: SpringParams, options?: SpringLinearOptions): string {
      validateSpringParams(spring);
      const v0 = options?.v0 ?? 0;
      const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
      if (!Number.isFinite(v0)) {
        throw new MotionParamError(`compositor: v0 должен быть конечным, получено ${v0}`);
      }
      validateTolerance(tolerance);
      const q = quantizeKey(spring, v0, tolerance);
      if (q === null) return emitLinear(spring, v0, tolerance);
      const hit = cache.lookup(q.a, q.b, q.c, q.d, q.e);
      if (hit !== undefined) return hit;
      const s = emitLinear(
        { mass: q.a / Q_MASS, stiffness: q.b / Q_STIFF, damping: q.c / Q_DAMP },
        q.d / Q_V0,
        q.e / Q_TOL,
      );
      cache.store(q.a, q.b, q.c, q.d, q.e, s);
      return s;
    },
    clear(): void {
      cache.clear();
    },
    get size(): number {
      return cache.size;
    },
    get capacity(): number {
      return cache.capacity;
    },
  };
}

// ─── compileSpringPlan (полный план для Element.animate) ─────────────────────

/** Аргументы Element.animate() + метаданные плана. */
export interface CompositorPlan {
  /** Кейфреймы [{prop: from}, {prop: to}] (вся кривая — в easing). */
  readonly keyframes: Record<string, string | number>[];
  /** CSS linear()-строка (пружинная траектория как easing). */
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

function validateFinite(v: number, name: string): void {
  if (!Number.isFinite(v)) {
    throw new MotionParamError(`compositor: ${name} должен быть конечным, получено ${v}`);
  }
}

/**
 * Пружина + from/to/property → полный план для Element.animate(). Compositor-путь:
 * два кейфрейма [from, to] на свойстве, ВСЯ пружинная кривая — в адаптивном
 * linear()-easing. Чистая, SSR-safe (не трогает DOM).
 */
export function compileSpringPlan(options: CompositorPlanOptions): CompositorPlan {
  validateSpringParams(options.spring);
  if (typeof options.property !== 'string' || options.property.length === 0) {
    throw new MotionParamError(`compositor: property должен быть непустой строкой`);
  }
  // Имена метаданных кейфрейма WAAPI: значение свойства перезаписало бы их.
  if (options.property === 'offset' || options.property === 'easing' || options.property === 'composite') {
    throw new MotionParamError(
      `compositor: property '${options.property}' конфликтует с полем WAAPI-кейфрейма` +
        (options.property === 'offset' ? `; CSS-свойство offset задаётся как 'cssOffset'` : ''),
    );
  }
  validateFinite(options.from, 'from');
  validateFinite(options.to, 'to');
  const v0 = options.v0 ?? 0;
  validateFinite(v0, 'v0');
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  validateTolerance(tolerance);

  const settleMs = settleDurationSeconds(options.spring) * 1000;
  const easing = compileSpringLinear(options.spring, { v0, tolerance });
  const nodes = buildSpringNodes(options.spring, v0, tolerance);
  const format = options.format ?? ((v: number): string | number => v);

  return {
    keyframes: [
      { offset: 0, [options.property]: format(options.from) },
      { offset: 1, [options.property]: format(options.to) },
    ],
    easing,
    duration: settleMs,
    iterations: 1,
    fill: options.fill ?? 'both',
    composite: options.composite ?? 'replace',
    nodes,
  };
}

/**
 * Длительность плана (секунды) = канонический settle spring.ts (grounded, не ново).
 * settleTimeUpperBound — запечатанный закон оседания ядра (≤ бюджета кадра-капа,
 * валидирован бенчами #64). Переиспользуем, чтобы НЕ плодить параллельную
 * settle-константу (класс дрифта). Для валидных params конечно > 0.
 */
function settleDurationSeconds(params: SpringParams): number {
  const t = settleTimeUpperBound(params);
  return Number.isFinite(t) && t > 0 ? t : 1;
}

// ─── readCompositorSpring (O(1) аналитическое чтение для ретаргета) ──────────

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
): { value: number; velocity: number } {
  validateSpringParams(spring);
  const from = options.from ?? 0;
  const to = options.to ?? 1;
  const v0 = options.v0 ?? 0;
  const t = options.t;
  validateFinite(from, 'from');
  validateFinite(to, 'to');
  validateFinite(v0, 'v0');
  if (!Number.isFinite(t)) {
    throw new MotionParamError(`compositor: t должен быть конечным, получено ${t}`);
  }
  const raw = solveSpring(spring, t, v0);
  const range = to - from;
  // Политика прогресса (зеркалит motion-value): не-конечное value → цель (1),
  // velocity → 0. Финальный клэмп: даже конечный range может переполниться до
  // ∞ на экстремальных величинах — тогда снап к (валидно-конечной) цели.
  const normPos = clampToFinite(raw.value, 1);
  const normVel = clampToFinite(raw.velocity, 0);
  const value = clampToFinite(from + normPos * range, to);
  const velocity = clampToFinite(normVel * range, 0);
  return { value, velocity };
}

// ─── supportsCompositor (capability detection, SSR-safe) ─────────────────────

/** Поддерживает ли среда CSS linear()-easing (Baseline 12.2023). */
function linearEasingSupported(): boolean {
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
  if (css !== undefined && typeof css.supports === 'function') {
    try {
      return css.supports('transition-timing-function', 'linear(0, 1)');
    } catch {
      return false;
    }
  }
  // Нет CSS-API для проверки (SSR/старый тест-env): считаем поддержкой (Baseline
  // 12.2023) — при живом WAAPI linear() практически всегда есть.
  return true;
}

/**
 * Пригодна ли цель/среда для compositor-пути (WAAPI + CSS linear()). SSR-safe:
 * проверка среды только внутри вызова; без цели проверяет Element.prototype.animate.
 */
export function supportsCompositor(target?: unknown): boolean {
  return supportsWaapi(target) && linearEasingSupported();
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
   */
  readonly delay?: number | undefined;
  /**
   * Инжектируемый таймер для FALLBACK-задержки старта (см. SetTimerFn). По
   * умолчанию setTimeout/clearTimeout (SSR-safe). На compositor-пути НЕ нужен
   * (delay нативный); инъекция — для детерминизма тестов.
   */
  readonly setTimer?: SetTimerFn | undefined;
}

/**
 * Контроллер пружины к значению для АВТОНОМНЫХ переходов и RELEASE-фазы,
 * автоматически выбирающий путь (fire-and-forget one-shot, НЕ per-frame цикл):
 *
 *  • COMPOSITOR (WAAPI доступен): компилирует план и коммитит в Element.animate().
 *    Steady-state — ноль работы main-потока. retarget() — РЕДКОЕ ONE-SHOT событие:
 *    читает (value, velocity) ЗАМКНУТОЙ ФОРМОЙ (readCompositorSpring, без чтения
 *    DOM), отменяет Animation и эмитит новую кривую, засеянную этой скоростью.
 *
 *  • FALLBACK (WAAPI нет): существующий main-thread драйвер MotionValue, чей
 *    setTarget() уже делает smooth-pickup (перенос скорости). Значения — в apply().
 *
 * ГРАНИЦЫ (red-team 2026-07-08): НЕ вызывать retarget() каждый кадр
 * (gesture-follow) — это АНТИПАТТЕРН (cancel+re-emit на кадр). Follow-фаза жестов
 * живёт на MAIN-потоке (drive/MotionValue). Здесь retarget — дискретное событие
 * (смена цели, прерывание перехода), стоящее ~один commit-кадр хендоффа.
 *
 * ГАРАНТИЯ НЕПРЕРЫВНОСТИ (C¹) при ретаргете: новый прогон стартует с ТОЧНОЙ
 * позиции (from' = readCompositorSpring().value — непрерывность C⁰) и с ТОЧНОЙ
 * скоростью (v0' = velocity/range' — непрерывность C¹), обе взяты из аналитической
 * модели в момент события. Ни позиция, ни скорость не имеют разрыва. На
 * fallback-пути ту же гарантию несёт smooth-pickup MotionValue (solveSpring с
 * произвольным v0). SSR-safe: конструктор не трогает DOM/часы (кроме
 * feature-detect); часы читаются лениво в start()/retarget().
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
  private readonly _mode: 'compositor' | 'fallback';

  private _from: number;
  private _to: number;
  private _v0Norm = 0;
  private _value: number;
  private _startTime = 0;
  /** Задержка ТЕКУЩЕГО прогона (мс): _delay на первичном start, 0 на retarget/handoff. */
  private _startDelay = 0;
  private _anim: { cancel?: () => void } | undefined;
  private _mv: MotionValue | undefined;
  /** Cancel-функция отложенного fallback-старта (пока задержка не истекла). */
  private _timerCancel: (() => void) | undefined;
  private _started = false;
  private _destroyed = false;

  constructor(opts: CompositorSpringOptions) {
    validateSpringParams(opts.spring);
    if (typeof opts.property !== 'string' || opts.property.length === 0) {
      throw new MotionParamError(`CompositorSpring: property должен быть непустой строкой`);
    }
    validateFinite(opts.from, 'from');
    validateFinite(opts.to, 'to');
    if (opts.tolerance !== undefined) validateTolerance(opts.tolerance);
    const delay = opts.delay ?? 0;
    if (!Number.isFinite(delay) || delay < 0) {
      throw new MotionParamError(`CompositorSpring: delay должен быть >= 0 и конечным, получено ${delay}`);
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
    // Выбор пути — единственное обращение к среде в конструкторе (SSR-safe).
    this._mode = supportsCompositor(opts.target) ? 'compositor' : 'fallback';
  }

  /** Текущий путь исполнения. */
  get mode(): 'compositor' | 'fallback' {
    return this._mode;
  }

  /** Текущее аналитическое значение (всегда конечно). */
  get value(): number {
    return this._value;
  }

  /** Запускает анимацию from → to (с учётом стартовой задержки delay, если задана). */
  start(): void {
    if (this._destroyed) return;
    this._started = true;
    if (this._mode === 'compositor') {
      // Первичный старт несёт задержку (нативный WAAPI-delay, off-main-thread);
      // retarget/handoff вызывают _emitCompositor с delay=0 (события «сейчас»).
      this._emitCompositor(this._from, this._to, this._v0Norm, this._delay);
    } else {
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
   * ONE-SHOT перенацеливание на newTarget с сохранением скорости (C¹). Для
   * ДИСКРЕТНЫХ событий (смена цели, прерывание перехода) — НЕ для покадрового
   * gesture-follow (антипаттерн, см. класс). На compositor-пути — O(1) чтение
   * (value, velocity) + cancel + пере-эмиссия (стоимость ~один commit-кадр
   * хендоффа); на fallback — MotionValue.setTarget (smooth-pickup).
   */
  retarget(newTarget: number): void {
    if (this._destroyed) return;
    validateFinite(newTarget, 'newTarget');

    if (this._mode === 'fallback') {
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

    // В полёте: читаем аналитическое состояние в момент прерывания (без DOM).
    const read = this._snapshot();
    // Отменяем текущую Animation (compositor запускает новую).
    if (typeof this._anim.cancel === 'function') {
      try {
        this._anim.cancel();
      } catch {
        // duck-typed цель могла не реализовать cancel полноценно — не роняем ретаргет.
      }
    }
    const range = newTarget - read.value;
    const v0Norm = Math.abs(range) > RANGE_EPSILON ? read.velocity / range : 0;
    this._emitCompositor(read.value, newTarget, v0Norm);
  }

  /**
   * ХЕНДОФФ compositor→live: снимает текущее (value, velocity) ЗАМКНУТОЙ ФОРМОЙ
   * (readCompositorSpring по elapsed, без чтения DOM), отменяет compositor-
   * Animation и продолжает движение ЖИВОЙ rAF-пружиной (MotionValue),
   * рождённой в этой точке — позиция И скорость непрерывны (C¹). Для перехода
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
    if (newTarget !== undefined) validateFinite(newTarget, 'newTarget');

    // После destroy() контроллер мёртв: НЕ поднимаем новую live-петлю (иначе
    // зомби-rAF на уничтоженном элементе — утечка). Возвращаем инертное значение
    // (сконструировано и сразу destroy'нуто → цикл не стартует), сохраняя контракт
    // «всегда возвращает MotionValue». Зеркалит destroyed-инвариант start/retarget.
    if (this._destroyed) {
      const inert = new MotionValue({ initial: this._value, spring: this._spring });
      inert.destroy();
      return inert;
    }

    if (this._mode === 'fallback') {
      // Уже на main-потоке: тот же MotionValue, при новой цели — retarget.
      this._ensureFallback();
      if (newTarget !== undefined) {
        this._to = newTarget;
        this._mv!.setTarget(newTarget);
      }
      this._started = true;
      return this._mv!;
    }

    // Compositor-путь: аналитический снимок состояния в момент хендоффа.
    let value = this._from;
    let velocity = 0;
    if (this._started && this._anim !== undefined) {
      const read = this._snapshot();
      value = read.value;
      velocity = read.velocity;
      if (typeof this._anim.cancel === 'function') {
        try {
          this._anim.cancel();
        } catch {
          /* см. retarget */
        }
      }
      this._anim = undefined;
    }
    const target = newTarget ?? this._to;
    const mv = handoffToLive({
      spring: this._spring,
      value,
      velocity,
      target,
      requestFrame: this._requestFrame,
      clamp: false,
      onChange: (v: number) => {
        this._value = v;
        if (this._apply !== undefined) this._apply(this._format(v));
      },
    });
    this._to = target;
    this._mv = mv;
    this._started = true;
    return mv;
  }

  /** Останавливает прогон (без разрушения; повторный start()/retarget() возобновит). */
  stop(): void {
    this._clearTimer(); // снять отложенный fallback-старт, если задержка не истекла
    if (this._mode === 'compositor') {
      if (this._anim !== undefined && typeof this._anim.cancel === 'function') {
        try {
          this._anim.cancel();
        } catch {
          /* см. retarget */
        }
      }
      this._anim = undefined;
      // Мог быть отдан live-mv через handoffToLive() — остановить и его (анти-утечка).
      if (this._mv !== undefined) this._mv.stop();
    } else if (this._mv !== undefined) {
      this._mv.stop();
    }
    this._started = false;
  }

  /** Полностью останавливает и освобождает ресурсы. */
  destroy(): void {
    this.stop();
    if (this._mv !== undefined) this._mv.destroy();
    this._destroyed = true;
  }

  // ─── Приватное ──────────────────────────────────────────────────────────────

  /**
   * Аналитический снимок (value, velocity) текущего compositor-прогона по elapsed
   * (замкнутая форма, БЕЗ чтения DOM) — общий механизм retarget и handoffToLive.
   */
  private _snapshot(): { value: number; velocity: number } {
    // Физический t=0 пружины наступает ПОСЛЕ окна задержки (WAAPI держит `from` в
    // delay-фазе): вычитаем _startDelay. До старта (t<0) читаем from, скорость 0.
    const tSec = (this._now() - this._startTime - this._startDelay) / 1000;
    return readCompositorSpring(this._spring, {
      from: this._from,
      to: this._to,
      v0: this._v0Norm,
      t: tSec >= 0 ? tSec : 0,
    });
  }

  private _emitCompositor(from: number, to: number, v0Norm: number, delayMs = 0): void {
    const plan = compileSpringPlan({
      spring: this._spring,
      property: this._property,
      from,
      to,
      v0: v0Norm,
      tolerance: this._tolerance,
      fill: this._fill,
      composite: this._composite,
      format: this._format,
    });
    this._from = from;
    this._to = to;
    this._v0Norm = v0Norm;
    this._value = from;
    this._startDelay = delayMs;
    this._startTime = this._now();
    this._anim = this._target!.animate(plan.keyframes, {
      duration: plan.duration,
      easing: plan.easing,
      iterations: plan.iterations,
      fill: plan.fill,
      composite: plan.composite,
      // Нативный WAAPI-delay только на первичном старте (delayMs>0); браузер
      // планирует старт off-main-thread — каскад stagger без работы main-потока.
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    }) as { cancel?: () => void };
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
    this._mv.onChange((v: number) => {
      this._value = v;
      if (this._apply !== undefined) this._apply(this._format(v));
    });
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
