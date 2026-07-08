/**
 * animate.ts — DX sugar on top of drive() + tokens.
 * SSR-safe, reduced-motion aware (via injected matchMedia), zero deps.
 * Perf: thin pass-through, no extra allocations on hot path beyond drive.
 */

import { drive, type DriveOptions } from './drive.js';
import { type SpringParams } from './spring.js';

export interface AnimateOptions extends Omit<DriveOptions, 'spring'> {
  /** Spring overrides; defaults to snappy design-system friendly. */
  spring?: SpringParams;
}

/**
 * animate() — convenient wrapper.
 * Same contract as drive, but provides a default spring if omitted.
 * Use for simple cases; for full control use drive directly.
 */
export function animate(opts: AnimateOptions): Promise<void> {
  const spring: SpringParams = opts.spring ?? { mass: 1, stiffness: 120, damping: 18 };
  return drive({ ...opts, spring });
}
