/**
 * errors.ts — typed domain boundary for motion engine errors.
 *
 * L1 Domain / cross-cutting. No DOM, no window, no clock.
 * Only MotionParamError is public; it is the sole error type
 * callers should catch to distinguish invalid inputs from bugs.
 */

/** Thrown when caller-supplied physics parameters are invalid (invariant 2). */
export class MotionParamError extends Error {
  override readonly name = 'MotionParamError';

  constructor(message: string) {
    super(message);
    // Restore prototype chain for instanceof checks across transpilation targets.
    Object.setPrototypeOf(this, MotionParamError.prototype);
  }
}
