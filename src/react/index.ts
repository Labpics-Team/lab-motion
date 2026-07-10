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

import { useState, useEffect, useRef, useCallback } from 'react';
import type { MotionValue, MotionValueOptions, RequestFrameFn } from '../motion-value.js';
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

// ─── useMotionStyle (effect binding, #104) ─────────────────────────────────

/**
 * Options for {@link useMotionStyle}. Mirrors the Vue `v-motion` directive
 * value so both thin adapters expose the same declarative contract.
 */
export interface MotionStyleOptions {
  /** Target numeric value to animate toward. Changing it re-animates. */
  target: number;
  /** CSS property to write (e.g. 'opacity', 'transform'). Default: 'opacity'. */
  property?: string;
  /**
   * Template for the CSS value. `{v}` is the animated number.
   * Default: '{v}' (writes the raw number). Example: 'translateX({v}px)'.
   */
  template?: string;
  /** Initial value. Default: `target` (static until the first retarget). */
  from?: number;
  /** Spring physics parameters. */
  spring?: SpringParams;
  /** Reduced-motion character mode. 'instant' (default) | 'fade'. */
  reducedMotionMode?: 'instant' | 'fade';
  /** Injectable requestAnimationFrame seam (deterministic testing). */
  requestFrame?: RequestFrameFn;
}

/**
 * Write the animated value into an element's style. Delegation boundary — the
 * ONLY place this hook touches the DOM (motion core stays zero-DOM). SSR/Node
 * safe: duck-checks a `.style` object instead of `instanceof HTMLElement`.
 */
function _applyValue(el: unknown, value: number, property: string, template: string): void {
  const style = (el as { style?: Record<string, string> } | null)?.style;
  if (!style || typeof style !== 'object') return;
  style[property] = template.includes('{v}') ? template.replace('{v}', String(value)) : String(value);
}

/**
 * **Effect binding** (the #104 core): drives a CSS property from a spring
 * WITHOUT re-rendering the component on every frame. Unlike {@link useSpring}
 * (a *render value* — the component re-renders each frame to reflect the
 * number), `useMotionStyle` owns a {@link MotionValue} and writes straight to
 * the element's style inside the subscription callback. The component renders
 * only when `target` (a prop it already owns) changes — never per frame.
 *
 * Returns a stable React ref callback: attach it to the element you want to
 * animate. Cleanup (unsubscribe + destroy) happens on unmount; re-targeting
 * preserves velocity (smooth pickup, C¹). reduced-motion switches CHARACTER to
 * an instant snap (no frames), never hard-off.
 *
 * @example
 * ```tsx
 * function Box({ open }: { open: boolean }) {
 *   const ref = useMotionStyle({
 *     target: open ? 200 : 0,
 *     property: 'transform',
 *     template: 'translateX({v}px)',
 *     from: 0,
 *   });
 *   return <div ref={ref} />; // никакого render на кадр
 * }
 * ```
 */
export function useMotionStyle(options: MotionStyleOptions): (el: HTMLElement | null) => void {
  const { target, property = 'opacity', template = '{v}', from, spring, reducedMotionMode } = options;

  // Latest property/template read by the subscription and retarget paths.
  const propRef = useRef(property);
  propRef.current = property;
  const tplRef = useRef(template);
  tplRef.current = template;

  // Stable MotionValue (owns the frame loop) + the bound element + unsubscribe.
  const mvRef = useRef<MotionValue | null>(null);
  if (mvRef.current === null) {
    mvRef.current = createBoundValue({
      initial: from ?? target,
      spring: spring ?? { mass: 1, stiffness: 200, damping: 20 },
      requestFrame: options.requestFrame,
    });
  }
  const elRef = useRef<HTMLElement | null>(null);

  // Subscribe once after mount: refs are attached during commit, before passive
  // effects, so elRef.current is already set. onChange re-reads elRef each frame
  // so it survives ref reassignment. NO setState → zero component renders.
  useEffect(() => {
    const mv = mvRef.current!;
    _applyValue(elRef.current, mv.value, propRef.current, tplRef.current);
    const unsub = mv.onChange((v) => {
      _applyValue(elRef.current, v, propRef.current, tplRef.current);
    });
    return () => {
      unsub();
      mv.destroy();
      mvRef.current = null;
    };
  }, []);

  // Drive animation on target change (velocity preserved). reduced-motion snaps.
  useEffect(() => {
    const mv = mvRef.current;
    if (mv === null) return;
    if (prefersReducedMotion()) {
      _applyValue(elRef.current, target, propRef.current, tplRef.current);
      void reducedMotionMode; // mode changes caller CSS, not binding behaviour
    } else {
      mv.setTarget(target);
    }
  }, [target, reducedMotionMode]);

  // Stable ref callback: only records the element; subscription lifecycle lives
  // in the effects above. Stable identity → React invokes it on mount/unmount
  // only, never on re-render.
  return useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);
}
