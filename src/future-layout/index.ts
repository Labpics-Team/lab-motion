/**
 * src/future-layout/index.ts — внутренний модуль сопряжённых поверхностей.
 *
 * НЕ package export и НЕ новый runtime-tier (спека «COMPILER»): публичная
 * поверхность остаётся animate(..., { layout: 'project' }); сюда попадает
 * домен (serialized P → reciprocal Q → monotonic A, positivity certificate,
 * SurfaceExecutionArtifact), transaction/coordinator, VT-host и observer.
 */

export {
  tryCompileSurfaceArtifact,
  RECIPROCAL_MAX_STOPS,
  SURFACE_PRECISION_BUDGET_PX,
  type SurfaceExecutionArtifact,
} from './artifact.js';

export {
  certifyPositivity,
  compileSurfaceArtifact,
  outerScaleKeyframes,
  planeScaleKeyframes,
  planSurface,
  type SurfacePlan,
} from './proof.js';

export {
  createSurfaceCoordinator,
  type SurfaceCoordinator,
  type SurfaceGeneration,
  type SurfaceGenerationInput,
} from './coordinator.js';

export {
  createSurfaceObserver,
  type SurfaceFrameView,
  type SurfaceObserver,
  type SurfaceObserverClock,
  type SurfaceOnFrame,
} from './observer.js';

export {
  startSurfaceTransition,
  type SurfaceControls,
  type SurfaceHostLike,
  type SurfaceInputPolicy,
  type SurfaceRunOptions,
  type SurfaceScrollAnchor,
  type SurfaceSeams,
  type SurfaceState,
  type SurfaceTargetLike,
  type SurfaceTier,
} from './transaction.js';
