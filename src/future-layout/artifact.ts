/**
 * src/future-layout/artifact.ts — сопряжённый SurfaceExecutionArtifact.
 *
 * SSOT-пайплайн (спека «СОПРЯЖЁННАЯ ТРАЕКТОРИЯ»): spring params → canonical
 * serialized P artifact (compositor/curve — тот же, что исполняет browser) →
 * parse serialized P → derive Q ТОЛЬКО из serialized P → serialize Q →
 * continuous reciprocal proof. Никакого raw-spring второго источника:
 * counter-scale обязан совпадать именно с тем progress, который исполнит
 * browser, включая округление CSS-токенов (samples хранят Number(token)).
 *
 * Модель поверхности (host-fit в базу B=W1): G(t)=W(t)/B, F_j=B/W_j,
 * контр-масштаб плоскости j — keyframes scale [W_j/W0, W_j/W1] c easing
 * linear(Q); произведение G·F_j·R_j тождественно 1 на каждом кадре.
 */

import { MotionParamError } from '../errors.js';
import type { SpringParams } from '../spring.js';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
  validateTolerance,
  type SpringSerializedSamples,
} from '../compositor/curve.js';

/** V1 acceptance budget движущейся границы и сопряжения, CSS px. */
export const SURFACE_PRECISION_BUDGET_PX = 0.25;

/** Потолок adaptive subdivision: fail-closed до крупных аллокаций. */
export const RECIPROCAL_MAX_STOPS = 4096;

export interface SurfaceExecutionArtifact {
  /** Serialized P: CSS linear() фактически исполняемой пружины. */
  readonly easing: string;
  /** Serialized Q: reciprocal-компаньон, построенный из serialized P. */
  readonly reciprocalEasing: string;
  /** Монотонная blend-траектория A(t) crossfade (не пружина). */
  readonly blendEasing: string;
  /** [percent, progress, ...] serialized P (percent = точный CSS-токен). */
  readonly samples: SpringSerializedSamples;
  /** [percent, Q, ...] serialized Q (включая subdivision-stops). */
  readonly reciprocalSamples: Float64Array;
  /** A в точках reciprocalSamples (монотонна, endpoints 0 и 1). */
  readonly blendSamples: readonly number[];
  readonly durationMs: number;
  /** Минимум W(t) по serialized stops: линейность между stops не даёт ниже. */
  readonly minWidth: number;
  readonly fromWidth: number;
  readonly toWidth: number;
}

export interface SurfacePlan {
  readonly artifact: SurfaceExecutionArtifact;
  /** Постоянное число native effects, не зависит от числа строк. */
  readonly effectCount: number;
}

function validateSurfaceWidth(width: number): void {
  if (!Number.isFinite(width) || width <= 0) {
    throw new MotionParamError('LM167');
  }
}

/**
 * Compile-as-preflight: undefined, если позитивность/бюджет недоказуемы —
 * runtime выбирает snap/progressive fallback ДО уничтожения owner.
 */
export function tryCompileSurfaceArtifact(
  spring: SpringParams,
  fromWidth: number,
  toWidth: number,
  tolerance: number = DEFAULT_TOLERANCE,
  couplingBudgetPx: number = SURFACE_PRECISION_BUDGET_PX,
  initialVelocity = 0,
): SurfaceExecutionArtifact | undefined {
  validateSurfaceWidth(fromWidth);
  validateSurfaceWidth(toWidth);
  validateTolerance(tolerance);
  if (!(couplingBudgetPx > 0) || !Number.isFinite(couplingBudgetPx)) {
    throw new MotionParamError('LM167');
  }

  if (fromWidth === toWidth) {
    return {
      easing: 'linear(0 0%, 1 100%)',
      reciprocalEasing: 'linear(0 0%, 1 100%)',
      blendEasing: 'linear(0 0%, 1 100%)',
      samples: new Float64Array([0, 0, 100, 1]),
      reciprocalSamples: new Float64Array([0, 0, 100, 1]),
      blendSamples: [0, 1],
      durationMs: 0,
      minWidth: fromWidth,
      fromWidth,
      toWidth,
    };
  }

  const tuple = tryCompileSpringTuple(spring, tolerance, initialVelocity);
  if (tuple === undefined) return undefined;
  const easing = tuple[0];
  const samples = tuple[1];
  const durationMs = tuple[2];
  const count = samples.length / 2;

  let minWidth = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const w = fromWidth + (toWidth - fromWidth) * samples[i * 2 + 1];
    if (w < minWidth) minWidth = w;
  }
  // Позитивность недоказуема (overshoot пересекает сингулярность): reciprocal
  // неограничен — native plan не запускается, Infinity/NaN в CSS не попадает.
  if (!(minWidth > 0)) return undefined;

  const reciprocal = buildReciprocalUnchecked(
    samples,
    fromWidth,
    toWidth,
    couplingBudgetPx,
  );
  if (reciprocal === undefined) {
    // Бюджет недостижим в потолке stops: fail-closed без крупной аллокации.
    return undefined;
  }

  const blendSamples: number[] = [];
  let blendEasing = 'linear(';
  for (let i = 0; i < reciprocal.length / 2; i++) {
    const percent = reciprocal[i * 2];
    const x = percent / 100;
    const a = (3 - 2 * x) * x * x;
    blendSamples.push(a);
    blendEasing += `${a} ${percent}%`;
    if (i < reciprocal.length / 2 - 1) blendEasing += ', ';
  }
  blendEasing += ')';

  let reciprocalEasing = 'linear(';
  for (let i = 0; i < reciprocal.length / 2; i++) {
    reciprocalEasing += `${reciprocal[i * 2 + 1]} ${reciprocal[i * 2]}%`;
    if (i < reciprocal.length / 2 - 1) reciprocalEasing += ', ';
  }
  reciprocalEasing += ')';

  return {
    easing,
    reciprocalEasing,
    blendEasing,
    samples,
    reciprocalSamples: reciprocal,
    blendSamples,
    durationMs,
    minWidth,
    fromWidth,
    toWidth,
  };
}

function tryCompileSpringTuple(
  spring: SpringParams,
  tolerance: number,
  v0: number,
): [string, SpringSerializedSamples, number] | undefined {
  try {
    const tuple = compileSpringExecutionArtifactTupleUnchecked(spring, v0, tolerance);
    return [tuple[0], tuple[1], tuple[2]];
  } catch {
    return undefined;
  }
}

/** Fail-fast обёртка preflight: недоказуемая поверхность — MotionParamError. */
export function compileSurfaceArtifact(
  spring: SpringParams,
  fromWidth: number,
  toWidth: number,
  tolerance?: number,
  couplingBudgetPx?: number,
  initialVelocity?: number,
): SurfaceExecutionArtifact {
  const artifact = tryCompileSurfaceArtifact(
    spring,
    fromWidth,
    toWidth,
    tolerance,
    couplingBudgetPx,
    initialVelocity,
  );
  if (artifact === undefined) {
    throw new MotionParamError('LM167');
  }
  return artifact;
}

/**
 * Непрерывное доказательство reciprocal (спека «НЕПРЕРЫВНОЕ ДОКАЗАТЕЛЬСТВО
 * RECIPROCAL»): на сегменте serialized P ширина линейна W(u)=α+βu, Q — функция
 * от 1/W; линейная интерполяция Q между stops даёт ошибку
 * |Q̂−Q| ≤ (h²/8)·max|Q''|, Q''(u) = 2β²/(W(u)³·Δ), Δ = 1/W1 − 1/W0.
 * Продукционная ошибка сопряжения на контенте шириной W_j:
 * W(t)·W_j·|Δ|·|Q̂−Q| — субдивидим, пока она ≤ budget, с учётом того, что
 * serialized-токены Q не округляются (String(double) — точный roundtrip).
 * Возвращает undefined при превышении RECIPROCAL_MAX_STOPS (fail-closed).
 */
function buildReciprocalUnchecked(
  samples: SpringSerializedSamples,
  fromWidth: number,
  toWidth: number,
  budgetPx: number,
): Float64Array | undefined {
  const count = samples.length / 2;
  const delta = 1 / toWidth - 1 / fromWidth;
  // Fail-closed: без двух stops и без представимого ненулевого Δ доказательство
  // невозможно, а сериализация дала бы невалидный `linear()` или NaN-токены.
  if (count < 2 || !Number.isFinite(delta) || delta === 0) return undefined;
  const widthAt = (percent: number, i: number): number => {
    const x0 = samples[i * 2];
    const p0 = samples[i * 2 + 1];
    const x1 = samples[(i + 1) * 2];
    const p1 = samples[(i + 1) * 2 + 1];
    const q = (percent - x0) / (x1 - x0);
    return fromWidth + (toWidth - fromWidth) * ((1 - q) * p0 + q * p1);
  };
  const qAt = (w: number): number => (1 / w - 1 / fromWidth) / delta;

  // err-bound на сегменте [a,b] (percent): W линеен, β = ΔW/h.
  const segmentErrorPx = (percentA: number, percentB: number, i: number): number => {
    const h = percentB - percentA;
    const wA = widthAt(percentA, i);
    const wB = widthAt(percentB, i);
    const beta = Math.abs(wB - wA) / h;
    const wMin = Math.min(wA, wB);
    if (wMin <= 0) return Number.POSITIVE_INFINITY;
    const maxW = Math.max(wA, wB);
    const contentW = Math.max(fromWidth, toWidth);
    const qErr = (h * h / 8) * (2 * beta * beta) / (wMin * wMin * wMin) / Math.abs(delta);
    return maxW * contentW * Math.abs(delta) * qErr;
  };

  const out: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    let a = samples[i * 2];
    out.push(a, qAt(widthAt(a, i)));
    const stack: number[] = [samples[(i + 1) * 2]];
    while (stack.length > 0) {
      const b = stack.pop()!;
      if (segmentErrorPx(a, b, i) > budgetPx) {
        const mid = (a + b) / 2;
        // Дальше делить некуда, а бюджет не выполнен: доказательство
        // невозможно в double — fail-closed до крупных аллокаций.
        if (mid === a || mid === b) return undefined;
        stack.push(b, mid);
        continue;
      }
      if (out.length / 2 >= RECIPROCAL_MAX_STOPS) return undefined;
      out.push(b, qAt(widthAt(b, i)));
      a = b;
    }
  }
  return Float64Array.from(out);
}

/**
 * Позитивный сертификат: min W(t) > W_min по serialized stops. W линеен между
 * stops, поэтому минимум достигается в stop'ах; samples хранят уже разобранные
 * CSS-токены (Number(percent/progress)), т.е. фактически исполняемые значения.
 */
export function certifyPositivity(artifact: SurfaceExecutionArtifact, wMin: number): boolean {
  return Number.isFinite(artifact.minWidth) && artifact.minWidth > wMin && wMin >= 0;
}

/** Constant-effects plan: 5 native effects при любом числе логических строк. */
export function planSurface(
  spring: SpringParams,
  fromWidth: number,
  toWidth: number,
  tolerance?: number,
): SurfacePlan {
  return {
    artifact: compileSurfaceArtifact(spring, fromWidth, toWidth, tolerance),
    effectCount: 5,
  };
}

/**
 * Keyframes контр-масштаба плоскости j в host-fit модели (F_j = B/W_j,
 * B = W1): scale от W_j/W0 к W_j/W1 c easing linear(Q). Инвариант
 * G·F_j·R_j = 1 выполнен тождественно: произведение affine в Q.
 */
export function planeScaleKeyframes(
  artifact: SurfaceExecutionArtifact,
  planeWidth: number,
): [number, number] {
  return [planeWidth / artifact.fromWidth, planeWidth / artifact.toWidth];
}

/** Keyframes внешнего scale группы: G = W/B, B = W1. */
export function outerScaleKeyframes(artifact: SurfaceExecutionArtifact): [number, number] {
  return [artifact.fromWidth / artifact.toWidth, 1];
}
