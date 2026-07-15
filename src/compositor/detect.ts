/**
 * compositor/detect.ts — детекция тира деградации compositor-пути (subpath ./compositor).
 *
 * Одна дешёвая проверка возможностей выбирает, КАКИМ движком CompositorSpring
 * поведёт значение, и ПОЧЕМУ (диагностический ярлык для тестов/телеметрии).
 * Тир определяется только возможностями среды (WAAPI, CSS linear(), matchMedia).
 * Отдельная политика ФОРМЫ WAAPI-плана учитывает WebKit: движок принимает
 * многостоповый linear(), но не гарантирует независимое от главного потока
 * исполнение и при его блокировке визуально замирает. Эту скрытую возможность
 * нельзя проверить через API возможностей, поэтому локальный мемоизированный
 * шов использует пару navigator.vendor + AppleWebKit и выбирает явные ключевые
 * кадры с обычным linear.
 *
 * Матрица тиров (полная таблица «тир → поведение → что теряем» — в README):
 *
 *   'compositor'      WAAPI + (WebKit или CSS linear()) → план в Element.animate().
 *   'waapi-no-linear' WAAPI, но нет linear() → живой rAF (linear() не донесёт кривую).
 *   'raf'             нет WAAPI             → живой rAF (MotionValue, main-поток).
 *   'reduced'         prefers-reduced-motion: reduce → мгновенный снап к цели.
 *   'ssr'             нет DOM и нет инжектированного планировщика → тот же rAF-движок
 *                     под node-шимом, помечен как SSR (импорт не трогает globals).
 *
 * ПОРЯДОК precedence (важен): reduce проверяется ПЕРВЫМ — политика доступности
 * перекрывает любой доступный движок (снап независимо от WAAPI). Далее WAAPI →
 * linear(); WebKit с явными ключевыми кадрами не зависит от многостопового
 * linear(). При отсутствии WAAPI различаем raf/ssr по наличию площадки анимации.
 *
 * ПОВЕДЕНЧЕСКИ движков ДВА (compositor / живой rAF) + один снап (reduced). Ярлыки
 * 'waapi-no-linear'/'raf'/'ssr' различают ПРИЧИНУ живого пути (телеметрия), но
 * ведут в ОДИН и тот же rAF-движок — поэтому расширение аддитивно, ничего в
 * поведении существующих путей не меняется.
 *
 * КЭШ (детекция один раз, дёшево): результат CSS.supports('...linear...')
 * стабилен на реалм (не меняется без перезагрузки) и мемоизируется на уровне
 * модуля — сотня контроллеров staggered-списка платит за парс CSS-строки и
 * чтение engine identity по одному разу. Пер-таргетные (target.animate) и
 * пер-вызовные (matchMedia) проверки — дешёвый доступ к свойству, не кэшируются.
 * __resetDetectionCache() сбрасывает оба мемо для герметичности тестов (в
 * публичную поверхность ./compositor НЕ входит).
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

/** Числовой внутренний код: compositor/no-linear/raf/reduced/ssr. */
export type CompositorTierCode = 0 | 1 | 2 | 3 | 4;

/** Минимальная идентичность движка для непроверяемого способа исполнения. */
export interface EngineIdentity {
  readonly vendor?: string | undefined;
  readonly userAgent?: string | undefined;
}

// ─── Кэш поддержки CSS linear() ──────────────────────────────────────────────

let _linearMemo: boolean | undefined;
let _explicitKeyframesMemo: boolean | undefined;

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
 * Чистый шов идентичности для прямых тестов. Связка Apple vendor+AppleWebKit
 * отличает WebKit/iOS-браузеры от Chromium на macOS (его vendor — Google).
 */
export function requiresExplicitSpringKeyframesFor(identity: EngineIdentity | undefined): boolean {
  return (
    (identity?.vendor ?? '').includes('Apple') &&
    (identity?.userAgent ?? '').includes('AppleWebKit')
  );
}

/**
 * Нужны ли явные ключевые кадры WAAPI вместо многостопового CSS linear().
 * Производственный вызов читает navigator один раз на реалм; тестовая инжекция
 * отделена выше и вытряхивается из публичных сборок.
 */
export function requiresExplicitSpringKeyframes(): boolean {
  if (_explicitKeyframesMemo !== undefined) return _explicitKeyframesMemo;
  try {
    const nav = (globalThis as { navigator?: EngineIdentity }).navigator;
    _explicitKeyframesMemo = requiresExplicitSpringKeyframesFor(nav);
  } catch {
    _explicitKeyframesMemo = false;
  }
  return _explicitKeyframesMemo;
}

/**
 * Сброс мемо детекции — ТОЛЬКО для тестов (мок отсутствия linear() между рядами
 * матрицы). Не re-экспортируется через ./compositor: импортировать напрямую из
 * './detect.js', чтобы публичная поверхность субпутя осталась запинённой.
 */
export function __resetDetectionCache(): void {
  _linearMemo = undefined;
  _explicitKeyframesMemo = undefined;
}

// ─── Вспомогательные швы ──────────────────────────────────────────────────────

/** Активно ли предпочтение reduce (guard: нет matchMedia или бросок → false). */
export function prefersReduced(matchMedia: MatchMediaLike | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    // Window.matchMedia — host-метод с receiver-проверкой в части движков.
    // call убирает bind-замыкание из каждого animate-вызова.
    return matchMedia.call(globalThis, '(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ─── resolveCompositorTier ────────────────────────────────────────────────────

/**
 * Разрешает тир деградации по среде и входам — детекция один раз (вызывается в
 * конструкторе CompositorSpring). Чистая относительно входов; читает globals
 * (WAAPI/linear/DOM) через кэшированные/дешёвые швы. SSR-safe: без побочек.
 */
export function resolveCompositorTierCode(inputs: TierInputs): CompositorTierCode {
  return resolveCompositorTierCodeFromInputs(
    inputs.target,
    inputs.matchMedia,
    inputs.requestFrame,
  );
}

/** Positional hot seam: групповой compositor не создаёт N временных TierInputs. */
export function resolveCompositorTierCodeFromInputs(
  target: unknown,
  matchMedia: MatchMediaLike | undefined,
  requestFrame: unknown,
): CompositorTierCode {
  // Сначала policy: reduced не должен читать даже hostile target capability.
  if (prefersReduced(matchMedia)) return 3;
  return resolveCompositorTierCodeFromCapability(
    supportsWaapi(target),
    requestFrame,
  );
}

/** Внутренний вход после однократного non-policy capability snapshot. */
export function resolveCompositorTierCodeFromCapability(
  hasWaapi: boolean,
  requestFrame: unknown,
): CompositorTierCode {
  // 2. WebKit исполняет явные ключевые кадры с обычным linear, поэтому одного
  //    WAAPI достаточно. Остальным движкам нужен многостоповый CSS linear().
  if (hasWaapi) {
    return requiresExplicitSpringKeyframes() || supportsLinearEasing() ? 0 : 1;
  }
  // 3. WAAPI нет → живой rAF-движок. SSR-ярлык, если нет ни DOM, ни планировщика.
  return requestFrame !== undefined ||
    typeof document !== 'undefined' ||
    typeof window !== 'undefined'
      ? 2
      : 4;
}

/** Строковый public label отделён от компактного runtime-discriminant. */
export const COMPOSITOR_TIERS: readonly CompositorTier[] = [
  'compositor',
  'waapi-no-linear',
  'raf',
  'reduced',
  'ssr',
];

/** Публичный диагностический resolver сохраняет точные строковые ярлыки. */
export function resolveCompositorTier(inputs: TierInputs): CompositorTier {
  return COMPOSITOR_TIERS[resolveCompositorTierCode(inputs)]!;
}
