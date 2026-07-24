/**
 * decay.ts — S9: pure headless exponential decay / inertia generator.
 *
 * Closed-form exponential decay-to-rest from an initial position and velocity
 * (e.g. a drag/gesture release), à la Framer Motion's `inertia`/`decay` or
 * native scroll-view momentum (UIScrollView / OverScroller). This is the pure
 * math primitive that later drag-momentum/gesture code consumes — it does not
 * itself drive a frame loop; the caller samples `valueAt(t)`/`velocityAt(t)`
 * at its own virtual time `t` (an injected seam, seconds since release).
 *
 * Physics model (closed-form):
 *   amplitude = power * velocity * timeConstant
 *   value(t)    = from + amplitude * (1 - e^(-t/timeConstant))
 *   velocity(t) = (amplitude / timeConstant) * e^(-t/timeConstant)
 *   rest        = from + amplitude                    (value(t) as t→∞)
 *
 * Note velocity(t) is the exact analytical derivative of value(t) — the two
 * are never independently approximated, so a differential oracle comparing
 * velocity(t) against a numerical derivative of value(t) holds by construction.
 *
 * Invariants (package North):
 *   1. Zero runtime deps — нет внешних npm-зависимостей.
 *   2. CSS-safe — value/velocity/rest всегда конечны (никогда NaN/Infinity),
 *      включая overflow-края (velocity/from около ±MAX_VALUE).
 *   3. Детерминизм — виртуальное время t инжектируется вызывающей стороной;
 *      нет Date.now/Math.random; одинаковый seam → бит-в-бит одинаковый вывод.
 *   4. Reduced-motion — CHARACTER-switch: snap-to-computed-rest, не hard-off.
 *   5. Domain purity — matchMedia инжектируется; нет window/document на пути импорта.
 *   6. SSR-safe — нет обращений к глобалам на верхнем уровне модуля.
 */

import { MotionParamError } from './errors.js';
import type { MatchMediaLike } from './internal/media-query.js';

// ─── Константы ────────────────────────────────────────────────────────────────

/** Дефолтный power — множитель начальной скорости, определяющий итоговую дистанцию. */
const DEFAULT_POWER = 0.8;
/** Дефолтная постоянная времени затухания (секунды). */
const DEFAULT_TIME_CONSTANT = 0.35;
/** Дефолтный порог скорости (units/s), ниже которого движение считается завершённым. */
const DEFAULT_REST_DELTA = 0.5;

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Опции для createDecay(). */
export interface DecayOptions {
  /** Начальная позиция. Должна быть конечной. */
  readonly from: number;
  /** Начальная скорость (units/s), например из отпущенного жеста. Должна быть конечной. */
  readonly velocity: number;
  /**
   * Множитель начальной скорости, определяющий итоговую пройденную дистанцию.
   * Должен быть конечным. По умолчанию: 0.8.
   */
  readonly power?: number | undefined;
  /**
   * Постоянная времени экспоненциального затухания (секунды). Должна быть
   * конечной и строго положительной — невалидное значение (<=0, NaN, ∞)
   * молча заменяется дефолтом (мягкая деградация опционального knob'а).
   * По умолчанию: 0.35.
   */
  readonly timeConstant?: number | undefined;
  /**
   * Порог скорости (units/s, абсолютное значение), ниже которого isSettledAt()
   * считает движение завершённым. Невалидное значение (<0, NaN, ∞) молча
   * заменяется дефолтом. По умолчанию: 0.5.
   */
  readonly restDelta?: number | undefined;
  /**
   * Injectable matchMedia. Pass `window.matchMedia.bind(window)` в браузере.
   * undefined = SSR / нет предпочтений (reduced=false).
   */
  readonly matchMedia?: MatchMediaLike | undefined;
}

/** Headless-модель затухания, возвращаемая createDecay(). */
export interface DecayModel {
  /**
   * Асимптотическая точка покоя (значение при t→∞). Всегда конечна.
   * При reduced=true это же значение, на которое модель снэпнута немедленно.
   */
  readonly rest: number;
  /** true, если сработал reduced-motion CHARACTER-switch (snap-to-rest). */
  readonly reduced: boolean;
  /**
   * Позиция при виртуальном времени t (секунды с момента release).
   * t < 0 → 0 (ещё не начиналось). t = NaN → 0. Всегда конечна.
   * При reduced=true — всегда `rest`, независимо от t.
   */
  valueAt(t: number): number;
  /**
   * Скорость при виртуальном времени t (units/s) — точная аналитическая
   * производная valueAt(t). Всегда конечна.
   * При reduced=true — всегда 0 (уже settled).
   */
  velocityAt(t: number): number;
  /**
   * true, если |velocityAt(t)| <= restDelta — движение практически завершено.
   * При reduced=true — всегда true.
   */
  isSettledAt(t: number): boolean;
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/** Считать предпочтение reduced-motion из инжектируемого matchMedia. */
function prefersReducedMotion(matchMedia: MatchMediaLike | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Возвращает raw, если конечно, иначе fallback. */
function finiteOr(raw: number, fallback: number): number {
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Зажимает потенциально-переполненную (±Infinity) амплитуду к ближайшей
 * конечной границе double, сохраняя знак направления движения.
 * Все входы (power/velocity/timeConstant) уже провалидированы конечными —
 * ampRaw может быть только конечным числом или ±Infinity (никогда NaN),
 * поэтому единственный edge-case — знаковое переполнение произведения.
 */
function clampAmplitude(ampRaw: number): number {
  if (Number.isFinite(ampRaw)) return ampRaw;
  return ampRaw > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}


// ─── createDecay ──────────────────────────────────────────────────────────────

/**
 * Создаёт headless-модель экспоненциального затухания (inertia/decay) от
 * начальной позиции и скорости к асимптотической точке покоя.
 *
 * Чистая математика — не запускает frame loop и не обращается к
 * window/document/Date.now/Math.random. Вызывающая сторона (например
 * drag-momentum жест) сама ведёт виртуальное время `t` и опрашивает
 * `valueAt(t)`/`velocityAt(t)`/`isSettledAt(t)`.
 *
 * @throws {MotionParamError} если from/velocity не конечны.
 */
export function createDecay(options: DecayOptions): DecayModel {
  const { from, velocity } = options;

  // ── Валидация обязательных входных данных ─────────────────────────────────
  if (!Number.isFinite(from)) {
    throw new MotionParamError('LM021');
  }
  if (!Number.isFinite(velocity)) {
    throw new MotionParamError('LM022');
  }

  // ── Опциональные knobs — невалидное значение мягко заменяется дефолтом ─────
  const power =
    options.power !== undefined && Number.isFinite(options.power)
      ? options.power
      : DEFAULT_POWER;
  const timeConstant =
    options.timeConstant !== undefined &&
    Number.isFinite(options.timeConstant) &&
    options.timeConstant > 0
      ? options.timeConstant
      : DEFAULT_TIME_CONSTANT;
  const restDelta =
    options.restDelta !== undefined &&
    Number.isFinite(options.restDelta) &&
    options.restDelta >= 0
      ? options.restDelta
      : DEFAULT_REST_DELTA;

  // ── Амплитуда и точка покоя (overflow-safe) ────────────────────────────────
  const amplitude = clampAmplitude(power * velocity * timeConstant);
  const rest = finiteOr(from + amplitude, amplitude > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);

  // ── Reduced-motion CHARACTER-switch ────────────────────────────────────────
  const reduced = prefersReducedMotion(options.matchMedia);

  if (reduced) {
    return {
      rest,
      reduced: true,
      valueAt: () => rest,
      velocityAt: () => 0,
      isSettledAt: () => true,
    };
  }

  // ── Полная модель (не reduced) ─────────────────────────────────────────────
  function clampT(t: number): number {
    if (Number.isNaN(t)) return 0;
    if (t <= 0) return 0;
    return t;
  }

  function valueAt(t: number): number {
    const ct = clampT(t);
    if (ct === Infinity) return rest;
    const decayFactor = 1 - Math.exp(-ct / timeConstant);
    const raw = from + amplitude * decayFactor;
    return finiteOr(raw, rest);
  }

  function velocityAt(t: number): number {
    const ct = clampT(t);
    if (ct === Infinity) return 0;
    const raw = (amplitude / timeConstant) * Math.exp(-ct / timeConstant);
    return finiteOr(raw, 0);
  }

  function isSettledAt(t: number): boolean {
    if (amplitude === 0) return true;
    return Math.abs(velocityAt(t)) <= restDelta;
  }

  return { rest, reduced: false, valueAt, velocityAt, isSettledAt };
}

/**
 * Проекция момента с дефолтными knobs: `createDecay({from, velocity}).rest`
 * без аллокации модели (и без валидации — вход обязан быть конечным).
 * НЕ публичный API (./decay/index.ts его не реэкспортирует): узкий внутренний
 * шов для ./behaviors, где нужна только точка приземления, — полная модель
 * не должна попадать в consumer bundle поведения.
 *
 * Выражение rest — то же, что в createDecay (общие clampAmplitude/finiteOr и
 * дефолт-константы); менять только синхронно с ним (пин — differential-тесты).
 */
export function decayRest(from: number, velocity: number): number {
  const amplitude = clampAmplitude(DEFAULT_POWER * velocity * DEFAULT_TIME_CONSTANT);
  return finiteOr(from + amplitude, amplitude > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
}
