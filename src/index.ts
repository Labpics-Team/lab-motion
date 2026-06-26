/**
 * @labpics/motion — dependency-free motion engine.
 *
 * Public API (invariant 6 — pinned by api-surface-pin.test.ts):
 *   spring         — L1 pure spring physics solver
 *   tween          — L1 pure linear interpolation
 *   drive          — L3 declarative animation driver (reduced-motion-aware)
 *   MotionParamError — typed domain boundary error
 *
 * Zero runtime dependencies. CSS-safe (no NaN/Infinity emitted).
 * Deterministic. Reduced-motion honoured at every entry point.
 */

export { MotionParamError } from './errors.js';
export {
  type SpringParams,
  type SpringResult,
  spring,
  validateSpringParams,
} from './spring.js';
export { tween } from './tween.js';
export { type DriveOptions, drive } from './drive.js';
export {
  type RGBA,
  hslToRgb,
  parseColor,
  interpolateColor,
  resolveToken,
} from './tokens.js';
