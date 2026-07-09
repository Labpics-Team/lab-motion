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
 * Fluent 2 (сдержанная шкала) и Material 3 (изинг-семейства standard/decelerate/
 * accelerate/emphasized). Дефолты — критично-задемпфированные пружины и мягкие
 * изинги: НИКАКОГО bounce-цирка по умолчанию. Overshoot живёт ровно в двух
 * OPT-IN токенах: изинг `emphasized` и пружины `expressive`/`bounce`.
 *
 * SSOT (шов с дизайн-системой): физический словарь — длительности, изинги и
 * ДС-пружины smooth/expressive — ЗЕРКАЛИРУЕТ схему motion-токенов labui
 * (labui/docs/motion-tokens.md, CSS-контракт `--lab-motion-*`). При пересечении
 * имён значения обязаны совпадать байт-в-байт; эталон при расхождении — labui.
 * Движковые экстры (пресеты default/gentle/snappy/bounce, staggerGap,
 * distanceScale) — честное надмножество: таких имён в ДС-схеме нет.
 * Значения запинены тестами (пины значений/имён) как контракт.
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
import { MotionParamError } from '../errors.js';
import { validateSpringParams, type SpringParams } from '../spring.js';

// ─── Длительности (мс) ───────────────────────────────────────────────────────
//
// Спокойная 5-ступенчатая шкала = SSOT labui (`--lab-motion-duration-*`),
// заземлённая на сходящихся индустриальных сетках: спайн 100/200/300/500 — там,
// где M3 (short2/short4/medium2/long2), Fluent 2 (durationFaster/durationNormal)
// и Carbon совпадают. Не кричащая: без суб-100мс «дёрганья» и без
// «кино»-затягиваний. instant=0 — нулевой якорь и цель reduced-motion.

/** Именованная шкала длительностей движения (мс). Tree-shakeable чистые данные. */
export const duration = {
  /** Мгновенно, 0 мс — снэп без анимации (reduced-motion край). */
  instant: 0,
  /** Микровзаимодействия (hover, нажатие, мелкая смена состояния), 100 мс. */
  fast: 100,
  /** Дефолтный UI-переход (появление, смена состояния), 200 мс. */
  base: 200,
  /** Крупнее и намереннее (панели, перемещения), 300 мс. */
  slow: 300,
  /** Полноэкранный / крупный переход поверхностей, 500 мс. */
  slower: 500,
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
 * Семантические изинг-токены = SSOT labui (`--lab-motion-easing-*`), заземлены
 * на официальных кривых Material 3. Три сдержанных дефолта БЕЗ overshoot +
 * ЕДИНСТВЕННАЯ кривая с overshoot (`emphasized`, y1=1.21 — зарезервирована ДС
 * под роль emphasis). Координаты запинены тестами.
 *   standard   — универсальный, оба конца сглажены (M3 easing-standard).
 *   decelerate — «вход»: быстрый старт, мягкая посадка (M3 standard-decelerate).
 *   accelerate — «выход»: мягкий старт, быстрый уход (M3 standard-accelerate).
 *   emphasized — единственный сдержанный overshoot (M3 Expressive web-fallback).
 */
// Примечание: `easing` тянет ../easing.cubicBezier (eager). В ОТГРУЖЕННОМ dist
// (terser-минифицирован, PURE-аннотации вырезаны) семейства НЕ шейкаются по
// отдельности — импорт любого токена подтягивает cubicBezier (~0.9 KB). Реальная
// гарантия — СУБПУТЬ-изоляция (не импортишь ./tokens = ноль; весь субпуть ~1.1 KB).
export const easing = {
  /** Универсальный дефолт: оба конца сглажены (M3 easing-standard). */
  standard: bezierToken(0.2, 0, 0, 1),
  /** Вход с торможением: элемент влетает и мягко садится (M3 decelerate). */
  decelerate: bezierToken(0, 0, 0, 1),
  /** Выход с разгоном: элемент трогается мягко и быстро уходит (M3 accelerate). */
  accelerate: bezierToken(0.3, 0, 1, 1),
  /** ЕДИНСТВЕННЫЙ сдержанный overshoot (y1=1.21) — под акцент/emphasis. */
  emphasized: bezierToken(0.38, 1.21, 0.22, 1),
} as const;

/** Имя изинг-токена. */
export type EasingTokenName = keyof typeof easing;

// ─── Каноническая пара (duration, bounce) → SpringParams ─────────────────────
//
// Человеко-понятная параметризация пружины (модель SwiftUI Spring(duration:bounce:)
// / Motion.dev; каноническая модель ДС-схемы labui): единственное представление,
// одновременно читаемое дизайнером и детерминированно конвертируемое на любую
// платформу. Вывод физической тройки — В ТОЧНОСТИ формулы SSOT
// (labui packages/tokens/src/motion/spring.ts), расходиться им нельзя:
//
//   dampingRatio ζ = 1 − bounce
//   mass m         = 1
//   ω₀             = 2π / durationS
//   stiffness k    = ω₀²·m
//   damping c      = 2·ζ·√(k·m) = 2·ζ·ω₀·m

/**
 * Конвертирует каноническую пару восприятия в физпараметры движка.
 *
 * `durationS` — перцептивная длительность в СЕКУНДАХ (ручка дизайнера; реальное
 * время оседания солвера может отличаться — пружина живёт по физике, не по
 * таймеру). `bounce` ∈ [0, 1): 0 = критическое демпфирование (без overshoot),
 * больше — упружее; bounce=1 (ζ=0, вечный звон) в live-движке непредставим —
 * отвергается. Результат прогоняется через валидатор ядра (settle-бюджет),
 * поэтому выход ГАРАНТИРОВАННО принимается всеми путями движка.
 *
 * @example springFromDurationBounce(0.35, 0)   // ДС smooth (effects)
 * @example springFromDurationBounce(0.5, 0.3)  // ДС expressive (spatial)
 * @throws MotionParamError при неконечных/внедиапазонных входах или неоседании.
 */
export function springFromDurationBounce(durationS: number, bounce: number): SpringParams {
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new MotionParamError(
      `springFromDurationBounce: durationS must be positive finite seconds, got ${durationS}`,
    );
  }
  if (!Number.isFinite(bounce) || bounce < 0 || bounce >= 1) {
    throw new MotionParamError(
      `springFromDurationBounce: bounce must be in [0, 1), got ${bounce}`,
    );
  }
  const dampingRatio = 1 - bounce;
  const omega0 = (2 * Math.PI) / durationS;
  const params: SpringParams = {
    mass: 1,
    stiffness: omega0 * omega0,
    damping: 2 * dampingRatio * omega0,
  };
  validateSpringParams(params); // settle-бюджет ядра — единый источник правды
  return params;
}

// ─── Пружины (SpringParams-пресеты для compositor/live-путей) ─────────────────
//
// Два семейства в одном словаре:
//   ДС SSOT (labui `--lab-motion-spring-*`): smooth (effects: opacity/цвет,
//     ζ=1, без overshoot) и expressive (spatial: единственный сдержанный
//     overshoot ~4.6%, под роль emphasis) — выведены из канонической пары
//     ЧЕРЕЗ springFromDurationBounce, значения не дублируются.
//   Движковые экстры: default/gentle/snappy — критично-/над-задемпфированные,
//     bounce — заметно underdamped, OPT-IN. В ДС-схеме их нет.
// Все проходят валидатор ядра (settle гарантирован), запинены тестом. Питают
// compileSpringPlan / CompositorSpring / compileStaggerPlan.

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
  // PURE-аннотации: вызовы с константами не бросают (запинено тестом), поэтому
  // честно помечены чистыми — иначе tsup-бандлы соседних субпутей (presets,
  // animate), которым `spring` не нужен, утащили бы конвертер+валидатор (+0.4 KB gz).
  /** ДС SSOT effects: opacity/цвет, прерываемая, без overshoot (0.35s, bounce 0). */
  smooth: /* @__PURE__ */ springFromDurationBounce(0.35, 0),
  /** ДС SSOT spatial: единственный сдержанный overshoot ~4.6% (0.5s, bounce 0.3). */
  expressive: /* @__PURE__ */ springFromDurationBounce(0.5, 0.3),
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
// полоса fast(100)→slow(300) на 0→400 px, вне полосы — клэмп. Чистая, финитная.

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

/** Дефолтная полоса: 0→400 px маппится в fast(100)→slow(300) мс. */
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
 * @example distanceScale(0)    // 100 (minDuration)
 * @example distanceScale(200)  // 200 (середина полосы)
 * @example distanceScale(999)  // 300 (клэмп к maxDuration)
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
