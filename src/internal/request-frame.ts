import { FIXED_DT_S } from './constants.js';

/** Один поздний host-lookup не даёт drive и MotionValue разойтись в fallback-семантике. */
export function defaultRequestFrame(cb: (ts?: number) => void): number {
  if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(cb);
  return setTimeout(cb, FIXED_DT_S * 1000) as unknown as number;
}
