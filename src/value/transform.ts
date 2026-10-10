import { composeTransform, TRANSFORM_AXES, type TransformOrder } from '../internal/transform.js';
/**
 * transform.ts — Независимые CSS-трансформы и их интерполяция.
 *
 * Строит единственную CSS transform-строку из независимых каналов
 * (x, y, scale, rotate, skew). Каждый канал интерполируется независимо.
 *
 * Инварианты:
 *   VT1. FINITENESS GUARD: buildTransform/interpolateTransform НИКОГДА не
 *        включают NaN/Infinity в выходную строку.
 *   VT2. SSR-safe.
 *   VT3. Zero runtime deps.
 *
 * Порядок функций в CSS transform важен. Принятый порядок:
 *   translate → scale → rotate → skew
 * (совпадает с Framer Motion / Motion One / GSAP).
 */

import { clampFinite } from './units.js';

// ── TransformState ─────────────────────────────────────────────────────────────

/**
 * Независимые каналы CSS-трансформ.
 * Все поля опциональны — отсутствующие = identity (0 или 1).
 */
export interface TransformState {
  /** translateX в пикселях. По умолчанию 0. */
  readonly x?: number;
  /** translateY в пикселях. По умолчанию 0. */
  readonly y?: number;
  /** Равномерный масштаб. По умолчанию 1. Если задан, перекрывает scaleX/scaleY. */
  readonly scale?: number;
  /** Масштаб по X. По умолчанию 1. */
  readonly scaleX?: number;
  /** Масштаб по Y. По умолчанию 1. */
  readonly scaleY?: number;
  /** Поворот в градусах. По умолчанию 0. */
  readonly rotate?: number;
  /** Наклон по X в градусах. По умолчанию 0. */
  readonly skewX?: number;
  /** Наклон по Y в градусах. По умолчанию 0. */
  readonly skewY?: number;
}

// ── Дефолты ───────────────────────────────────────────────────────────────────

const DEFAULTS = { ...TRANSFORM_AXES, scale: 1 } as Required<TransformState>;

// ── buildTransform ────────────────────────────────────────────────────────────

/**
 * Строит CSS transform-строку из TransformState.
 *
 * Порядок: translate → scale → rotate → skew (стандарт Motion)
 *
 * Пустой TransformState (только identity-значения) возвращает "none"
 * для оптимизации (браузер не тратит ресурсы на layout/composite).
 *
 * FINITENESS GUARD (VT1): каждое значение зажимается через clampFinite
 * перед включением в строку — никаких NaN/Infinity в CSS.
 *
 * @example
 *   buildTransform({ x: 10, rotate: 45 })
 *   // → "translateX(10px) rotate(45deg)"
 */
export function buildTransform(state: TransformState): string {
  return formatTransform(state);
}

/** Проверенный форматтер используется всеми исполнителями CSS-поверхности. */
export function formatTransform(state: TransformState, order: TransformOrder = 0): string {
  return /* @__INLINE__ */ composeTransform(state, order, 0, true);
}

// ── interpolateTransform ──────────────────────────────────────────────────────

/**
 * Интерполирует между двумя TransformState и возвращает CSS transform-строку.
 *
 * Каждый канал интерполируется независимо: тот же lerp что tween.ts,
 * но применённый к каждому полю TransformState, затем buildTransform.
 *
 * FINITENESS GUARD (VT1): наследует от buildTransform + fin().
 *
 * @param from     - начальное состояние трансформ
 * @param to       - конечное состояние трансформ
 * @param t        - нормированный прогресс [0..1]; hostile-t безопасен
 * @returns CSS transform-строка
 */
export function interpolateTransform(from: TransformState, to: TransformState, t: number): string {
  const progress = Number.isFinite(t)
    ? t <= 0 ? 0 : t >= 1 ? 1 : t
    : Number.isNaN(t) ? 0
    : t > 0 ? 1 : 0;

  // Если scale задан в одном и не в другом — нормализуем
  const fromScaleX = from.scale !== undefined ? from.scale : (from.scaleX ?? DEFAULTS.scaleX);
  const fromScaleY = from.scale !== undefined ? from.scale : (from.scaleY ?? DEFAULTS.scaleY);
  const toScaleX = to.scale !== undefined ? to.scale : (to.scaleX ?? DEFAULTS.scaleX);
  const toScaleY = to.scale !== undefined ? to.scale : (to.scaleY ?? DEFAULTS.scaleY);

  const interpolated: TransformState = {
    x: lerpField(from.x ?? DEFAULTS.x, to.x ?? DEFAULTS.x, progress),
    y: lerpField(from.y ?? DEFAULTS.y, to.y ?? DEFAULTS.y, progress),
    scaleX: lerpField(fromScaleX, toScaleX, progress),
    scaleY: lerpField(fromScaleY, toScaleY, progress),
    rotate: lerpField(from.rotate ?? DEFAULTS.rotate, to.rotate ?? DEFAULTS.rotate, progress),
    skewX: lerpField(from.skewX ?? DEFAULTS.skewX, to.skewX ?? DEFAULTS.skewX, progress),
    skewY: lerpField(from.skewY ?? DEFAULTS.skewY, to.skewY ?? DEFAULTS.skewY, progress),
  };

  return buildTransform(interpolated);
}

// ── Вспомогательные ──────────────────────────────────────────────────────────

/** Зажимает до конечного числа (VT1 guard). */
function fin(x: number): number {
  return clampFinite(x);
}

/**
 * Lerp одного поля с FINITENESS GUARD на переполнение range.
 * При |from|+|to|>MAX_VALUE range переполняется в ±Infinity;
 * результат зажимается clampFinite.
 */
function lerpField(from: number, to: number, t: number): number {
  return clampFinite(from + (to - from) * t);
}
