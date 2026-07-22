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

import { validateSpringPhysics, spring, type SpringParams } from '../spring.js';
import { MotionParamError } from '../errors.js';

/** ln(100): множитель времени затухания огибающей до 1%. */
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
  const mass =
    typeof options.mass === 'number' && Number.isFinite(options.mass) && options.mass > 0
      ? options.mass
      : 1;
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
  const mass =
    typeof options.mass === 'number' && Number.isFinite(options.mass) && options.mass > 0
      ? options.mass
      : 1;
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
 */
export function springAsEasing(params: SpringParams): (t: number) => number {
  // Физическая граница — рано и один раз; бюджет frame-loop здесь не
  // применяется: easing живёт в НОРМАЛИЗОВАННОМ времени, медленная пружина
  // легальна (#218).
  validateSpringPhysics(params);
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const zeta = params.damping / (2 * Math.sqrt(params.stiffness * params.mass));
  // Медленный корень стабильной формой 1/(ζ+√(ζ²−1)) ≡ ζ−√(ζ²−1) (#226).
  const slow = zeta >= 1 ? 1 / (zeta + Math.sqrt(Math.max(0, zeta * zeta - 1))) : zeta;
  // Конечная проекция на [0,1] существует только у затухающей системы:
  // ζ=0 не имеет конечного горизонта — граница ЭТОГО исполнителя (#218).
  if (!(slow > 0)) throw new MotionParamError('LM167');
  const settle = LN_100 / (omega0 * slow);

  return (t: number): number => {
    const u = Number.isNaN(t) ? 0 : t;
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const v = spring(params, u * settle).value;
    return Number.isFinite(v) ? v : 1;
  };
}
