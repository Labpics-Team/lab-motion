/**
 * @labpics/motion — dependency-free motion engine.
 *
 * Public API (invariant 6 — pinned by api-surface-pin.test.ts):
 *   spring         — L1 pure spring physics solver
 *   tween          — L1 pure linear interpolation
 *   drive          — L3 declarative animation driver (reduced-motion-aware)
 *   MotionValue    — L3 headless reactive value (spring + smooth pickup)
 *   MotionParamError — typed domain boundary error
 *
 * Zero runtime dependencies. CSS-safe (no NaN/Infinity emitted).
 * Deterministic. Reduced-motion honoured at every entry point.
 */

export { MotionParamError, type MotionParamErrorCode } from './errors.js';
export {
  type SpringParams,
  type SpringResult,
  spring,
  validateSpringParams,
  validateSpringPhysics,
} from './spring.js';
export { tween } from './tween.js';
export { type DriveOptions, drive } from './drive.js';
export {
  type RequestFrameFn,
  type MotionValueOptions,
  MotionValue,
} from './motion-value.js';
