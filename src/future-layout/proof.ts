/**
 * src/future-layout/proof.ts — diagnostics-слой сопряжённой поверхности.
 *
 * Fail-fast обёртки, позитивный сертификат, constant-effects plan и keyframes
 * хелперы. Это НЕ runtime-путь animate(..., { layout: 'project' }): модуль
 * вынесен из production-графа, чтобы диагностика не платила import-cost
 * фасада (спека SIZE: «Раздели diagnostics и production»).
 */

import { MotionParamError } from '../errors.js';
import type { SpringParams } from '../spring.js';
import {
  tryCompileSurfaceArtifact,
  type SurfaceExecutionArtifact,
} from './artifact.js';

export interface SurfacePlan {
  readonly artifact: SurfaceExecutionArtifact;
  /** Постоянное число native effects, не зависит от числа строк. */
  readonly effectCount: number;
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
