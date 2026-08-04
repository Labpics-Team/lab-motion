/**
 * src/future-layout/index.ts — внутренний модуль сопряжённых поверхностей.
 *
 * НЕ package export и НЕ новый runtime-tier (спека «COMPILER»): публичная
 * поверхность остаётся animate(..., { layout: 'project' }); сюда попадает
 * домен (serialized P → reciprocal Q → monotonic A, positivity certificate,
 * SurfaceExecutionArtifact), transaction/coordinator, VT-host и observer.
 */

export {
  compileSurfaceArtifact,
  certifyPositivity,
  outerScaleKeyframes,
  planeScaleKeyframes,
  planSurface,
  tryCompileSurfaceArtifact,
  RECIPROCAL_MAX_STOPS,
  SURFACE_PRECISION_BUDGET_PX,
  type SurfaceExecutionArtifact,
  type SurfacePlan,
} from './artifact.js';
