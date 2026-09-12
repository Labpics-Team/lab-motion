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
  type SpringExecutionArtifactTuple,
} from '../compositor/curve.js';

/** V1 acceptance budget движущейся границы и сопряжения, CSS px. */
export const SURFACE_PRECISION_BUDGET_PX = 0.25;

/** Потолок adaptive subdivision: fail-closed до крупных аллокаций. */
export const RECIPROCAL_MAX_STOPS = 4096;

/** W0=W1: мгновенный вырожденный переход без делений. */
const DEGENERATE_EASING = 'linear(0 0%, 1 100%)';

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
      easing: DEGENERATE_EASING,
      reciprocalEasing: DEGENERATE_EASING,
      blendEasing: DEGENERATE_EASING,
      samples: new Float64Array([0, 0, 100, 1]),
      reciprocalSamples: new Float64Array([0, 0, 100, 1]),
      blendSamples: [0, 1],
      durationMs: 0,
      minWidth: fromWidth,
      fromWidth,
      toWidth,
    };
  }

  let tuple: SpringExecutionArtifactTuple;
  try {
    tuple = compileSpringExecutionArtifactTupleUnchecked(spring, initialVelocity, tolerance);
  } catch {
    return undefined;
  }
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

  // Для линейной W на интервале h прежний непрерывный бонд:
  // Q'' = 2β²/(min(W)³·Δ), ошибка сопряжения ≤ max(W)·max(W0,W1)·|Δ|·h²·|Q''|/8.
  // Арифметика и логический cap сохраняются; пока допуск не завершён, Q не нужен.
  // Общая граница и её ширина принадлежат предыдущему сегменту. Это исключает
  // повторные вычисления ширины и вторую копию точки в Q, A и обеих CSS-строках.
  let a = 0;
  let wA = fromWidth;
  // P(0)=0 ⇒ W(0)=fromWidth. Reciprocal вычисляется только после полного допуска.
  const knots: number[] = [a, wA];
  for (let i = 0; i < count - 1; i++) {
    const stack: number[] = [samples[(i + 1) * 2]];
    while (stack.length > 0) {
      const b = stack.pop()!;
      // Левый конец уже проверен. Правый вычисляется один раз для сертификата,
      // Q и следующего интервала; арифметика прежнего бонда не переставляется.
      const wB = widthAt(b, i);
      const h = b - a;
      const beta = Math.abs(wB - wA) / h;
      const wMin = Math.min(wA, wB);
      const maxW = Math.max(wA, wB);
      const contentW = Math.max(fromWidth, toWidth);
      const qErr = (h * h / 8) * (2 * beta * beta) / (wMin * wMin * wMin) / Math.abs(delta);
      if (wMin <= 0 || maxW * contentW * Math.abs(delta) * qErr > couplingBudgetPx) {
        const mid = (a + b) / 2;
        // Дальше делить некуда, а бюджет не выполнен: доказательство
        // невозможно в double — fail-closed до крупных аллокаций.
        if (mid === a || mid === b) return undefined;
        stack.push(b, mid);
        continue;
      }
      // i общих границ больше не храним, но прежний admission-cap сохраняем.
      if (knots.length / 2 + i >= RECIPROCAL_MAX_STOPS) return undefined;
      knots.push(b, wB);
      a = b;
      wA = wB;
    }
  }

  // Общая позиция узла сериализуется один раз для обеих кривых. Прежняя
  // форма возврата не переносит полное чтение CSS в построение артефакта.
  // До допуска узлы хранят ширину: сертификат не использует Q. После допуска
  // одна эмиссия вычисляет Q, пишет конечный буфер и сериализует обе кривые.
  const blendSamples: number[] = [];
  let reciprocalEasing = 'linear(';
  let blendEasing = 'linear(';
  const stopCount = knots.length / 2;
  for (let i = 0; i < stopCount; i++) {
    const percent = knots[i * 2];
    const q = (1 / knots[i * 2 + 1] - 1 / fromWidth) / delta;
    knots[i * 2 + 1] = q;
    const x = percent / 100;
    const a = (3 - 2 * x) * x * x;
    blendSamples.push(a);
    const position = ` ${percent}%${i < stopCount - 1 ? ', ' : ''}`;
    reciprocalEasing += q + position;
    blendEasing += a + position;
  }
  reciprocalEasing += ')';
  blendEasing += ')';
  const reciprocal = Float64Array.from(knots);

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
