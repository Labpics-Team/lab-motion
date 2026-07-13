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
 * Все результаты уважают выведенный бюджет валидатора (settleTimeUpperBound
 * ≤ бюджета кадра-капа): краевые bounce/duration ЧЕСТНО клампятся к
 * минимальному оседающему ζ, а не к коробочному полу 0.2 (2026-07-03).
 *
 * Инварианты: zero-DOM, zero-deps, детерминизм, MotionParamError рано.
 */

import { settleTimeAtRestUpperBound, spring, type SpringParams } from '../spring.js';
import { MotionParamError } from '../errors.js';

// ─── Бюджет валидатора (зеркалит выведенный закон spring.ts, 2026-07-03) ─────
//
// Коробочные полы (ω₀ ≥ 2, ζ ∈ [0.2, 4]) удалены вместе с валидатором: теперь
// принимается любая пружина, чьё аналитическое время оседания помещается в
// бюджет кадра-капа (settleTimeUpperBound ≤ ~33.3 c). Клампы воронки ниже —
// минимальные, только против физически неоседающих краёв (ζ → 0 при малой ω₀):
// ζ_min выводится из того же бюджета: rate = ζ·ω₀ ≥ LN_BUDGET/бюджет.
const SETTLE_BUDGET_S = 2000 / 60; // = MAX_FRAMES·FIXED_DT_S валидатора
/**
 * ln-потребность оседания как у валидатора: ln(1/ε) + max(0, ln ω₀)
 * (скоростной критерий |v| < ε растёт с ω₀) + запас на амплитудный член.
 */
const lnBudget = (omega0: number): number =>
  Math.log(1 / 0.005) + Math.max(0, Math.log(omega0)) + 2;
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

function toParams(omega0Raw: number, zetaRaw: number, mass: number): SpringParams {
  // Честные клампы к ВЫВЕДЕННОМУ бюджету (не к коробочным полам, 2026-07-03):
  // оба пола выводятся из одного условия «медленная мода оседает в бюджет
  // кадра-капа» (rate·budget ≥ LN_BUDGET, rate = ζω₀ | ω₀(ζ−√(ζ²−1))).
  // - bounce=1 (ζraw=0) больше не срезается до 0.2: при типичной ω₀ ζ_min —
  //   доли процента, «полностью упругая» пружина реально достижима;
  // - запрошенная длительность за бюджетом коэрсится К БЮДЖЕТУ (прежняя
  //   коробка ω₀≥2 молча превращала 100-секундный запрос в ~2.3-секундный —
  //   худшая из возможных подмен намерения).
  const zetaSeed = Math.max(1e-4, zetaRaw);
  const slowOf = (z: number) => (z < 1 ? z : z - Math.sqrt(z * z - 1));
  let omega0 = Math.max(
    omega0Raw,
    lnBudget(omega0Raw) / (slowOf(zetaSeed) * SETTLE_BUDGET_S),
  );
  const zetaMin = Math.min(1, lnBudget(omega0) / (omega0 * SETTLE_BUDGET_S));
  const zeta = Math.max(zetaMin, zetaRaw);
  // Точная досадка под бюджет ЕДИНЫМ источником истины (settleTimeUpperBound
  // валидатора): аналитические полы выше — сид; амплитудный член у ζ≈1 они
  // не учитывают. t ∝ 1/ω₀ при фиксированной ζ — 3 итераций достаточно.
  for (let i = 0; i < 3; i++) {
    const params = {
      mass,
      stiffness: mass * omega0 * omega0,
      damping: 2 * mass * zeta * omega0,
    };
    const t = settleTimeAtRestUpperBound(params);
    if (t <= SETTLE_BUDGET_S) break;
    omega0 *= (t / SETTLE_BUDGET_S) * 1.02;
  }
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
 * Именованный контракт API — Tv, упругость — характер. Если запрошенная
 * пара (Tv, bounce) не помещается в бюджет оседания валидатора, коэрсия
 * жертвует bounce (ζ поднимается, ω₀ пересчитывается из формулы первого
 * пересечения) — КАСАНИЕ ОСТАЁТСЯ ровно в Tv. Прежний путь через общий
 * toParams поднимал ω₀ и молча ускорял касание — подмена намерения
 * (аудит 2026-07-03). Только когда Tv само не помещается в бюджет даже
 * у почти-критической пружины, длительность деградирует К БЮДЖЕТУ
 * (касание раньше — предсказуемая сторона). Инвариант «t1 совпадает с
 * аналитическим решением для ФИНАЛЬНЫХ параметров» держится всегда.
 */
export function fromVisualDuration(options: FromVisualDurationOptions): SpringParams {
  checkPositive(options.visualDuration, 'fromVisualDuration', 'visualDuration');
  checkBounce(options.bounce, 'fromVisualDuration');
  const mass =
    typeof options.mass === 'number' && Number.isFinite(options.mass) && options.mass > 0
      ? options.mass
      : 1;
  const Tv = options.visualDuration;
  // ζ из bounce; нижний кламп — только против деления на ноль в формуле
  // первого пересечения (atan(s/ζ)); бюджет оседания добирает коэрсия ниже.
  const zeta = Math.max(1e-6, 1 - options.bounce);

  if (zeta < 1) {
    // Точное решение первого пересечения x(t)=1 (вывод в шапке) при данном ζ:
    // вдоль кривой Tv=const ω₀ — функция ζ, а rate = ζ·ω₀(ζ) растёт с ζ
    // (у ζ→1 ω₀ → ∞), поэтому бюджет достижим бисекцией по ζ без сдвига Tv.
    const paramsAt = (z: number): SpringParams => {
      const s = Math.sqrt(1 - z * z);
      const w = (Math.PI - Math.atan(s / z)) / (s * Tv);
      return { mass, stiffness: mass * w * w, damping: 2 * mass * z * w };
    };
    const fits = (z: number): boolean =>
      settleTimeAtRestUpperBound(paramsAt(z)) <= SETTLE_BUDGET_S;
    if (fits(zeta)) return paramsAt(zeta);
    const Z_HI = 0.995; // почти-критическая; ближе к 1 касание вырождается численно
    if (fits(Z_HI)) {
      let lo = zeta;
      let hi = Z_HI; // инвариант бисекции: fits(hi) всегда истинно
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      return paramsAt(hi);
    }
    // Tv не помещается в бюджет даже у ζ=Z_HI: честная деградация
    // длительности к бюджету (toParams), касание наступает раньше.
    const s = Math.sqrt(1 - zeta * zeta);
    return toParams((Math.PI - Math.atan(s / zeta)) / (s * Tv), zeta, mass);
  }
  // Пересечения нет: Tv = выход на ~99% цели по медленнейшей моде.
  // Для ζ=1 огибающая ~e^{−ω0 t}; для ζ>1 медленнейший корень
  // r = ω0(ζ − √(ζ²−1)) → ω0 = ln(100) / (Tv · (ζ − √(ζ²−1))).
  const slow = zeta - Math.sqrt(Math.max(0, zeta * zeta - 1));
  return toParams(LN_100 / (Tv * Math.max(slow, 1e-6)), zeta, mass);
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
