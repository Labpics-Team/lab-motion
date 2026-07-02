/**
 * @labpics/motion/vue — Vue 3 bindings for the headless motion engine.
 *
 * Subpath export: import { useSpring, useMotionValue, vMotion } from '@labpics/motion/vue'
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
 *
 * v-motion directive:
 *   Declarative spring animation on a DOM element.
 *   Usage:
 *     <div v-motion="{ target: 100, property: 'opacity' }" />
 *     <div v-motion="{ target: x, property: 'transform', template: 'translateX({v}px)' }" />
 *   The directive delegates DOM writes to the onStep callback (MotionValue/onStep
 *   boundary) — the motion core remains zero-DOM.
 *   SSR-safe: no window/document access on import.
 */

import { ref, watch, onUnmounted, type Ref, type ObjectDirective } from 'vue';
import type { MotionValue, MotionValueOptions, RequestFrameFn } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
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
  const mv = createBoundValue({ initial, spring, requestFrame });

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

// ─── v-motion directive ───────────────────────────────────────────────────

/**
 * Options accepted by the v-motion directive's binding value.
 *
 * @example
 * ```vue
 * <!-- Animate opacity 0→1 with spring -->
 * <div v-motion="{ target: 1, property: 'opacity', from: 0 }" />
 *
 * <!-- Animate translateX with a template string -->
 * <div v-motion="{ target: 200, property: 'transform', template: 'translateX({v}px)' }" />
 *
 * <!-- Custom spring params -->
 * <div v-motion="{ target: 1, property: 'opacity', spring: { mass: 1, stiffness: 300, damping: 28 } }" />
 * ```
 */
export interface MotionDirectiveValue {
  /** Target numeric value to animate toward. Required. */
  target: number;
  /**
   * CSS property name to write (e.g. 'opacity', 'transform').
   * Default: 'opacity'.
   */
  property?: string;
  /**
   * Template string for the CSS value. Use `{v}` as placeholder for the
   * animated number. Default: '{v}' (writes the raw number as a string).
   * Example: 'translateX({v}px)', 'scale({v})', 'rgba(0,0,0,{v})'.
   */
  template?: string;
  /** Initial value for the animation. Defaults to the element's current computed style. */
  from?: number;
  /** Spring physics parameters. */
  spring?: SpringParams;
  /**
   * Reduced-motion character mode.
   * 'instant': snap immediately (default).
   * 'fade':    snap immediately; add `transition: opacity 0.2s` in CSS for soft CHARACTER.
   */
  reducedMotionMode?: 'instant' | 'fade';
  /**
   * Injectable requestAnimationFrame seam (for deterministic testing).
   * If omitted, uses global requestAnimationFrame.
   */
  requestFrame?: RequestFrameFn;
}

/** Internal per-element state stored in the WeakMap. */
interface DirectiveState {
  mv: MotionValue;
  unsub: () => void;
  property: string;
  template: string;
  reducedMotionMode: 'instant' | 'fade';
}

/**
 * Per-element state registry (WeakMap — GC-friendly, no DOM attribute pollution,
 * SSR-safe: created on first mount only inside mounted hook).
 */
const _directiveState = new WeakMap<Element, DirectiveState>();

/**
 * Apply the animated value to the element's style.
 * Delegation boundary: this is the ONLY place that writes to the DOM.
 * The motion core (MotionValue / spring solver) remains zero-DOM.
 * SSR/Node-safe: checks for HTMLElement existence before accessing `.style`.
 */
function _applyValue(el: Element, value: number, property: string, template: string): void {
  // Guard: el must have a `.style` property (HTMLElement in browser, or stub in tests).
  // Avoids `instanceof HTMLElement` which throws ReferenceError in Node/SSR environments.
  const style = (el as unknown as { style?: Record<string, string> }).style;
  if (!style || typeof style !== 'object') return;
  const cssValue = template.includes('{v}') ? template.replace('{v}', String(value)) : String(value);
  // Write via CSSStyleDeclaration key-access (handles camelCase and shorthand props).
  style[property] = cssValue;
}

/**
 * Vue 3 custom directive: `v-motion`
 *
 * Declaratively animates a CSS property on a DOM element using spring physics.
 * Writes to the DOM only via the `onChange` callback — the motion core is zero-DOM.
 * SSR-safe: mounted/updated/unmounted hooks only run client-side (Vue skips them on SSR).
 * reduced-motion: switches CHARACTER to instant snap, never hard-off.
 *
 * Registration (global):
 * ```ts
 * import { vMotion } from '@labpics/motion/vue';
 * app.directive('motion', vMotion);
 * ```
 *
 * Registration (local):
 * ```vue
 * <script setup>
 * import { vMotion } from '@labpics/motion/vue';
 * const vMotionDir = vMotion; // Vue picks up directives named v* in setup
 * </script>
 * ```
 */
export const vMotion: ObjectDirective<Element, MotionDirectiveValue> = {
  mounted(el: Element, binding: { value: MotionDirectiveValue }) {
    const opts: MotionDirectiveValue = binding.value;
    const property = opts.property ?? 'opacity';
    const template = opts.template ?? '{v}';
    const reducedMotionMode = opts.reducedMotionMode ?? 'instant';
    const springParams: SpringParams = opts.spring ?? { mass: 1, stiffness: 200, damping: 20 };

    // Resolve initial value: explicit `from`, else current computed style, else target.
    let initial: number;
    if (opts.from !== undefined && Number.isFinite(opts.from)) {
      initial = opts.from;
    } else {
      initial = opts.target; // Start at target if no `from` provided (no-op until first retarget)
    }

    const mv = createBoundValue({
      initial,
      spring: springParams,
      requestFrame: opts.requestFrame,
    });

    // Delegate DOM write to onChange — the ONLY path that touches the DOM.
    const unsub = mv.onChange((v) => {
      _applyValue(el, v, property, template);
    });

    _directiveState.set(el, { mv, unsub, property, template, reducedMotionMode });

    // Start animating toward the initial target.
    if (prefersReducedMotion()) {
      // CHARACTER: instant snap — apply directly, no spring frames.
      _applyValue(el, opts.target, property, template);
    } else {
      mv.setTarget(opts.target);
    }
  },

  updated(el: Element, binding: { value: MotionDirectiveValue }) {
    const state = _directiveState.get(el);
    if (!state) return; // unmounted or SSR — no-op

    const newTarget = binding.value.target;
    // Update property/template if they changed in the new binding value.
    const property = binding.value.property ?? 'opacity';
    const template = binding.value.template ?? '{v}';
    state.property = property;
    state.template = template;
    state.reducedMotionMode = binding.value.reducedMotionMode ?? 'instant';

    if (prefersReducedMotion()) {
      // CHARACTER switch: instant snap to new target.
      // 'fade' mode: caller adds CSS `transition: opacity 0.2s` — this binding
      // just writes the final value and lets the browser's CSS transition handle it.
      _applyValue(el, newTarget, property, template);
    } else {
      state.mv.setTarget(newTarget);
    }
  },

  unmounted(el: Element) {
    const state = _directiveState.get(el);
    if (!state) return;
    state.unsub();
    state.mv.destroy();
    _directiveState.delete(el);
  },
};
