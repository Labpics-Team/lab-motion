/**
 * compositor/detect.ts — детекция тира деградации compositor-пути (subpath ./compositor).
 *
 * Одна дешёвая feature-detect-развилка выбирает, КАКИМ движком CompositorSpring
 * поведёт значение, и ПОЧЕМУ (диагностический ярлык для тестов/телеметрии).
 * Без UA-снифинга: только проверка возможностей среды (WAAPI, CSS linear(),
 * matchMedia) через инжектируемые/глобальные швы.
 *
 * Матрица тиров (полная таблица «тир → поведение → что теряем» — в README):
 *
 *   'compositor'      WAAPI + CSS linear()  → план в Element.animate() (off-main-thread).
 *   'waapi-no-linear' WAAPI, но нет linear() → живой rAF (linear() не донесёт кривую).
 *   'raf'             нет WAAPI             → живой rAF (MotionValue, main-поток).
 *   'reduced'         prefers-reduced-motion: reduce → мгновенный снап к цели.
 *   'ssr'             нет DOM и нет инжектированного планировщика → тот же rAF-движок
 *                     под node-шимом, помечен как SSR (импорт не трогает globals).
 *
 * ПОРЯДОК precedence (важен): reduce проверяется ПЕРВЫМ — политика доступности
 * перекрывает любой доступный движок (снап независимо от WAAPI). Далее WAAPI →
 * linear(); при отсутствии WAAPI различаем raf/ssr по наличию площадки анимации.
 *
 * ПОВЕДЕНЧЕСКИ движков ДВА (compositor / живой rAF) + один снап (reduced). Ярлыки
 * 'waapi-no-linear'/'raf'/'ssr' различают ПРИЧИНУ живого пути (телеметрия), но
 * ведут в ОДИН и тот же rAF-движок — поэтому расширение аддитивно, ничего в
 * поведении существующих путей не меняется.
 *
 * КЭШ (детекция один раз, дёшево): результат CSS.supports('...linear...')
 * стабилен на реалм (не меняется без перезагрузки) и мемоизируется на уровне
 * модуля — сотня контроллеров staggered-списка платит за парс CSS-строки один
 * раз. Пер-таргетные (target.animate) и пер-вызовные (matchMedia) проверки —
 * дешёвый доступ к свойству, не кэшируются. __resetDetectionCache() сбрасывает
 * мемо для герметичности тестов (в публичную поверхность ./compositor НЕ входит).
 */

import { supportsWaapi } from '../waapi/index.js';

/** Диагностический тир пути деградации. */
export type CompositorTier =
  | 'compositor'
  | 'waapi-no-linear'
  | 'raf'
  | 'reduced'
  | 'ssr';

/** Минимальный matchMedia-совместимый шов (как в drive/keyframes/presets). */
export type MatchMediaLike = (query: string) => { matches: boolean };

/** Входы детекции тира. */
export interface TierInputs {
  /** Цель WAAPI (duck-typed Element с .animate()). */
  readonly target?: unknown;
  /** Инжектируемый matchMedia (window.matchMedia.bind(window)); undefined = нет предпочтения. */
  readonly matchMedia?: MatchMediaLike | undefined;
  /**
   * Инжектированный планировщик кадров живого пути. Его наличие означает, что
   * потребитель ХОЧЕТ живой rAF-цикл (тест/кастомные часы) → тир 'raf', не 'ssr'.
   */
  readonly requestFrame?: unknown;
}

// ─── Кэш поддержки CSS linear() ──────────────────────────────────────────────

let _linearMemo: boolean | undefined;

/**
 * Поддерживает ли среда CSS linear()-easing (Baseline 12.2023). Мемоизируется:
 * CSS.supports парсит строку — на реалм результат стабилен. SSR/нет CSS-API →
 * true (при живом WAAPI linear() практически всегда есть; итог решает supportsWaapi).
 */
export function supportsLinearEasing(): boolean {
  if (_linearMemo !== undefined) return _linearMemo;
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
  let result: boolean;
  if (css !== undefined && typeof css.supports === 'function') {
    try {
      result = css.supports('transition-timing-function', 'linear(0, 1)');
    } catch {
      result = false;
    }
  } else {
    result = true;
  }
  _linearMemo = result;
  return result;
}

/**
 * Сброс мемо детекции — ТОЛЬКО для тестов (мок отсутствия linear() между рядами
 * матрицы). Не re-экспортируется через ./compositor: импортировать напрямую из
 * './detect.js', чтобы публичная поверхность субпутя осталась запинённой.
 */
export function __resetDetectionCache(): void {
  _linearMemo = undefined;
}

// ─── Вспомогательные швы ──────────────────────────────────────────────────────

/** Активно ли предпочтение reduce (guard: нет matchMedia или бросок → false). */
function prefersReduced(matchMedia: MatchMediaLike | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** Есть ли DOM-площадка анимации (браузер/jsdom), а не чистый серверный рантайм. */
function domPresent(): boolean {
  return typeof document !== 'undefined' || typeof window !== 'undefined';
}

// ─── resolveCompositorTier ────────────────────────────────────────────────────

/**
 * Разрешает тир деградации по среде и входам — детекция один раз (вызывается в
 * конструкторе CompositorSpring). Чистая относительно входов; читает globals
 * (WAAPI/linear/DOM) через кэшированные/дешёвые швы. SSR-safe: без побочек.
 */
export function resolveCompositorTier(inputs: TierInputs): CompositorTier {
  // 1. Политика доступности перекрывает всё (снап независимо от движка).
  if (prefersReduced(inputs.matchMedia)) return 'reduced';
  // 2. WAAPI есть → compositor при поддержке linear(), иначе живой rAF (ярлык).
  if (supportsWaapi(inputs.target)) {
    return supportsLinearEasing() ? 'compositor' : 'waapi-no-linear';
  }
  // 3. WAAPI нет → живой rAF-движок. SSR-ярлык, если нет ни DOM, ни планировщика.
  if (inputs.requestFrame !== undefined || domPresent()) return 'raf';
  return 'ssr';
}
