/**
 * spring/index.ts — эргономика пружин (subpath ./spring).
 *
 * Закрывает хвост S3 суперсета (HIGH-гэп из gap-matrix): интуитивные
 * параметризации пружин поверх физического ядра {mass, stiffness, damping}.
 *
 * - fromBounce({duration, bounce}) — канон SwiftUI Spring(duration:bounce:):
 *     ζ = 1 − bounce, ω0 = 2π/duration → k = m·ω0², c = 2m·ζ·ω0.
 *   bounce ∈ [−1, 1] — точный диапазон SwiftUI (0 = критическое, >0 = упругая,
 *   <0 = пере-демпфированная «плоская»); Motion принимает подмножество [0, 1],
 *   поэтому любой Motion-вход валиден и здесь.
 * - fromVisualDuration — время ПЕРВОГО визуального касания цели (Motion):
 *   для ζ<1 решается точно из первого пересечения x(t)=1:
 *     ωd·t* = π − atan(ωd/(ζω0)) → ω0 = (π − atan(√(1−ζ²)/ζ)) / (√(1−ζ²)·Tv)
 *   (ζ=0: atan(∞)=π/2 → ω0 = π/(2Tv) — точное касание незатухающей x=1−cos);
 *   для ζ≥1 пересечения нет — Tv трактуется как выход на ~99% цели
 *   (медленнейшая мода: ω0·slow·Tv ≈ ln(100)).
 * - springPresets — канонические пресеты react-spring (tension/friction
 *   при mass=1): default/gentle/wobbly/stiff/slow/molasses.
 * - springAsEasing(params) — пружина как easing-функция t∈[0,1]→value
 *   (совместима с keyframes/tween): шкала времени = время оседания
 *   параметров; эндпоинты точны (дисциплина NE2), форма OVERSHOOTING
 *   при ζ<1.
 *
 * ТОЧНОСТЬ конструкторов (#218): fromBounce/fromVisualDuration возвращают
 * ТОЧНОЕ математическое преобразование запрошенных координат — без скрытой
 * коэрсии под бюджет какого-либо исполнителя (прежняя воронка ускоряла ω₀
 * или поднимала ζ, меняя запрошенную физику). bounce=1 честно означает
 * ζ=0 ⇒ damping=0. Представимость у конкретного исполнителя — ЕГО граница:
 * автономный frame-loop (drive/MotionValue/фасад) применит validateSpringParams
 * на своей стороне; чистый spring() и compositor-план живут по своим законам.
 *
 * Инварианты: zero-DOM, zero-deps, детерминизм, MotionParamError рано.
 */

import { springUnchecked, validateSpringPhysics, type SpringParams } from '../spring.js';
import { CONVERGENCE_THRESHOLD } from '../internal/constants.js';
import { MotionParamError } from '../errors.js';

/** ln(100): множитель времени затухания огибающей до 1% (шкала Tv при ζ≥1). */
const LN_100 = Math.log(100);

// ─── fromBounce ──────────────────────────────────────────────────────────────

/** Опции duration+bounce параметризации. */
export interface FromBounceOptions {
  /** Перцептивная длительность (секунды), > 0. */
  readonly duration: number;
  /** Упругость ∈ [−1, 1]: 0 — критическое демпфирование. */
  readonly bounce: number;
  /** Масса. По умолчанию 1. */
  readonly mass?: number | undefined;
}

function checkBounce(bounce: number, name: string): void {
  if (!Number.isFinite(bounce) || bounce < -1 || bounce > 1) {
    throw new MotionParamError('LM092');
  }
}

function checkPositive(v: number, name: string, field: string): void {
  if (!Number.isFinite(v) || v <= 0) {
    throw new MotionParamError('LM093');
  }
}

/**
 * Точное построение (#218): k = m·ω₀², c = 2m·ζ·ω₀ — и ничего больше.
 * Выход проверяется физической границей: экстремальные duration, у которых
 * точное преобразование не представимо конечным положительным double
 * (underflow/overflow k или c), — честная ошибка входа, не тихая подмена.
 */
function toParams(omega0: number, zeta: number, mass: number): SpringParams {
  const params = {
    mass,
    stiffness: mass * omega0 * omega0,
    damping: 2 * mass * zeta * omega0,
  };
  validateSpringPhysics(params);
  return params;
}

/** Пружина из перцептивной длительности и упругости (канон SwiftUI/Motion). */
export function fromBounce(options: FromBounceOptions): SpringParams {
  checkPositive(options.duration, 'fromBounce', 'duration');
  checkBounce(options.bounce, 'fromBounce');
  const mass = massOrOne(options.mass);
  const omega0 = (2 * Math.PI) / options.duration;
  const zeta = 1 - options.bounce;
  return toParams(omega0, zeta, mass);
}

// ─── fromVisualDuration ──────────────────────────────────────────────────────

/** Опции visualDuration-параметризации. */
export interface FromVisualDurationOptions {
  /** Время первого визуального касания цели (секунды), > 0. */
  readonly visualDuration: number;
  /** Упругость ∈ [−1, 1]. */
  readonly bounce: number;
  /** Масса. По умолчанию 1. */
  readonly mass?: number | undefined;
}

/**
 * Пружина, ПЕРВОЕ касание цели у которой ≈ visualDuration (класс Motion).
 *
 * Точное преобразование (#218): именованный контракт API — Tv, упругость —
 * характер; НИ ОДНА из запрошенных координат не подменяется под бюджет
 * какого-либо исполнителя. Инвариант «первое касание совпадает с
 * аналитическим решением для ВОЗВРАЩЁННЫХ параметров» держится всегда;
 * представимость у автономного frame-loop проверяет сам исполнитель.
 */
export function fromVisualDuration(options: FromVisualDurationOptions): SpringParams {
  checkPositive(options.visualDuration, 'fromVisualDuration', 'visualDuration');
  checkBounce(options.bounce, 'fromVisualDuration');
  const mass = massOrOne(options.mass);
  const Tv = options.visualDuration;
  const zeta = 1 - options.bounce;

  if (zeta < 1) {
    // Точное решение первого пересечения x(t)=1 (вывод в шапке). ζ=0 включён:
    // atan(s/0)=atan(∞)=π/2 ⇒ ω₀=π/(2Tv) — точное касание x=1−cos(ω₀t).
    const s = Math.sqrt(1 - zeta * zeta);
    return toParams((Math.PI - Math.atan(s / zeta)) / (s * Tv), zeta, mass);
  }
  // Пересечения нет: Tv = выход на ~99% цели по медленнейшей моде.
  // Для ζ=1 огибающая ~e^{−ω0 t}; для ζ>1 медленнейший корень
  // r = ω0/(ζ + √(ζ²−1)) — стабильное тождество ω0(ζ − √(ζ²−1)) (#226).
  const slow = 1 / (zeta + Math.sqrt(Math.max(0, zeta * zeta - 1)));
  return toParams(LN_100 / (Tv * slow), zeta, mass);
}

// ─── Observable-конструкторы (#230): точные координатные преобразования ──────

/** Опции first-overshoot параметризации. */
export interface FromPeakOptions {
  /** Доля первого перелёта относительно амплитуды ∈ (0, 1]. */
  readonly overshoot: number;
  /** Время первого пика (секунды), > 0. */
  readonly peakTime: number;
  /** Масса. По умолчанию 1. */
  readonly mass?: number | undefined;
}

/** Дефолт массы конструкторов: невалидная масса → 1 (канон fromBounce). */
function massOrOne(mass: number | undefined): number {
  return typeof mass === 'number' && Number.isFinite(mass) && mass > 0 ? mass : 1;
}

/**
 * Пружина из НАБЛЮДАЕМОГО первого перелёта и времени пика (#230). Точное
 * обратное преобразование underdamped-системы из покоя, не пресет:
 *   L = −ln(M), ζ = L/√(π²+L²), ω₀ = √(π²+L²)/tp,
 *   k = m(π²+L²)/tp² (без sqrt), c = 2mL/tp — один log, ноль итераций.
 * overshoot=1 честно означает ζ=0 (незатухающая, пик ровно 2−from);
 * overshoot=0 НЕ имеет underdamped-прообраза (критический предел) и
 * отклоняется LM171 без epsilon-подмены — «без перелёта» описывается
 * fromBounce({bounce: 0}) или fromVisualDuration.
 */
export function fromPeak(options: FromPeakOptions): SpringParams {
  const M = options.overshoot;
  if (!Number.isFinite(M) || M <= 0 || M > 1) {
    throw new MotionParamError('LM171');
  }
  checkPositive(options.peakTime, 'fromPeak', 'peakTime');
  const mass = massOrOne(options.mass);
  const tp = options.peakTime;
  // `+ 0` схлопывает IEEE −0 у overshoot=1 (−ln(1) = −0): damping выходит +0.
  const L = -Math.log(M) + 0;
  const s = Math.PI * Math.PI + L * L; // = (ω₀·tp)²
  const params = {
    mass,
    stiffness: mass * s / (tp * tp),
    damping: 2 * mass * L / tp,
  };
  validateSpringPhysics(params);
  return params;
}

/** Опции period+half-life параметризации. */
export interface FromOscillationOptions {
  /** Период затухающих колебаний (секунды), > 0. */
  readonly period: number;
  /** Полупериод огибающей: амплитуда падает вдвое (секунды), > 0. */
  readonly halfLife: number;
  /** Масса. По умолчанию 1. */
  readonly mass?: number | undefined;
}

/**
 * Пружина из НАБЛЮДАЕМОГО периода колебаний и half-life огибающей (#230).
 * Комплексные полюса p = −α ± iβ при α = ln2/halfLife, β = 2π/period:
 *   k = m(α²+β²), c = 2mα — всегда underdamped (β > 0 ⇒ ζ < 1), точно.
 * «period=∞» не является скрытой критической ветвью — конечность обязательна.
 */
export function fromOscillation(options: FromOscillationOptions): SpringParams {
  checkPositive(options.period, 'fromOscillation', 'period');
  checkPositive(options.halfLife, 'fromOscillation', 'halfLife');
  const mass = massOrOne(options.mass);
  const alpha = Math.LN2 / options.halfLife;
  const beta = (2 * Math.PI) / options.period;
  const params = {
    mass,
    stiffness: mass * (alpha * alpha + beta * beta),
    damping: 2 * mass * alpha,
  };
  validateSpringPhysics(params);
  return params;
}

// ─── Пресеты (канон react-spring: tension/friction при mass=1) ───────────────

/** Канонические пресеты react-spring. Заморожены (пин контракта). */
export const springPresets: Readonly<Record<
  'default' | 'gentle' | 'wobbly' | 'stiff' | 'slow' | 'molasses',
  SpringParams
>> = Object.freeze({
  default: Object.freeze({ mass: 1, stiffness: 170, damping: 26 }),
  gentle: Object.freeze({ mass: 1, stiffness: 120, damping: 14 }),
  wobbly: Object.freeze({ mass: 1, stiffness: 180, damping: 12 }),
  stiff: Object.freeze({ mass: 1, stiffness: 210, damping: 20 }),
  slow: Object.freeze({ mass: 1, stiffness: 280, damping: 60 }),
  molasses: Object.freeze({ mass: 1, stiffness: 280, damping: 120 }),
});

// ─── springAsEasing ──────────────────────────────────────────────────────────

/**
 * Конечный нормализованный горизонт U = ω₀·T (#219): наименьшее U замкнутой
 * ОГИБАЮЩЕЙ, при котором |1−x(U)| + (4/27)·|U·x′(U)| ≤ tolerance — тогда
 * C¹ Hermite-коррекция хвоста ограничена tolerance по построению
 * (max|3t²−2t³| = 1, max|t³−t²| = 4/27). Безразмерно: зависит только от ζ,
 * поэтому scale-equivalent (m,k,c) получают одну кривую. Детерминированная
 * брекет-бисекция по монотонно затухающей огибающей — без wall-clock.
 */
function normalizedSpringHorizon(zeta: number, tolerance: number): number {
  let envelope: (u: number) => number;
  if (zeta < 1) {
    // |x−1| ≤ e^(−ζu)/ω̂d;  |dx/du| = e^(−ζu)·sin(ω̂d·u)/ω̂d ≤ e^(−ζu)/ω̂d.
    const omegaDHat = Math.sqrt(1 - zeta * zeta);
    envelope = (u) => (Math.exp(-zeta * u) / omegaDHat) * (1 + (4 / 27) * u);
  } else if (zeta === 1) {
    // Точные формы: |x−1| = (1+u)e^(−u), dx/du = u·e^(−u).
    envelope = (u) => Math.exp(-u) * (1 + u + (4 / 27) * u * u);
  } else {
    // Модальные амплитуды в стабильной pole-форме (#226): r̂s = −1/(ζ+d).
    const d = Math.sqrt(zeta * zeta - 1);
    const slowHat = 1 / (zeta + d);
    const ampX = (zeta + d + slowHat) / (2 * d);
    const ampV = 1 / d;
    envelope = (u) => Math.exp(-slowHat * u) * (ampX + (4 / 27) * u * ampV);
  }
  // Брекет: огибающая экспоненциально затухает ⇒ удвоение конечно; бисекция
  // держит инвариант envelope(hi) ≤ tolerance и возвращает hi.
  let hi = 1;
  let guard = 0;
  while (envelope(hi) > tolerance && guard++ < 64) hi *= 2;
  let lo = hi / 2;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (envelope(mid) <= tolerance) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Пружина как easing-функция t∈[0,1] → value (форма OVERSHOOTING при ζ<1).
 * Шкала: t=1 — выведенный конечный горизонт параметров (normalizedSpringHorizon
 * с settle-допуском пакета CONVERGENCE_THRESHOLD). Хвост запечатан C¹
 * Hermite-коррекцией (#219): g = f + (1−f₁)(3t²−2t³) − s₁(t³−t²), поэтому
 * g(0)=0, g′(0)=0, g(1)=1, g′(1)=0 — БЕЗ endpoint-прыжка старой шкалы
 * (критическая пружина прыгала на ≈5.6% с наклоном ≈0.21), а |g−f| ≤
 * |1−f₁| + (4/27)|s₁| ≤ допуска. Эндпоинты точны; вход клампится, NaN→0
 * (дисциплина NE2/NE1). Валидация и горизонт — один раз в конструкторе;
 * сэмпл — один springUnchecked без повторной валидации и аллокаций (#219).
 */
export function springAsEasing(params: SpringParams): (t: number) => number {
  // Физическая граница — рано и один раз; бюджет frame-loop здесь не
  // применяется: easing живёт в НОРМАЛИЗОВАННОМ времени, медленная пружина
  // легальна (#218).
  validateSpringPhysics(params);
  // Канонические частные (#226): точная масштабная инвариантность ζ и ω₀.
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const zeta = params.damping / params.mass / 2 / omega0;
  // Конечная проекция на [0,1] существует только у затухающей системы:
  // ζ=0 не имеет конечного горизонта — граница ЭТОГО исполнителя (#218).
  if (!(zeta > 0)) throw new MotionParamError('LM167');
  const T = normalizedSpringHorizon(zeta, CONVERGENCE_THRESHOLD) / omega0;
  const sample = springUnchecked(params, T);
  const f1 = sample.value;
  const s1 = T * sample.velocity;
  // Horner-коэффициенты коррекции: g = f + t²·(c2 + t·c3).
  const c2 = 3 * (1 - f1) + s1;
  const c3 = -2 * (1 - f1) - s1;

  return (t: number): number => {
    const u = Number.isNaN(t) ? 0 : t;
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const g = springUnchecked(params, u * T).value + u * u * (c2 + u * c3);
    return Number.isFinite(g) ? g : 1;
  };
}
