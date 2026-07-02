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
 *     ωd·t* = π − atan(ωd/(ζω0)) → ω0 = (π − atan(√(1−ζ²)/ζ)) / (√(1−ζ²)·Tv);
 *   для ζ≥1 пересечения нет — Tv трактуется как выход на ~99% цели
 *   (медленнейшая мода: ζω0·Tv ≈ ln(100)).
 * - springPresets — канонические пресеты react-spring (tension/friction
 *   при mass=1): default/gentle/wobbly/stiff/slow/molasses.
 * - springAsEasing(params) — пружина как easing-функция t∈[0,1]→value
 *   (совместима с keyframes/tween): шкала времени = время оседания
 *   параметров; эндпоинты точны (дисциплина NE2), форма OVERSHOOTING
 *   при ζ<1.
 *
 * Все результаты уважают полы движка (validateSpringParams: ω0 ≥ 2 rad/s,
 * ζ ∈ [0.2, 4]) — публичные краевые bounce/duration ЧЕСТНО клампятся к ним
 * (иначе пружина не сходится за MAX_FRAMES и ядро её отвергнет).
 *
 * Инварианты: zero-DOM, zero-deps, детерминизм, MotionParamError рано.
 */

import { spring, type SpringParams } from '../spring.js';
import { MotionParamError } from '../errors.js';

// ─── Полы движка (зеркалят константы валидатора spring.ts) ───────────────────

const MIN_OMEGA0 = 2.0;
const MIN_ZETA = 0.2;
const MAX_ZETA = 4;
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
    throw new MotionParamError(`${name}: bounce должен быть конечным в [−1, 1], получено ${bounce}`);
  }
}

function checkPositive(v: number, name: string, field: string): void {
  if (!Number.isFinite(v) || v <= 0) {
    throw new MotionParamError(`${name}: ${field} должен быть положительным конечным, получено ${v}`);
  }
}

function toParams(omega0Raw: number, zetaRaw: number, mass: number): SpringParams {
  // Честные клампы к полам движка (см. шапку). Потолок MAX_ZETA текущими
  // маппингами недостижим (bounce ∈ [−1,1] → ζraw ≤ 2) — он инвариант воронки
  // для будущих параметризаций, идущих через toParams.
  const omega0 = Math.max(MIN_OMEGA0, omega0Raw);
  const zeta = Math.min(MAX_ZETA, Math.max(MIN_ZETA, zetaRaw));
  const stiffness = mass * omega0 * omega0;
  const damping = 2 * mass * zeta * omega0;
  return { mass, stiffness, damping };
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
 * Граница гарантии: если решённая ω0 ниже пола движка (MIN_OMEGA0 — длинные
 * visualDuration при малом ζ), она клампится ВВЕРХ → пружина быстрее
 * запрошенной и первое касание наступает РАНЬШЕ visualDuration (деградация
 * в предсказуемую сторону, до −25% на краю публичного домена). Точное
 * равенство гарантируется только вне зоны клампа; инвариант «t1 совпадает
 * с аналитическим решением для ФИНАЛЬНЫХ параметров» держится всегда.
 */
export function fromVisualDuration(options: FromVisualDurationOptions): SpringParams {
  checkPositive(options.visualDuration, 'fromVisualDuration', 'visualDuration');
  checkBounce(options.bounce, 'fromVisualDuration');
  const mass =
    typeof options.mass === 'number' && Number.isFinite(options.mass) && options.mass > 0
      ? options.mass
      : 1;
  const Tv = options.visualDuration;
  const zeta = Math.min(MAX_ZETA, Math.max(MIN_ZETA, 1 - options.bounce));

  let omega0: number;
  if (zeta < 1) {
    // Точное решение первого пересечения x(t)=1 (вывод в шапке).
    const s = Math.sqrt(1 - zeta * zeta);
    omega0 = (Math.PI - Math.atan(s / zeta)) / (s * Tv);
  } else {
    // Пересечения нет: Tv = выход на ~99% цели по медленнейшей моде.
    // Для ζ=1 огибающая ~e^{−ω0 t}; для ζ>1 медленнейший корень
    // r = ω0(ζ − √(ζ²−1)) → ω0 = ln(100) / (Tv · (ζ − √(ζ²−1))).
    const slow = zeta - Math.sqrt(Math.max(0, zeta * zeta - 1));
    omega0 = LN_100 / (Tv * Math.max(slow, 1e-6));
  }
  return toParams(omega0, zeta, mass);
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
  // Валидация рано и детерминированно (конвенция движка).
  spring(params, 0);
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const zeta = params.damping / (2 * Math.sqrt(params.stiffness * params.mass));
  const slow = zeta >= 1 ? zeta - Math.sqrt(Math.max(0, zeta * zeta - 1)) : zeta;
  const settle = LN_100 / (omega0 * Math.max(slow, 1e-6));

  return (t: number): number => {
    const u = Number.isNaN(t) ? 0 : t;
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const v = spring(params, u * settle).value;
    return Number.isFinite(v) ? v : 1;
  };
}
