/**
 * easing/index.ts — L1 Домен: чистые функции плавности.
 *
 * Чистые функции (t: number) → number. Без DOM, часов, window, глобального состояния.
 * Инварианты:
 *   NE1. CSS-безопасность: выход всегда конечен (никогда NaN, Infinity, -Infinity)
 *        для ВСЕХ входов IEEE-754, включая t<0, t>1, NaN, ±Infinity, -0, субнормальные.
 *   NE2. Корректность концовок (непрерывные кривые): easing(0)===0 и easing(1)===1
 *        бит-в-бит, зеркаля дисциплину точных концовок tween.ts.
 *   NE4. Детерминизм и чистота: одинаковые входы → бит-идентичные выходы; ноль рантайм-
 *        зависимостей, без Math.random, Date.now, часов, DOM.
 *
 * Страж конечности зеркалит семантику spring.ts `clampFinite`:
 *   Number.isFinite(x) → x без изменений
 *   NaN → 0          (безопаснейший CSS-фоллбек: аналог покоя пружины)
 *   +Infinity → Number.MAX_VALUE
 *   -Infinity → -Number.MAX_VALUE
 *
 * Дисциплина концовок зеркалит tween.ts:
 *   t <= 0 → вернуть 0 (точно, без дрейфа)
 *   t >= 1 → вернуть 1 (точно, без дрейфа)
 *   внутренность: математическая формула
 *
 * Теги формы (NE3):
 *   MONOTONIC    — неубывающая на [0,1]; подтверждается dense-sample тестом
 *   OVERSHOOTING — может выходить за [0,1]; ограниченно-конечная, НЕ утверждается монотонной
 *   STEPPED      — разрывная; выход конечен, не непрерывен
 */

import { MotionParamError } from '../errors.js';
import { cubicBezierUnchecked } from '../internal/cubic-bezier.js';

// ---------------------------------------------------------------------------
// Внутренний страж — зеркалит spring.ts clampFinite точно
// ---------------------------------------------------------------------------

/**
 * Ограничивает значение до конечного диапазона.
 *
 * Зеркалит spring.ts `clampFinite` точно:
 *   - Конечное → пропускаем без изменений
 *   - NaN → 0 (позиция покоя пружины; безопасный CSS-дефолт)
 *   - +Infinity → Number.MAX_VALUE
 *   - -Infinity → -Number.MAX_VALUE
 *
 * Приватная — не экспортируется. Вызывается внутри normalizeEasing и всех тел кривых.
 */
function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

// ---------------------------------------------------------------------------
// Публичная: normalizeEasing — NE1 обёртка для пользовательских плавностей
// ---------------------------------------------------------------------------

/**
 * Оборачивает произвольную `(t: number) => number` плавность и ужесточает её выход
 * для удовлетворения NE1 (конечность): любое не-конечное возвращаемое значение
 * ограничивается по семантике `clampFinite` (NaN→0, ±Infinity→±MAX_VALUE).
 *
 * Корректные плавности (конечный выход для всех конечных входов) проходят
 * без изменений по значению — страж прозрачен для них.
 *
 * Использование:
 *   const safe = normalizeEasing(myCustomEasing);
 *   safe(t); // всегда конечно
 *
 * @param fn - любая (t: number) => number плавность; может возвращать не-конечные значения
 * @returns обёрнутая плавность, гарантирующая конечное число для всех t
 */
export function normalizeEasing(fn: (t: number) => number): (t: number) => number {
  return (t: number): number => clampFinite(fn(t));
}

// ---------------------------------------------------------------------------
// Страж концовок — используется всеми непрерывными монотонными кривыми
// Зеркалит дисциплину tween.ts: t<=0→0, t>=1→1, враждебные t обрабатываются первыми.
// ---------------------------------------------------------------------------

/**
 * Возвращает 0, если t до или на начальной концовке (включая NaN, -Infinity),
 * возвращает 1, если t на или за конечной концовкой (+Infinity),
 * возвращает undefined иначе (внутренность — вычисляет вызывающий).
 *
 * Приватная утилита: избегает дублирования паттерна t<=0/t>=1 в каждой кривой.
 * Покрывает NaN: NaN <= 0 ложно, NaN >= 1 ложно → проваливается в формулу.
 * NaN в формуле для большинства триг. ф-ций → NaN выход → clampFinite ловит его.
 * Так что кривые, вызывающие clampFinite на внутренних результатах, NE1-безопасны.
 */
function endpointOrUndefined(t: number): number | undefined {
  if (!Number.isFinite(t)) {
    // -Infinity → 0 (до начала); +Infinity → 1 (после конца); NaN → 0
    if (Number.isNaN(t)) return 0;
    return t > 0 ? 1 : 0;
  }
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return undefined; // внутренность: вычисляет вызывающий
}

// ---------------------------------------------------------------------------
// linear — NE3: MONOTONIC
// ---------------------------------------------------------------------------

/**
 * Линейная плавность: тождественная функция на [0,1].
 *
 * linear(t) = t для t ∈ (0, 1)
 *
 * Форма: MONOTONIC
 * Каноническая: тождество — внешняя ссылка не нужна (определение есть t).
 *
 * Инварианты:
 *   NE2: linear(0) === 0 и linear(1) === 1 бит-в-бит (короткое замыкание концовки)
 *   NE1: конечна для ВСЕХ входов IEEE-754 — обработано инлайн (не через clampFinite):
 *        NaN       → 0  (ограничено к началу; NaN ни ≤0 ни ≥1)
 *        -Infinity → 0  (до начала)
 *        +Infinity → 1  (после конца)
 *        t < 0     → 0  (clamp к началу)
 *        t > 1     → 1  (clamp к концу)
 *        внутренность: t (тождество, всегда конечно, т.к. t здесь конечно)
 *   NE4: чистая, детерминированная, без побочных эффектов
 */
export function linear(t: number): number {
  if (!Number.isFinite(t)) {
    if (Number.isNaN(t)) return 0;
    return t > 0 ? 1 : 0;
  }
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

// ---------------------------------------------------------------------------
// easeIn / easeOut / easeInOut — кубическая (power(3))
// Форма: MONOTONIC
// Каноническая: Robert Penner "Programming Macromedia Flash MX" (2002), гл. 7.
// То же, что power(3) In/Out/InOut, но именована для эргономичного дефолтного использования.
// ---------------------------------------------------------------------------

/**
 * Ease-in кубическая: медленный старт, быстрый конец.
 * easeIn(t) = t³
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInCubic — t³
 */
export function easeIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return t * t * t;
}

/**
 * Ease-out кубическая: быстрый старт, медленный конец.
 * easeOut(t) = 1 − (1−t)³
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeOutCubic
 */
export function easeOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Ease-in-out кубическая: медленный старт, быстрая середина, медленный конец.
 * easeInOut(t) = t < 0.5 ? 4t³ : 1 − (−2t+2)³/2
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInOutCubic
 */
export function easeInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return 4 * t * t * t;
  }
  const u = -2 * t + 2;
  return 1 - (u * u * u) / 2;
}

// ---------------------------------------------------------------------------
// sineIn / sineOut / sineInOut
// Форма: MONOTONIC
// Каноническая: Penner (2002) easeInSine / easeOutSine / easeInOutSine
// ---------------------------------------------------------------------------

/**
 * Синусоидальная ease-in: плавное ускорение от нуля.
 * sineIn(t) = 1 − cos(t * π/2)
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInSine
 */
export function sineIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(1 - Math.cos((t * Math.PI) / 2));
}

/**
 * Синусоидальная ease-out: плавное замедление к нулю.
 * sineOut(t) = sin(t * π/2)
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeOutSine
 */
export function sineOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(Math.sin((t * Math.PI) / 2));
}

/**
 * Синусоидальная ease-in-out: плавная S-кривая.
 * sineInOut(t) = −(cos(π*t) − 1) / 2
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInOutSine
 */
export function sineInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(-(Math.cos(Math.PI * t) - 1) / 2);
}

// ---------------------------------------------------------------------------
// expoIn / expoOut / expoInOut — экспоненциальная
// Форма: MONOTONIC
// Каноническая: Penner (2002) easeInExpo / easeOutExpo / easeInOutExpo
// ---------------------------------------------------------------------------

/**
 * Экспоненциальная ease-in: очень медленный старт, чрезвычайно быстрый конец.
 * expoIn(t) = 2^(10t − 10)
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInExpo
 */
export function expoIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(Math.pow(2, 10 * t - 10));
}

/**
 * Экспоненциальная ease-out: чрезвычайно быстрый старт, очень медленный конец.
 * expoOut(t) = 1 − 2^(−10t)
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeOutExpo
 */
export function expoOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(1 - Math.pow(2, -10 * t));
}

/**
 * Экспоненциальная ease-in-out.
 * expoInOut(t) = t < 0.5 ? 2^(20t−10)/2 : (2−2^(−20t+10))/2
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInOutExpo
 */
export function expoInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite(Math.pow(2, 20 * t - 10) / 2);
  }
  return clampFinite((2 - Math.pow(2, -20 * t + 10)) / 2);
}

// ---------------------------------------------------------------------------
// circIn / circOut / circInOut — круговая дуга
// Форма: MONOTONIC
// Каноническая: Penner (2002) easeInCirc / easeOutCirc / easeInOutCirc
// ---------------------------------------------------------------------------

/**
 * Круговая ease-in: четверть окружности, медленный старт.
 * circIn(t) = 1 − √(1 − t²)
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInCirc
 */
export function circIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(1 - Math.sqrt(1 - t * t));
}

/**
 * Круговая ease-out: четверть окружности, медленный конец.
 * circOut(t) = √(1 − (t−1)²)
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeOutCirc
 */
export function circOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  const u = t - 1;
  return clampFinite(Math.sqrt(1 - u * u));
}

/**
 * Круговая ease-in-out: S-кривая с круговыми дугами на обоих концах.
 * circInOut(t) = t < 0.5 ? (1−√(1−(2t)²))/2 : (√(1−(−2t+2)²)+1)/2
 *
 * Форма: MONOTONIC
 * Каноническая: Penner (2002) easeInOutCirc
 */
export function circInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite((1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2);
  }
  return clampFinite((Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2);
}

// ---------------------------------------------------------------------------
// backIn / backOut / backInOut — перелёт (предвосхищение затем перелёт)
// Форма: OVERSHOOTING — может уходить ниже 0 (backIn) или выше 1 (backOut/backInOut)
// Исключение концовок: backIn(1)===1 точно; backOut(0)===0 точно; но
// эти кривые делают перелёт на своих соответствующих сторонах.
// Каноническая: Penner (2002) easeInBack / easeOutBack / easeInOutBack
// ---------------------------------------------------------------------------

// Константа Penner back: c1 = 1.70158; c3 = c1 + 1
const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;
const BACK_C2 = BACK_C1 * 1.525;

/**
 * Back ease-in: предвосхищающий откат перед основным движением.
 * backIn(t) = c3·t³ − c1·t²
 *
 * Форма: OVERSHOOTING (кратковременно уходит ниже 0 near start)
 * Каноническая: Penner (2002) easeInBack, c1=1.70158
 *
 * Исключение концовок (NE2): backIn(0)===0 точно; backIn(1)===1 точно.
 * Перелёт происходит во внутренности (backIn уходит в минус для малых t).
 */
export function backIn(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  return clampFinite(BACK_C3 * t * t * t - BACK_C1 * t * t);
}

/**
 * Back ease-out: перелёт за цель перед установкой.
 * backOut(t) = 1 + c3·(t−1)³ + c1·(t−1)²
 *
 * Форма: OVERSHOOTING (кратковременно превышает 1 near end)
 * Каноническая: Penner (2002) easeOutBack, c1=1.70158
 *
 * Исключение концовок (NE2): backOut(0)===0 точно; backOut(1)===1 точно.
 * Перелёт происходит во внутренности (backOut превышает 1 для t near 1).
 */
export function backOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  const u = t - 1;
  return clampFinite(1 + BACK_C3 * u * u * u + BACK_C1 * u * u);
}

/**
 * Back ease-in-out: откат на старте + перелёт на конце.
 * t < 0.5: использует масштабированную константу c2 для более плотного эффекта
 * t >= 0.5: зеркальная версия
 *
 * Форма: OVERSHOOTING (уходит ниже 0 на старте, превышает 1 на конце)
 * Каноническая: Penner (2002) easeInOutBack, c2=c1*1.525
 *
 * Исключение концовок: backInOut(0)===0 точно; backInOut(1)===1 точно.
 */
export function backInOut(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite((Math.pow(2 * t, 2) * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2);
  }
  return clampFinite(
    (Math.pow(2 * t - 2, 2) * ((BACK_C2 + 1) * (2 * t - 2) + BACK_C2) + 2) / 2,
  );
}

// ---------------------------------------------------------------------------
// anticipate — пружинный откат: тянет назад затем запускает вперёд
// Форма: OVERSHOOTING (уходит в минус на старте)
// Каноническая: Motion One / Framer Motion `anticipate` (конвенция сообщества GSAP)
// Формула: t < 0.5 → масштабированный backIn; t >= 0.5 → масштабированный easeOut
// ---------------------------------------------------------------------------

/**
 * Anticipate: тянет назад перед запуском — одиночный откат только на старте.
 * Это плавность "anticipate" из Framer Motion / Motion One.
 * Для t ∈ [0, 0.5]: масштабированный backIn (фаза отката)
 * Для t ∈ [0.5, 1]: масштабированный easeOut (фаза запуска)
 *
 * Форма: OVERSHOOTING (уходит в минус в фазе отката)
 * Каноническая: Framer Motion / Motion One `anticipate`; производная от Penner.
 *
 * Исключение концовок: anticipate(0)===0 точно; anticipate(1)===1 точно.
 */
export function anticipate(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  // Масштабируем t к [0,1] для каждой половины, затем смешиваем.
  // Половина отката (t<0.5): масштабированный backIn (использует back-константы).
  // Половина запуска (t>=0.5): масштабированный easeOut кубический (без back-перелёта).
  if (t < 0.5) {
    const t2 = 2 * t;
    return clampFinite((BACK_C3 * t2 * t2 * t2 - BACK_C1 * t2 * t2) / 2);
  }
  // easeOut (кубический) во второй половине — отображает [0.5,1] → [0,1] выход.
  // Каноническая: 0.5*easeOut(2t-1)+0.5 с easeOut(x)=1-(1-x)^3.
  const x = 2 * t - 1;
  const inv = 1 - x;
  return clampFinite(0.5 * (1 - inv * inv * inv) + 0.5);
}

// ---------------------------------------------------------------------------
// elastic — пружинные колебания с перелётом
// Форма: OVERSHOOTING
// Каноническая: Penner (2002) easeInElastic / easeOutElastic; также Motion One.
// c4 = (2π)/3 константа периода для затухающего синуса
// ---------------------------------------------------------------------------

const ELASTIC_C4 = (2 * Math.PI) / 3;
const ELASTIC_C5 = (2 * Math.PI) / 4.5;

/**
 * Elastic плавность: пружинные колебания с перелётом и отскоком назад.
 * Моделирует плавность "elastic" как в Motion One и Framer Motion.
 *
 * Для t < 0.5: стиль elasticIn (инвертированные колебания на старте)
 * Для t >= 0.5: стиль elasticOut (колебания затухают на конце)
 *
 * elastic(t) для t ∈ (0,0.5):  −2^(20t−10)·sin((20t−11.125)·c5) / 2
 * elastic(t) для t ∈ [0.5,1):   2^(−20t+10)·sin((20t−11.125)·c5) / 2 + 1
 *
 * Форма: OVERSHOOTING (может уходить ниже 0 или превышать 1)
 * Каноническая: easings.net / Motion One `easeInOutElastic`, производная от Penner.
 *
 * Исключение концовок: elastic(0)===0 точно; elastic(1)===1 точно.
 */
export function elastic(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite(-(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2);
  }
  return clampFinite(
    (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2 + 1,
  );
}

// ---------------------------------------------------------------------------
// bounce — симуляция прыгающего мяча
// Форма: OVERSHOOTING (значения остаются ≥ 0 для bounceOut, ≤ 0 ниже для bounceIn)
// На самом деле выход bounce остаётся в [0,1] — он "ограничен", но НЕ монотонен.
// Каноническая: Penner (2002) easeOutBounce (bounce = гибрид bounceInOut).
// ---------------------------------------------------------------------------

// Константы Penner bounce
const BOUNCE_N1 = 7.5625;
const BOUNCE_D1 = 2.75;

/**
 * Ядро формулы bounce-out (Penner): выход всегда в [0,1].
 * bounceOut(t) = кусочно-полиномиальная, совпадающая с затуханием прыгающего мяча.
 *
 * Каноническая: Penner (2002) easeOutBounce.
 * NE1: выход всегда в [0,1] для t ∈ [0,1]; концовки: 0→0, 1→1 точно.
 */
function bounceOut(t: number): number {
  if (t < 1 / BOUNCE_D1) {
    return BOUNCE_N1 * t * t;
  }
  if (t < 2 / BOUNCE_D1) {
    const u = t - 1.5 / BOUNCE_D1;
    return BOUNCE_N1 * u * u + 0.75;
  }
  if (t < 2.5 / BOUNCE_D1) {
    const u = t - 2.25 / BOUNCE_D1;
    return BOUNCE_N1 * u * u + 0.9375;
  }
  const u = t - 2.625 / BOUNCE_D1;
  return BOUNCE_N1 * u * u + 0.984375;
}

/**
 * Bounce плавность: bounceInOut — оттяжка затем прыгающая посадка.
 * Для t < 0.5: bounceIn (инвертированный bounceOut) в первой половине
 * Для t >= 0.5: bounceOut во второй половине
 *
 * Форма: OVERSHOOTING-подобная (значения остаются в [0,1], но не монотонны)
 * Каноническая: Penner (2002) easeInOutBounce.
 *
 * Исключение концовок: bounce(0)===0 точно; bounce(1)===1 точно.
 * bounce не монотонна — значения колеблются — но ограничена [0,1].
 */
export function bounce(t: number): number {
  const ep = endpointOrUndefined(t);
  if (ep !== undefined) return ep;
  if (t < 0.5) {
    return clampFinite((1 - bounceOut(1 - 2 * t)) / 2);
  }
  return clampFinite((1 + bounceOut(2 * t - 1)) / 2);
}

// ---------------------------------------------------------------------------
// power(exponent) фабрика — параметрический полиномиальный easeIn
// Форма: MONOTONIC для exponent > 0; OVERSHOOTING для exponent < 0
// Каноническая: Penner (2002) easeInCubic = power(3), quad = power(2), и т.д.
// quad = power(2), cubic = power(3), quart = power(4), quint = power(5)
// ---------------------------------------------------------------------------

/**
 * Фабрика: возвращает power-easeIn кривую t^p для заданного показателя степени.
 *
 * power(p)(t) = t^p для t ∈ (0,1)
 *
 * Форма: MONOTONIC для p > 0 (неубывающая); кривая In-стиля.
 * Для p=1: linear; p=2: quad; p=3: cubic; p=4: quart; p=5: quint.
 * Для нецелых показателей: гладкое обобщение полиномиальной плавности.
 *
 * NE7: отвергает не-конечные показатели через MotionParamError — НИКОГДА не возвращает NaN.
 * NE1: выход всегда конечен (clampFinite для граничных значений t).
 * NE2: power(p)(0)===0 и power(p)(1)===1 бит-в-бит (короткое замыкание концовки).
 *
 * Каноническая: Penner (2002), обобщённая; Motion One `easeIn` фабрика.
 *
 * @param exponent - степень; должно быть конечным числом
 * @returns функция плавности t^exponent, NE1-безопасная для всех t
 * @throws MotionParamError если показатель не конечен
 */
export function power(exponent: number): (t: number) => number {
  if (!Number.isFinite(exponent)) {
    throw new MotionParamError('LM028');
  }
  return (t: number): number => {
    const ep = endpointOrUndefined(t);
    if (ep !== undefined) return ep;
    return clampFinite(Math.pow(t, exponent));
  };
}

// ---------------------------------------------------------------------------
// cubicBezier(x1, y1, x2, y2) фабрика — CSS cubic-bezier кривая
// Форма: зависит от контрольных точек; аппроксимирует CSS timing function
// Каноническая: CSS Transitions Level 1 §2.2 / W3C; реализована через
//   Newton-Raphson с бисекционным фоллбеком (тот же подход, что у Chrome
//   CubicBezierTimingFunction и Framer Motion bezier solver).
// ---------------------------------------------------------------------------

/**
 * Фабрика: возвращает cubic-bezier плавность, соответствующую CSS кривой cubic-bezier(x1,y1,x2,y2).
 *
 * Реализует тот же Newton-Raphson + бисекционный bezier solver, что используется
 * Chrome CubicBezierTimingFunction и Framer Motion bezier утилитой.
 *
 * NE7: отвергает не-конечные контрольные точки через MotionParamError.
 * NE1: выход всегда конечен (clampFinite; NaN→0, ±Inf→ограничено).
 * NE2: cubicBezier(x1,y1,x2,y2)(0)===0 и (1)===1 точно.
 * NE4: детерминирована — одинаковый вход → одинаковый выход бит-в-бит.
 *
 * Каноническая: W3C CSS Transitions Level 1 §2.2; Chrome blink/CubicBezierTimingFunction.
 *
 * @param x1 - контрольная точка 1 x [0,1]
 * @param y1 - контрольная точка 1 y (не ограничена)
 * @param x2 - контрольная точка 2 x [0,1]
 * @param y2 - контрольная точка 2 y (не ограничена)
 * @returns функция плавности, NE1-безопасная для всех t
 * @throws MotionParamError если любая контрольная точка не конечна
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    throw new MotionParamError('LM029');
  }
  // x1 и x2 должны быть в [0,1] — Bezier x-компонента монотонна
  // (и следовательно обратима solver'ом) только когда обе x контрольные точки в [0,1].
  // CSS cubic-bezier() отвергает x вне диапазона по той же причине.
  // y1/y2 не ограничены (разрешают перелёт).
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new MotionParamError('LM030');
  }

  // Быстрый путь для линейной (x1===y1 && x2===y2 === контрольные точки лежат на диагонали)
  if (x1 === y1 && x2 === y2) {
    return linear;
  }

  return cubicBezierUnchecked(x1, y1, x2, y2);
}

// ---------------------------------------------------------------------------
// steps(n, position) фабрика — ступенчатая/дискретная плавность
// Форма: STEPPED (разрывная)
// Каноническая: CSS Transitions Level 1 §2.3 / W3C; MDN step-timing-function.
// ---------------------------------------------------------------------------

/**
 * Позиции шагов для steps() плавности — зеркалит CSS step-timing-function.
 * "start" = jump-start: первый скачок срабатывает при первом внутреннем t > 0
 *            (концовка t=0 ограничена к 0 NE2 стражем враждебных t;
 *            CSS jump-start срабатывает при t=0, но наш страж срабатывает первым)
 * "end"   = jump-end: последний скачок при t=1 (дефолтное поведение CSS)
 */
export type StepPosition = 'start' | 'end';

/**
 * Фабрика: возвращает ступенчатую плавность, делящую прогресс на n дискретных шагов.
 *
 * steps(n, 'end')(t): floor(t*n)/n — шаги в конце каждого интервала (дефолт CSS)
 * steps(n, 'start')(t): ceil(t*n)/n — шаги в начале каждого интервала
 *
 * NE7: отвергает n <= 0 (или не-конечное n) через MotionParamError.
 * NE1: выход всегда конечен для всех t (целочисленная математика, ограничен).
 * NE2: поведение концовок документировано ниже (steps разрывна).
 * NE4: детерминирована — одинаковые (n, position, t) → одинаковый выход бит-в-бит.
 *
 * Поведение концовок (NE2 — короткое замыкание концовок применяется ко всем позициям):
 *   'end':   steps(n,'end')(0)=0 точно (t<=0 короткое замыкание); steps(n,'end')(1)=1 точно
 *   'start': steps(n,'start')(0)=0 точно (t<=0 короткое замыкание, НЕ 1/n);
 *            steps(n,'start')(1)=1 точно
 *   Обе позиции: t<=0→0 и t>=1→1 по стражу враждебных t, независимо от
 *   семантики CSS jump-start. Первый видимый шаг для 'start' происходит при
 *   первом внутреннем t > 0.
 *
 * Каноническая: W3C CSS Transitions Level 1 §2.3 step-timing-function.
 *
 * @param n - число шагов; должно быть положительным целым (n >= 1)
 * @param position - где происходят шаги: 'start' или 'end' (дефолт 'end')
 * @returns ступенчатая функция плавности, NE1-безопасная для всех t
 * @throws MotionParamError если n не положительное конечное целое или позиция невалидна
 */
export function steps(n: number, position: StepPosition = 'end'): (t: number) => number {
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    throw new MotionParamError('LM031');
  }
  if (position !== 'start' && position !== 'end') {
    throw new MotionParamError('LM032');
  }

  return (t: number): number => {
    // Враждебный t → концовка
    if (!Number.isFinite(t)) {
      if (Number.isNaN(t)) return 0;
      return t > 0 ? 1 : 0;
    }
    if (t <= 0) return 0;
    if (t >= 1) return 1;

    if (position === 'start') {
      // jump-start: шаг происходит в начале каждого интервала
      // ceil(t * n) / n, ограничен к [0,1]
      return clampFinite(Math.min(1, Math.ceil(t * n) / n));
    }
    // jump-end (дефолт): шаг происходит в конце каждого интервала
    // floor(t * n) / n
    return clampFinite(Math.floor(t * n) / n);
  };
}