/**
 * @labpics/motion/react — React bindings for the headless motion engine.
 *
 * Subpath export: import { useMotionValue, useSpring } from '@labpics/motion/react'
 *
 * Zero runtime dependencies — react is a peerDependency only.
 * CSS-safe: only finite values emitted.
 * Deterministic via injectable requestFrame seam (same contract as MotionValue).
 *
 * Reduced-motion policy (northInvariant #5):
 *   When window.matchMedia('(prefers-reduced-motion: reduce)').matches:
 *   - 'instant' mode (default): value snaps immediately to target without animation.
 *   - 'fade' mode: caller is expected to apply a short CSS transition on their element;
 *     the hook emits the final value immediately so the element can transition via CSS.
 *   Both modes switch CHARACTER, not hard-off — the element still reaches the target
 *   value visually; only the motion style changes (spring vs instant).
 */

import { useState, useEffect, useRef } from 'react';
import type { MotionValue, MotionValueOptions } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
import { type SpringParams } from '../spring.js';

// ─── Reduced-motion detection ─────────────────────────────────────────────

/**
 * Detects the current prefers-reduced-motion preference.
 * Returns false in SSR / non-browser environments (no preference → full motion).
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ─── useMotionValue ───────────────────────────────────────────────────────

/**
 * Creates a stable MotionValue instance that animates toward its current target.
 *
 * The MotionValue is created once and destroyed on unmount. To animate, call
 * `mv.setTarget(newValue)`.
 *
 * @param initial - Initial numeric value. Must be finite.
 * @param spring  - Spring physics parameters.
 * @param requestFrame - Injectable rAF seam (default: global requestAnimationFrame).
 *
 * @example
 * ```tsx
 * const mv = useMotionValue(0, { mass: 1, stiffness: 200, damping: 20 });
 * mv.setTarget(100); // animate to 100
 * ```
 */
export function useMotionValue(
  initial: number,
  spring: SpringParams = { mass: 1, stiffness: 200, damping: 20 },
  requestFrame?: MotionValueOptions['requestFrame'],
): MotionValue {
  const mvRef = useRef<MotionValue | null>(null);

  if (mvRef.current === null) {
    mvRef.current = createBoundValue({ initial, spring, requestFrame });
  }

  useEffect(() => {
    return () => {
      mvRef.current?.destroy();
      mvRef.current = null;
    };
  }, []);

  return mvRef.current;
}

// ─── useSpring ────────────────────────────────────────────────────────────

/**
 * Animates a numeric value toward `target` using spring physics.
 *
 * Re-targeting mid-flight preserves velocity (smooth pickup).
 *
 * Reduced-motion behaviour:
 *   If `prefers-reduced-motion: reduce` is active, the CHARACTER of the
 *   animation changes:
 *   - reducedMotionMode = 'instant' (default): value snaps to target immediately
 *     (no spring, no delay — the DOM update is atomic).
 *   - reducedMotionMode = 'fade': value is emitted at target immediately;
 *     the caller should apply a short CSS `transition: opacity 0.2s` on their
 *     element for a soft fade instead of motion.
 *   In both cases the animation does not hard-off — the element still reaches
 *   the target value on every render cycle; only the physical interpolation
 *   style is changed.
 *
 * @param target - The value to animate toward. Changing this triggers re-animation.
 * @param spring - Spring physics parameters.
 * @param reducedMotionMode - 'instant' | 'fade'. Default: 'instant'.
 * @param requestFrame - Injectable rAF seam for deterministic testing.
 * @returns The current animated value (starts at `target` on first render).
 *
 * @example
 * ```tsx
 * function Box({ open }: { open: boolean }) {
 *   const x = useSpring(open ? 100 : 0, { mass: 1, stiffness: 300, damping: 30 });
 *   return <div style={{ transform: `translateX(${x}px)` }} />;
 * }
 * ```
 */
export function useSpring(
  target: number,
  spring: SpringParams = { mass: 1, stiffness: 200, damping: 20 },
  reducedMotionMode: 'instant' | 'fade' = 'instant',
  requestFrame?: MotionValueOptions['requestFrame'],
): number {
  const [value, setValue] = useState<number>(target);
  const mv = useMotionValue(target, spring, requestFrame);

  // Subscribe to value changes.
  useEffect(() => {
    return mv.onChange((v) => {
      setValue(v);
    });
  }, [mv]);

  // Drive animation on target change.
  useEffect(() => {
    if (prefersReducedMotion()) {
      // CHARACTER switch: skip spring, emit target value immediately.
      // 'instant': snap (no CSS transition expected from caller).
      // 'fade': snap value but caller is expected to apply CSS opacity transition.
      setValue(target);
    } else {
      mv.setTarget(target);
    }
  }, [mv, target, reducedMotionMode]);

  return value;
}
