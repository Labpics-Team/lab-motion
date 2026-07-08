/**
 * tokens/index.ts — motion-токены: типобезопасный фундамент движения (subpath ./tokens).
 *
 * Subpath export: import { duration, easing, spring } from '@labpics/motion/tokens'
 *
 * ЗАЧЕМ (граница ответственности): это ФУНДАМЕНТ — примитивы длительностей,
 * изингов, пружин, дистанс-скейла и stagger-шага + их ИМЕНОВАНИЕ, готовое к
 * оркестрации сверху (роль → токен) слоем дизайн-системы (labui). Здесь НЕТ
 * семантики ролей («кнопка-ховер», «модал-вход») — только словарь примитивов.
 * Оркестрация (какой токен на какую роль) живёт у потребителя, НЕ тут.
 *
 * ВКУС (не кричащие дефолты): калибровано В ДУХЕ Apple (spring-first, спокойно),
 * Fluent 2 (сдержанная 8-ступенчатая шкала) и Material 3 (изинг-семейства
 * standard/decelerate/accelerate/emphasized). Дефолты — критично-задемпфированные
 * пружины и мягкие изинги: НИКАКОГО bounce-цирка по умолчанию (bounce — opt-in
 * токен). Значения — НЕ байт-копия одной системы, а осознанный выбор словаря;
 * запинены тестами (пины значений/имён) как контракт.
 *
 * Инварианты (наследуют ядро):
 *   1. Субпуть-изоляция: не импортируешь ./tokens — платишь ноль (ядро не растёт,
 *      проверено size-гейтом full-core). Весь субпуть ~1.1 KB gz. NB: внутри
 *      субпутя семейства НЕ шейкаются по отдельности в отгруженном (минифициров.)
 *      dist — `easing` тянет ../easing.cubicBezier (~0.9 KB) на любой импорт.
 *   2. Zero-DOM / SSR-safe — только данные и чистые функции.
 *   3. Детерминизм — distanceScale чист; одинаковый вход → бит-идентичный выход.
 *   4. Финитность — distanceScale клэмпит враждебный вход (NaN/∞ → границы band).
 *   5. Типобезопасность — `as const` + выведенные union-типы имён токенов.
 */

import { cubicBezier } from '../easing/index.js';
import type { SpringParams } from '../spring.js';

// ─── Длительности (мс) ───────────────────────────────────────────────────────
//
// Спокойная 5-ступенчатая шкала, калиброванная по Fluent 2 (fast 150 / normal
// 200-250) и Material 3 (short3 150, medium1 250, medium4 400, long4 600). Не
// кричащая: без суб-100мс «дёрганья» и без «кино»-затягиваний в дефолтах.
// instant=0 — мгновенный снэп (reduced-motion / без анимации).

/** Именованная шкала длительностей движения (мс). Tree-shakeable чистые данные. */
export const duration = {
  /** Мгновенно, 0 мс — снэп без анимации (reduced-motion край). */
  instant: 0,
  /** Быстрая микро-обратная связь (нажатие, тумблер), 150 мс. */
  fast: 150,
  /** Дефолтный UI-переход (появление, смена состояния), 250 мс. */
  normal: 250,
  /** Крупное перемещение / акцент, 400 мс. */
  slow: 400,
  /** Полноэкранный / hero-переход, 600 мс. */
  slower: 600,
} as const;

/** Имя токена длительности. */
export type DurationToken = keyof typeof duration;

// ─── Изинги (кривые CSS + функции движка) ────────────────────────────────────
//
// Семантические кривые в духе Material (standard / decelerate «вход» /
// accelerate «выход» / emphasized) и Fluent (easyEase). Каждый токен несёт ОБА
// представления из ОДНОГО источника координат: `fn` (EasingFn для ./stagger,
// ./keyframes, rAF-путей) и `css` (cubic-bezier() для WAAPI/CSS/compositor-пути).

/** Изинг-токен: функция движка (t∈[0,1]→прогресс) + строка CSS cubic-bezier(). */
export interface EasingToken {
  /** EasingFn — для rAF-путей (./keyframes, ./stagger.easing). */
  readonly fn: (t: number) => number;
  /** cubic-bezier()-строка — для WAAPI/CSS (element.animate easing, transition). */
  readonly css: string;
}

/** Строит EasingToken из четырёх координат Безье (единый источник fn и css). */
function bezierToken(x1: number, y1: number, x2: number, y2: number): EasingToken {
  return { fn: cubicBezier(x1, y1, x2, y2), css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})` };
}

/**
 * Семантические изинг-токены (не кричащие, без overshoot). Каждый — cubic-bezier
 * в духе Material/Fluent; координаты запинены тестами.
 *   standard   — оба конца сглажены, спокойный дефолт перемещений (Fluent easyEase).
 *   entrance   — «вход» с торможением (decelerate): быстрый старт, мягкая посадка.
 *   exit       — «выход» с разгоном (accelerate): мягкий старт, быстрый уход.
 *   emphasized — выразительный, но БЕЗ bounce: сильнее тормозит в конце (hero-момент).
 */
// Примечание: `easing` тянет ../easing.cubicBezier (eager). В ОТГРУЖЕННОМ dist
// (terser-минифицирован, PURE-аннотации вырезаны) семейства НЕ шейкаются по
// отдельности — импорт любого токена подтягивает cubicBezier (~0.9 KB). Реальная
// гарантия — СУБПУТЬ-изоляция (не импортишь ./tokens = ноль; весь субпуть ~1.1 KB).
export const easing = {
  /** Спокойный симметричный (Fluent easyEase). */
  standard: bezierToken(0.33, 0, 0.67, 1),
  /** Вход с торможением (decelerate): элемент влетает и мягко садится. */
  entrance: bezierToken(0, 0, 0.2, 1),
  /** Выход с разгоном (accelerate): элемент трогается мягко и быстро уходит. */
  exit: bezierToken(0.4, 0, 1, 1),
  /** Выразительный акцент, без overshoot (Material emphasized). */
  emphasized: bezierToken(0.2, 0, 0, 1),
} as const;

/** Имя изинг-токена. */
export type EasingTokenName = keyof typeof easing;

// ─── Пружины (SpringParams-пресеты для compositor/live-путей) ─────────────────
//
// Не кричащие дефолты: default/gentle/snappy — критично-/над-задемпфированные
// (нулевой или пренебрежимый overshoot). bounce — ЕДИНСТВЕННЫЙ underdamped, и он
// OPT-IN (по имени), не дефолт. Все проходят валидатор ядра (settle гарантирован),
// запинены тестом. Питают compileSpringPlan / CompositorSpring / compileStaggerPlan.

/** Именованные пружинные пресеты (физпараметры для ./compositor и ./value). */
export const spring = {
  /** Дефолт: ~критично-задемпфирован, без bounce (Framer-подобный). */
  default: { mass: 1, stiffness: 170, damping: 26 },
  /** Мягкий и медленный: спокойное оседание. */
  gentle: { mass: 1, stiffness: 120, damping: 30 },
  /** Быстрый и собранный: минимальный overshoot. */
  snappy: { mass: 1, stiffness: 260, damping: 28 },
  /** OPT-IN пружинистость (underdamped, эмитит overshoot). НЕ дефолт. */
  bounce: { mass: 1, stiffness: 180, damping: 12 },
} as const satisfies Record<string, SpringParams>;

/** Имя пружинного токена. */
export type SpringToken = keyof typeof spring;

// ─── Stagger-шаг (мс между соседними элементами каскада) ──────────────────────
//
// Спокойные шаги каскада для ./stagger и ./compositor stagger. Не кричащие:
// «loose» ≈ 70 мс не превращает список в затяжной парад.

/** Именованный базовый шаг задержки между элементами stagger-каскада (мс). */
export const staggerGap = {
  /** Плотный каскад (крупные списки), 20 мс. */
  tight: 20,
  /** Дефолтный каскад, 40 мс. */
  normal: 40,
  /** Разрежённый каскад (акцентные группы), 70 мс. */
  loose: 70,
} as const;

/** Имя токена stagger-шага. */
export type StaggerGapToken = keyof typeof staggerGap;

// ─── Дистанс-скейл (травел → длительность) ───────────────────────────────────
//
// Материал-подобная «динамическая длительность»: чем больше путь элемента, тем
// дольше движение — чтобы скорость ощущалась единообразной. Не кричаще: мягкая
// полоса fast(150)→slow(400) на 0→400 px, вне полосы — клэмп. Чистая, финитная.

/** Конфигурация полосы дистанс-скейла (границы травела и длительностей, мс/px). */
export interface DistanceScaleConfig {
  /** Травел (px) с минимальной длительностью. */
  readonly minDistance: number;
  /** Травел (px) с максимальной длительностью (>= minDistance). */
  readonly maxDistance: number;
  /** Длительность при травеле <= minDistance (мс). */
  readonly minDuration: number;
  /** Длительность при травеле >= maxDistance (мс). */
  readonly maxDuration: number;
}

/** Дефолтная полоса: 0→400 px маппится в fast(150)→slow(400) мс. */
export const distanceScaleConfig: DistanceScaleConfig = {
  minDistance: 0,
  maxDistance: 400,
  minDuration: duration.fast,
  maxDuration: duration.slow,
};

/**
 * Длительность (мс) для перемещения на `distancePx`: линейная интерполяция внутри
 * полосы config, клэмп вне полосы. Чистая и финитная: враждебный вход (NaN/∞/
 * отрицательный) сводится к |конечному| или границе; вырожденная полоса
 * (maxDistance <= minDistance) → minDuration.
 *
 * @example distanceScale(0)    // 150 (minDuration)
 * @example distanceScale(200)  // 275 (середина полосы)
 * @example distanceScale(999)  // 400 (клэмп к maxDuration)
 */
export function distanceScale(
  distancePx: number,
  config: DistanceScaleConfig = distanceScaleConfig,
): number {
  const d = Number.isFinite(distancePx) ? Math.abs(distancePx) : 0;
  const { minDistance, maxDistance, minDuration, maxDuration } = config;
  // Вырожденная/невалидная полоса → минимальная длительность (без деления на ~0).
  if (!(maxDistance > minDistance)) return minDuration;
  let t = (d - minDistance) / (maxDistance - minDistance);
  if (!(t > 0)) t = 0; // ловит NaN и отрицательное
  else if (t > 1) t = 1;
  const ms = minDuration + t * (maxDuration - minDuration);
  return Number.isFinite(ms) ? ms : minDuration;
}
