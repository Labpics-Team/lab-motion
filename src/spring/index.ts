/**
 * spring/index.ts — эргономика пружин (subpath ./spring).
 *
 * Закрывает хвост S3 суперсета (HIGH-гэп из gap-matrix): интуитивные
 * параметризации пружин поверх физического ядра {mass, stiffness, damping}.
 *
 * ТОЧНЫЕ преобразования (#218, #230, ADR-0002): каждый конструктор — чистая
 * биекция наблюдаемых координат в физические, БЕЗ тихой коэрсии под бюджеты
 * исполнителей. Медленные и незатухающие результаты физически валидны
 * (validateSpringPhysics); кадровый исполнитель проверяет СВОЙ бюджет сам
 * (validateSpringForFrameLoop) на своей границе.
 *
 * - fromBounce({duration, bounce}) — канон SwiftUI Spring(duration:bounce:):
 *     ζ = 1 − bounce, ω₀ = 2π/duration → k = m·ω₀², c = 2m·ζ·ω₀.
 *   bounce ∈ [−1, 1] — точный диапазон SwiftUI (0 = критическое, >0 = упругая,
 *   <0 = пере-демпфированная «плоская»); bounce = 1 → ζ = 0 → damping = 0 —
 *   математически незатухающий осциллятор, как и должно быть.
 * - fromVisualDuration — время ПЕРВОГО визуального касания цели (Motion):
 *   для ζ<1 решается точно из первого пересечения x(t)=1:
 *     ωd·t* = π − atan(ωd/(ζω₀)) → ω₀ = (π − atan(√(1−ζ²)/ζ)) / (√(1−ζ²)·Tv);
 *   формула непрерывна в ζ=0 (atan(∞)=π/2 → ω₀=π/(2·Tv), проверка: x=1−cos ω₀t).
 *   Для ζ≥1 пересечения нет — Tv трактуется как выход на ~99% цели
 *   (медленнейшая мода: ζω₀·Tv ≈ ln(100)).
 * - springFromPeak — точный обратный конструктор из наблюдаемого пика (#230):
 *   t_peak = π/ωd; overshoot = exp(−ζπ/√(1−ζ²)) ⇒ L = −ln(overshoot),
 *   ζ = L/√(π²+L²), ω₀ = √(π²+L²)/t_peak. Либо напрямую из dampingRatio:
 *   ω₀ = π/(t_peak·√(1−ζ²)).
 * - springFromOscillation — точный обратный конструктор из периода затухающих
 *   колебаний и огибающей (#230): ωd = 2π/period, α — из halfLife (ln2/T½),
 *   decayTime (1/τ) или dampingRatio (ωd·ζ/√(1−ζ²)); ω₀ = √(ωd²+α²), ζ = α/ω₀.
 * - springPresets — канонические пресеты react-spring (tension/friction
 *   при mass=1): default/gentle/wobbly/stiff/slow/molasses.
 * - springAsEasing(params) — пружина как easing-функция t∈[0,1]→value
 *   (совместима с keyframes/tween): шкала времени = время оседания
 *   параметров; эндпоинты точны (дисциплина NE2), форма OVERSHOOTING
 *   при ζ<1. Требует оседающую пружину (ζ>0): у незатухающей e(1)=1
 *   недостижимо — MotionParamError LM091.
 *
 * Инварианты: zero-DOM, zero-deps, детерминизм, MotionParamError рано,
 * обратимость: constructor(observables(params)) ≡ params с точностью IEEE-754.
 */

import { spring, validateSpringPhysics, type SpringParams } from '../spring.js';
import { CONVERGENCE_THRESHOLD } from '../internal/constants.js';
import { makeSpringValueSampler } from '../internal/solver.js';
import { MotionParamError } from '../errors.js';

/** ln(100): множитель времени затухания огибающей до 1%. */
const LN_100 = Math.log(100);

/**
 * Медленный корень в единицах ω₀ через тождество ζ−√(ζ²−1) = 1/(ζ+√(ζ²−1)).
 * Прямая разность теряет значащие цифры задолго до вырождения: измерено 0.58%
 * ошибки при ζ=1e7, 4.3% при 2e7, 25.5% при 5e7 и 100% при 1e8, где она
 * обнуляется, а вызывающие подставляли пол 1e-6. Форма без вычитания точна на
 * всём домене, поэтому применяется всегда, а не только на вырождении.
 */
function slowRoot(z: number): number {
  return z < 1 ? z : 1 / (z + Math.sqrt(z * z - 1));
}

/**
 * Форменные множители траектории в нормированном времени τ = ω₀t: остаток до
 * цели 1 − x(τ) и скорость dx/dτ. Для ζ≥1 записаны разностью экспонент по двум
 * корням, а не через cosh/sinh: последние переполняются уже при ζ=10, и
 * e^{−ζτ}·∞ даёт NaN. Медленный корень берётся тем же тождеством 1/(ζ+s), что
 * и везде в файле, поэтому у ζ=1 ветви сходятся без полюса 1/√|ζ²−1|.
 */
function shape(z: number, tau: number): { rest: number; vel: number } {
  if (z < 1) {
    const d = Math.sqrt(1 - z * z);
    const x = d * tau;
    const e = Math.exp(-z * tau);
    const sinc = x === 0 ? 1 : Math.sin(x) / x;
    return { rest: e * (Math.cos(x) + z * tau * sinc), vel: tau * e * sinc };
  }
  const s = Math.sqrt(z * z - 1);
  if (s === 0) {
    const e = Math.exp(-tau);
    return { rest: e * (1 + tau), vel: tau * e };
  }
  const slow = Math.exp(-slowRoot(z) * tau);
  const fast = Math.exp(-(z + s) * tau);
  const half = (slow - fast) / (2 * s);
  return { rest: (slow + fast) / 2 + z * half, vel: half };
}

/**
 * Горизонт финитной проекции: наименьшее τ, при котором эрмитова коррекция
 * уводит кривую от истинной пружины не более чем на CONVERGENCE_THRESHOLD.
 *
 * Отклонение ограничено |1−x(U)| + (4/27)·U·|dx/dτ(U)|, потому что
 * max|3u²−2u³| = 1 и max|u³−u²| = 4/27 на [0,1]. Для ζ<1 критерий осциллирует,
 * поэтому мажорируем |cos| ≤ 1 и |sin(x)/x| ≤ 1; для ζ≥1 форма монотонна и
 * берётся точно. В ζ=1 обе записи совпадают, разрыва горизонта нет.
 *
 * Зависит ТОЛЬКО от ζ и допуска — ни от ω₀, ни от массы, ни от бюджета кадра,
 * поэтому scale-equivalent пружины дают бит-в-бит одну кривую.
 */
function easingHorizon(z: number): number {
  const k = 4 / 27;
  const deviation = (u: number): number => {
    if (z < 1) {
      const d = Math.sqrt(1 - z * z);
      // |sin(x)/x| ≤ min(1, 1/x): без второго ограничения горизонт рос как
      // O(1/ζ²) и у слабо демпфированных пружин не помещался ни в какой
      // разумный потолок. С ним рост — O(ln(1/tol)/ζ).
      return Math.exp(-z * u) * (1 + Math.min(z * u, z / d) + k * u * Math.min(u, 1 / d));
    }
    const { rest, vel } = shape(z, u);
    return rest + k * u * vel;
  };
  // Потолок — страховка от бесконечного цикла, а не рабочий путь: при ζ>0
  // экспонента всегда пересиливает полином. Если он всё же достигнут, финитной
  // проекции в допуск не существует, и это отказ, а не тихая подмена кривой.
  const CEILING = 1e12;
  let hi = 1;
  while (deviation(hi) > CONVERGENCE_THRESHOLD && hi < CEILING) hi *= 2;
  if (deviation(hi) > CONVERGENCE_THRESHOLD) throw new MotionParamError('LM169');
  let lo = 0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (deviation(mid) > CONVERGENCE_THRESHOLD) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ─── Общие проверки входов ───────────────────────────────────────────────────

function checkBounce(bounce: number): void {
  if (!Number.isFinite(bounce) || bounce < -1 || bounce > 1) {
    throw new MotionParamError('LM092');
  }
}

function checkPositive(v: number): void {
  if (!Number.isFinite(v) || v <= 0) {
    throw new MotionParamError('LM093');
  }
}

function massOf(mass: number | undefined): number {
  return typeof mass === 'number' && Number.isFinite(mass) && mass > 0 ? mass : 1;
}

/**
 * Точная сборка {m, k, c} из канонических координат (ω₀, ζ, m):
 * k = m·ω₀², c = 2m·ζ·ω₀ — БЕЗ коэрсии (#218). Скейл (m,k,c)→(λm,λk,λc)
 * не меняет ω₀/ζ/траекторию, поэтому mass — не перцептивная ручка, а
 * нормировка. Композиция с физическим валидатором — страж конечности.
 */
function exactParams(omega0: number, zeta: number, mass: number): SpringParams {
  const params: SpringParams = {
    mass,
    stiffness: mass * omega0 * omega0,
    damping: 2 * mass * zeta * omega0,
  };
  validateSpringPhysics(params);
  return params;
}

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

/**
 * Пружина из перцептивной длительности и упругости (канон SwiftUI/Motion).
 * Точно: ω₀ = 2π/duration, ζ = 1 − bounce. Никакой тихой коэрсии:
 * duration=100, bounce=0, mass=1 → ω₀=2π/100, ζ=1, k≈0.0039478, c≈0.1256637;
 * bounce=1 → damping=0 (незатухающая — математический факт, не ошибка).
 */
export function fromBounce(options: FromBounceOptions): SpringParams {
  checkPositive(options.duration);
  checkBounce(options.bounce);
  const omega0 = (2 * Math.PI) / options.duration;
  const zeta = 1 - options.bounce;
  return exactParams(omega0, zeta, massOf(options.mass));
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
 * Пружина, ПЕРВОЕ касание цели у которой = visualDuration (класс Motion).
 *
 * Точное аналитическое решение (#218): при ζ<1 ω₀ выводится из первого
 * пересечения x(t)=1 (формула в шапке), при ζ≥1 пересечения нет и Tv —
 * выход на ~99% цели по медленнейшей моде. Никакой бисекции по ζ и никакой
 * бюджетной коэрсии: запрошенные (Tv, bounce) сохраняются ТОЧНО.
 */
export function fromVisualDuration(options: FromVisualDurationOptions): SpringParams {
  checkPositive(options.visualDuration);
  checkBounce(options.bounce);
  const Tv = options.visualDuration;
  const zeta = 1 - options.bounce;

  if (zeta < 1) {
    // Точное решение первого пересечения x(t)=1. Непрерывно в ζ=0:
    // s/ζ → ∞, atan → π/2, ω₀ → π/(2·Tv) — первый максимум 1−cos(ω₀t).
    const s = Math.sqrt(1 - zeta * zeta);
    const omega0 = (Math.PI - Math.atan(s / zeta)) / (s * Tv);
    return exactParams(omega0, zeta, massOf(options.mass));
  }
  // Пересечения нет: Tv = выход на ~99% цели по медленнейшей моде.
  // Для ζ=1 огибающая ~e^{−ω₀t}; для ζ>1 медленнейший корень
  // r = ω₀(ζ − √(ζ²−1)) → ω₀ = ln(100) / (Tv · (ζ − √(ζ²−1))).
  const slow = zeta - Math.sqrt(zeta * zeta - 1);
  return exactParams(LN_100 / (Tv * slow), zeta, massOf(options.mass));
}

// ─── springFromPeak (#230) ───────────────────────────────────────────────────

/** Опции точного обратного конструктора из наблюдаемого пика. */
export interface FromPeakOptions {
  /** Время первого пика перерегулирования (секунды), > 0. */
  readonly timeToPeak: number;
  /** Пик как абсолютное значение (>1, напр. 1.15) или доля (0.15). */
  readonly peak?: number | undefined;
  /** Перерегулирование как доля ∈ (0, 1) (напр. 0.15 = 15%). */
  readonly overshoot?: number | undefined;
  /** Коэффициент демпфирования ζ ∈ (0, 1) — альтернатива overshoot. */
  readonly dampingRatio?: number | undefined;
  /** Масса. По умолчанию 1. */
  readonly mass?: number | undefined;
}

/**
 * Точный обратный конструктор из наблюдаемого пика step-ответа (#230).
 *
 * Прямые наблюдаемые: t_peak = π/ωd (первый ноль скорости),
 * overshoot = exp(−ζπ/√(1−ζ²)) (высота пика над целью). Обращение точное:
 *   L = −ln(overshoot); ζ = L/√(π²+L²); ω₀ = √(π²+L²)/t_peak
 * (тождество: ωd = ω₀√(1−ζ²) = π/t_peak). При заданном dampingRatio
 * ω₀ = π/(t_peak·√(1−ζ²)) — та же биекция, другая координата.
 */
export function springFromPeak(options: FromPeakOptions): SpringParams {
  checkPositive(options.timeToPeak);
  const mass = massOf(options.mass);

  if (typeof options.dampingRatio === 'number') {
    const zeta = options.dampingRatio;
    if (!Number.isFinite(zeta) || zeta <= 0 || zeta >= 1) {
      throw new MotionParamError('LM092');
    }
    const omega0 = Math.PI / (options.timeToPeak * Math.sqrt(1 - zeta * zeta));
    return exactParams(omega0, zeta, mass);
  }

  let mp: number;
  if (typeof options.overshoot === 'number') {
    mp = options.overshoot;
  } else if (typeof options.peak === 'number') {
    mp = options.peak > 1 ? options.peak - 1 : options.peak;
  } else {
    throw new MotionParamError('LM092');
  }
  if (!Number.isFinite(mp) || mp <= 0 || mp >= 1) {
    throw new MotionParamError('LM092');
  }

  const L = -Math.log(mp);
  const hyp = Math.sqrt(Math.PI * Math.PI + L * L);
  const zeta = L / hyp;
  const omega0 = hyp / options.timeToPeak;
  return exactParams(omega0, zeta, mass);
}

// ─── springFromOscillation (#230) ────────────────────────────────────────────

/** Опции точного обратного конструктора из наблюдаемых колебаний. */
export interface FromOscillationOptions {
  /** Период затухающих колебаний (секунды), > 0. */
  readonly period?: number | undefined;
  /** Частота затухающих колебаний (Гц), > 0 — альтернатива period. */
  readonly frequency?: number | undefined;
  /** Время спада амплитуды огибающей вдвое (секунды), > 0. */
  readonly halfLife?: number | undefined;
  /** Постоянная времени огибающей (спад в 1/e, секунды), > 0. */
  readonly decayTime?: number | undefined;
  /** Коэффициент демпфирования ζ ∈ (0, 1). */
  readonly dampingRatio?: number | undefined;
  /** Масса. По умолчанию 1. */
  readonly mass?: number | undefined;
}

/**
 * Точный обратный конструктор из наблюдаемых затухающих колебаний (#230).
 *
 * Прямые наблюдаемые: период T = 2π/ωd и скорость огибающей α = ζω₀
 * (halfLife: α = ln2/T½; decayTime: α = 1/τ; dampingRatio: α = ωd·ζ/√(1−ζ²)).
 * Обращение точное: ω₀ = √(ωd² + α²), ζ = α/ω₀ (пифагорова связь
 * ωd² + (ζω₀)² = ω₀²).
 */
export function springFromOscillation(options: FromOscillationOptions): SpringParams {
  let period: number;
  if (typeof options.period === 'number') {
    period = options.period;
  } else if (typeof options.frequency === 'number') {
    checkPositive(options.frequency);
    period = 1 / options.frequency;
  } else {
    throw new MotionParamError('LM093');
  }
  checkPositive(period);
  const omegaD = (2 * Math.PI) / period;

  let alpha: number;
  if (typeof options.halfLife === 'number') {
    checkPositive(options.halfLife);
    alpha = Math.LN2 / options.halfLife;
  } else if (typeof options.decayTime === 'number') {
    checkPositive(options.decayTime);
    alpha = 1 / options.decayTime;
  } else if (typeof options.dampingRatio === 'number') {
    const z = options.dampingRatio;
    if (!Number.isFinite(z) || z <= 0 || z >= 1) {
      throw new MotionParamError('LM092');
    }
    alpha = (omegaD * z) / Math.sqrt(1 - z * z);
  } else {
    throw new MotionParamError('LM093');
  }

  const omega0 = Math.hypot(omegaD, alpha);
  const zeta = alpha / omega0;
  return exactParams(omega0, zeta, massOf(options.mass));
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
 * Пружина как easing-функция t∈[0,1] → value (форма OVERSHOOTING при ζ<1).
 * Шкала: t=1 соответствует времени оседания параметров (огибающая до 1%).
 * Эндпоинты точны: e(0)=0, e(1)=1; вход клампится, NaN→0 (дисциплина NE2/NE1).
 *
 * Требует ОСЕДАЮЩУЮ пружину (ζ > 0): у незатухающей шкала времени не
 * существует и e(1)=1 недостижимо — MotionParamError LM091. Медленные
 * оседающие пружины валидны: функция чистая, шкала нормирована.
 */
export function springAsEasing(params: SpringParams): (t: number) => number {
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  // ζ = c/(2√(km)) = c/(2m·ω₀): тождество снимает второй sqrt и не переполняет
  // произведение stiffness·mass — это было единственное место в репозитории,
  // где ζ ещё считалась переполняющейся формой.
  const zeta = params.damping / (2 * params.mass * omega0);
  // Канонический приоритет ошибок: LM088 → LM089 → LM090 → LM169 → LM091.
  // Полевые коды отдаёт сам валидатор (он проверяет поля до бюджета), поэтому
  // комбинированный инвалид {mass:0, damping:0} даёт LM088. Единственный
  // случай, где бюджетный LM091 маскировал бы истинную причину, — валидные
  // поля с damping === 0: бюджет там бесконечен ВСЕГДА, а дефект — отсутствие
  // затухания, это контракт easing (LM169). Узкий ремап ровно этого случая.
  try {
    spring(params, 0);
  } catch (error) {
    if (params.damping === 0 && (error as MotionParamError).code === 'LM091') {
      throw new MotionParamError('LM169');
    }
    throw error;
  }

  const horizon = easingHorizon(zeta);
  const settle = horizon / omega0;
  // Сэмплер хойстит инварианты один раз: на вызов не остаётся ни валидации,
  // ни расчёта горизонта, ни аллокации объекта.
  const sample = makeSpringValueSampler(params, 0);
  const gap = 1 - sample(settle);
  const slopeAtEnd = horizon * shape(zeta, horizon).vel;

  return (t: number): number => {
    const u = Number.isNaN(t) ? 0 : t;
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const v = sample(u * settle);
    if (!Number.isFinite(v)) return 1;
    // Эрмитова C¹-запечатка: h₁=3u²−2u³ добирает остаток (h₁(1)=1, h₁′(1)=0),
    // h₂=u³−u² гасит наклон (h₂(1)=0, h₂′(1)=1). Обе базисные функции и их
    // производные равны нулю в u=0, поэтому старт не сдвигается.
    const u2 = u * u;
    const u3 = u2 * u;
    return v + gap * (3 * u2 - 2 * u3) - slopeAtEnd * (u3 - u2);
  };
}
