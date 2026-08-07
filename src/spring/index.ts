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
 *   (совместима с keyframes/tween): шкала времени = горизонт допуска, кривая
 *   C¹-запечатана на обоих концах, отклонение от настоящей пружины не
 *   превышает CONVERGENCE_THRESHOLD; форма OVERSHOOTING при ζ<1.
 *
 * Все результаты уважают выведенный бюджет валидатора (settleTimeUpperBound
 * ≤ бюджета кадра-капа): краевые bounce/duration ЧЕСТНО клампятся к
 * минимальному оседающему ζ, а не к коробочному полу 0.2 (2026-07-03).
 *
 * Инварианты: zero-DOM, zero-deps, детерминизм, MotionParamError рано.
 */

import { settleTimeAtRestUpperBound, spring, type SpringParams } from '../spring.js';
import { CONVERGENCE_THRESHOLD } from '../internal/constants.js';
import { makeSpringValueSampler } from '../internal/solver.js';
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
      // |sin(x)/x| ≤ min(1, 1/x): без второго ограничения горизонт рос как
      // O(1/ζ²) и у слабо демпфированных пружин не помещался ни в какой
      // разумный потолок. С ним рост — O(ln(1/tol)/ζ).
      const d = Math.sqrt(1 - z * z);
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
  let omega0 = Math.max(
    omega0Raw,
    lnBudget(omega0Raw) / (slowRoot(zetaSeed) * SETTLE_BUDGET_S),
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
  const slow = slowRoot(zeta);
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
 * Шкала: t=1 соответствует ГОРИЗОНТУ ДОПУСКА — наименьшему времени, при
 * котором C¹-запечатка уводит кривую от настоящей пружины не более чем на
 * CONVERGENCE_THRESHOLD. Горизонт зависит только от ζ и допуска, поэтому
 * scale-equivalent пружины дают одну кривую. Возвращается НЕ сама пружина,
 * а её эрмитово скорректированная проекция: концы запечатаны точно
 * (g(0)=0, g′(0)=0, g(1)=1, g′(1)=0), отклонение от пружины ≤ допуска.
 * Эндпоинты точны: e(0)=0, e(1)=1; вход клампится, NaN→0 (дисциплина NE2/NE1).
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
