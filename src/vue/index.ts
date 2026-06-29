/**
 * @labpics/motion/vue — Vue 3 bindings for the headless motion engine.
 *
 * Subpath export: import { useSpring, useMotionValue } from '@labpics/motion/vue'
 *
 * Zero runtime dependencies — vue is a peerDependency only.
 * CSS-safe: only finite values emitted.
 * Compatible with Vue 3 Composition API.
 *
 * Reduced-motion policy (northInvariant #5):
 *   When window.matchMedia('(prefers-reduced-motion: reduce)').matches:
 *   - 'instant' (default): value jumps to target immediately without spring animation.
 *   - 'fade': value jumps to target immediately; caller is expected to apply a
 *     short CSS `transition: opacity 0.2s` on the element for a soft CHARACTER.
 *   Both modes change CHARACTER, not hard-off: the element always reaches the
 *   target; only the interpolation style changes.
 */

import { ref, watch, onUnmounted, type Ref } from 'vue';
import { MotionValue, type MotionValueOptions } from '../motion-value.js';
import { type SpringParams } from '../spring.js';

// ─── Reduced-motion detection ─────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ─── useMotionValue ───────────────────────────────────────────────────────

/**
 * Creates a stable MotionValue instance, cleaned up on component unmount.
 *
 * @param initial - Initial numeric value. Must be finite.
 * @param spring  - Spring physics parameters.
 * @param requestFrame - Injectable rAF seam for deterministic testing.
 *
 * @example
 * ```ts
 * const mv = useMotionValue(0, { mass: 1, stiffness: 200, damping: 20 });
 * mv.setTarget(100);
 * ```
 */
export function useMotionValue(
  initial: number,
  spring: SpringParams = { mass: 1, stiffness: 200, damping: 20 },
  requestFrame?: MotionValueOptions['requestFrame'],
): MotionValue {
  const mv = new MotionValue({ initial, spring, requestFrame });

  try {
    onUnmounted(() => {
      mv.destroy();
    });
  } catch {
    // Called outside component context (e.g. tests) — no lifecycle hook available.
  }

  return mv;
}

// ─── useSpring ────────────────────────────────────────────────────────────

/**
 * Animates a numeric value toward a reactive `target` using spring physics.
 *
 * Watches the `target` ref/getter and smoothly re-animates on change (velocity
 * is preserved across re-targeting — no jank).
 *
 * Reduced-motion behaviour:
 *   If `prefers-reduced-motion: reduce` is active, the CHARACTER changes:
 *   - reducedMotionMode = 'instant' (default): value snaps to target immediately.
 *   - reducedMotionMode = 'fade': value jumps to target; caller applies CSS transition.
 *   In both cases the element still reaches the target — only the style changes.
 *
 * @param target - A Vue ref or getter returning the target numeric value.
 * @param spring - Spring physics parameters.
 * @param reducedMotionMode - 'instant' | 'fade'. Default: 'instant'.
 * @param requestFrame - Injectable rAF seam for deterministic testing.
 * @returns A readonly Vue ref with the current animated value.
 *
 * @example
 * ```vue
 * <script setup>
 * import { ref } from 'vue';
 * import { useSpring } from '@labpics/motion/vue';
 *
 * const open = ref(false);
 * const x = useSpring(() => open.value ? 100 : 0, { mass: 1, stiffness: 300, damping: 30 });
 * </script>
 *
 * <template>
 *   <div :style="{ transform: `translateX(${x}px)` }" />
 *   <button @click="open = !open">Toggle</button>
 * </template>
 */
export function useSpring(
  target: Ref<number> | (() => number),
  spring: SpringParams = { mass: 1, stiffness: 200, damping: 20 },
  reducedMotionMode: 'instant' | 'fade' = 'instant',
  requestFrame?: MotionValueOptions['requestFrame'],
): Readonly<Ref<number>> {
  const initial = typeof target === 'function' ? target() : target.value;
  const mv = useMotionValue(initial, spring, requestFrame);

  // Reactive ref that tracks the animated value.
  const value = ref<number>(initial);

  // Subscribe to MotionValue changes.
  const unsub = mv.onChange((v) => {
    value.value = v;
  });

  try {
    onUnmounted(() => {
      unsub();
    });
  } catch {
    // Outside component context — subscriber will be cleaned up by mv.destroy().
  }

  // Watch target changes and drive animation.
  const targetGetter = typeof target === 'function' ? target : () => target.value;

  watch(targetGetter, (newTarget) => {
    if (prefersReducedMotion()) {
      // CHARACTER switch: skip spring, snap to target immediately.
      // 'instant': direct snap.
      // 'fade': same from binding side — caller applies CSS opacity transition.
      value.value = newTarget;
      void reducedMotionMode; // acknowledged — mode changes caller CSS, not binding behavior
    } else {
      mv.setTarget(newTarget);
    }
  });

  return value;
}
