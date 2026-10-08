/** Внутреннее численное ядро. Пользовательский root находится в motion/index.ts. */

export { MotionParamError, type MotionParamErrorCode } from './errors.js';
export {
  type SpringParams,
  type SpringResult,
  spring,
  validateSpringParams,
} from './spring.js';
export { tween } from './tween.js';
export { type DriveOptions, drive } from './drive.js';
export {
  type RequestFrameFn,
  type MotionValueOptions,
  MotionValue,
} from './motion-value.js';
