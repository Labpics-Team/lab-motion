/**
 * @labpics/motion/svelte — Svelte bindings for the headless motion engine.
 *
 * Subpath export: import { springStore } from '@labpics/motion/svelte'
 *
 * Zero runtime dependencies — svelte is a peerDependency only.
 * CSS-safe: only finite values emitted via the store.
 * Compatible with Svelte 4 readable/writable store contract.
 *
 * Reduced-motion policy (northInvariant #5):
 *   When window.matchMedia('(prefers-reduced-motion: reduce)').matches:
 *   - 'instant' (default): new target value is emitted synchronously to subscribers
 *     without spring animation (CHARACTER = snap).
 *   - 'fade': same as instant from the store perspective; caller applies a
 *     short CSS transition on the consuming element for a fade effect.
 *   Both modes change CHARACTER, not hard-off: the value always reaches the
 *   target; only the interpolation style changes.
 */

import { MotionValue, type MotionValueOptions } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
import { type SpringParams } from '../spring.js';

// ─── Reduced-motion detection ─────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ─── Svelte store interface ───────────────────────────────────────────────

/**
 * A Svelte-compatible store that animates toward its target value using spring physics.
 *
 * Implements the Svelte store contract: `{ subscribe, set }`.
 * Also exposes `destroy()` for cleanup in `onDestroy`.
 */
export interface SpringStore {
  /**
   * Svelte store subscription. Receives every animated frame value.
   * Calls `run` immediately with the current value on subscribe.
   * Returns an unsubscribe function (Svelte auto-unsubscribes with `$` syntax).
   */
  subscribe(run: (value: number) => void): () => void;

  /**
   * Set a new target value. The store animates toward it using spring physics.
   *
   * When `prefers-reduced-motion: reduce` is active, CHARACTER switches:
   * - 'instant': value snaps to `target` synchronously without spring.
   * - 'fade': value jumps to `target`; caller applies CSS opacity transition.
   *
   * @param target - New target value. Must be finite.
   * @param reducedMotionMode - Override per-call. Defaults to store-level setting.
   */
  set(target: number, reducedMotionMode?: 'instant' | 'fade'): void;

  /**
   * Stop all animations and clean up. Call in `onDestroy`.
   */
  destroy(): void;
}

// ─── springStore ──────────────────────────────────────────────────────────

/**
 * Creates a Svelte store that animates a numeric value toward its target
 * using spring physics with smooth velocity pickup on re-target.
 *
 * @param initial - Initial numeric value. Must be finite.
 * @param spring  - Spring physics parameters.
 * @param reducedMotionMode - 'instant' | 'fade'. Default: 'instant'.
 *   Controls CHARACTER of animation when prefers-reduced-motion is active.
 * @param requestFrame - Injectable rAF seam for deterministic testing.
 *
 * @example
 * ```svelte
 * <script>
 *   import { springStore } from '@labpics/motion/svelte';
 *   import { onDestroy } from 'svelte';
 *
 *   const x = springStore(0, { mass: 1, stiffness: 200, damping: 20 });
 *   onDestroy(() => x.destroy());
 * </script>
 *
 * <div style="transform: translateX({$x}px)">Hello</div>
 * <button on:click={() => x.set(100)}>Animate</button>
 * ```
 */
export function springStore(
  initial: number,
  spring: SpringParams = { mass: 1, stiffness: 200, damping: 20 },
  reducedMotionMode: 'instant' | 'fade' = 'instant',
  requestFrame?: MotionValueOptions['requestFrame'],
): SpringStore {
  const mv = createBoundValue({ initial, spring, requestFrame });

  // Maintain a snapshot of current value for immediate emission on subscribe.
  let currentValue: number = initial;

  // Subscriber registry (mirrors Svelte store contract).
  const subscribers = new Set<(value: number) => void>();

  // Listen to MotionValue changes and broadcast to all Svelte subscribers.
  mv.onChange((v) => {
    currentValue = v;
    for (const run of subscribers) {
      run(v);
    }
  });

  return {
    subscribe(run) {
      subscribers.add(run);
      // Emit current value immediately (Svelte store contract).
      run(currentValue);
      return () => {
        subscribers.delete(run);
      };
    },

    set(target, modeOverride) {
      const mode = modeOverride ?? reducedMotionMode;
      if (prefersReducedMotion()) {
        // CHARACTER switch: skip spring, emit synchronously.
        // 'instant': snap. 'fade': same from store side — caller applies CSS.
        currentValue = target;
        for (const run of subscribers) {
          run(target);
        }
      } else {
        mv.setTarget(target);
      }
      void mode; // mode is read above; void prevents lint unused warning
    },

    destroy() {
      mv.destroy();
      subscribers.clear();
    },
  };
}
