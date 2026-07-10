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

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
} from 'react';
import type { MotionValue, MotionValueOptions, RequestFrameFn } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
import { type SpringParams } from '../spring.js';
import { createMotionConfig } from '../a11y/index.js';

/**
 * useLayoutEffect on the client, useEffect on the server. Effect-binding must
 * write the controlled style SYNCHRONOUSLY before paint (no entrance flash), but
 * useLayoutEffect warns during SSR — so degrade to useEffect where there is no
 * DOM (effects don't run during renderToString anyway).
 */
const useIsoLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

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
  const { target, reducedMotionMode } = options;

  // Latest options read by the (stable) helpers below — property/template/spring
  // are always current without re-subscribing.
  const optsRef = useRef(options);
  optsRef.current = options;

  // MotionValue owns the frame loop; the bound element lives in a ref.
  const mvRef = useRef<MotionValue | null>(null);
  const elRef = useRef<HTMLElement | null>(null);

  // Lazily (re)create the MotionValue. StrictMode runs effect setup→cleanup→setup
  // WITHOUT re-rendering, so the cleanup that destroys+nulls the MV must be
  // recoverable here — otherwise the second setup would deref a destroyed value.
  // One live MV at a time (the previous is destroyed before this creates a new).
  const ensureMv = useCallback((): MotionValue => {
    if (mvRef.current === null) {
      const o = optsRef.current;
      mvRef.current = createBoundValue({
        initial: o.from ?? o.target,
        spring: o.spring ?? { mass: 1, stiffness: 200, damping: 20 },
        requestFrame: o.requestFrame,
      });
    }
    return mvRef.current;
  }, []);

  // Delegation boundary: write the animated number into the bound element's style
  // using the CURRENT property/template. Re-reads elRef each frame so it survives
  // ref reassignment. NO setState → zero component renders.
  const write = useCallback((v: number): void => {
    const o = optsRef.current;
    _applyValue(elRef.current, v, o.property ?? 'opacity', o.template ?? '{v}');
  }, []);

  // First-frame stability: create eagerly on the initial render.
  ensureMv();

  // Subscribe before paint (layout effect: initial `from` write lands
  // synchronously, no entrance flash). Refs attach during commit, before effects,
  // so elRef.current is set. Cleanup unsubscribes + destroys + nulls; ensureMv
  // above makes a StrictMode remount recreate cleanly.
  useIsoLayoutEffect(() => {
    const mv = ensureMv();
    write(mv.value);
    const unsub = mv.onChange(write);
    return () => {
      unsub();
      mv.destroy();
      mvRef.current = null;
    };
  }, [ensureMv, write]);

  // Drive animation on target change (velocity preserved). reduced-motion snaps
  // via snapTo — NOT a bare DOM write: snapTo stops any live run and resyncs the
  // MotionValue's value/velocity, so a still-running spring can't clobber the snap
  // and a later non-reduced retarget springs from the snapped value, not stale
  // state. snapTo emits → subscription writes the DOM. Parity with lit/vue.
  useIsoLayoutEffect(() => {
    if (prefersReducedMotion()) {
      ensureMv().snapTo(target);
      void reducedMotionMode; // mode changes caller CSS, not binding behaviour
    } else {
      ensureMv().setTarget(target);
    }
  }, [target, reducedMotionMode, ensureMv]);

  // Stable ref callback: records the element and, on attach, writes the CURRENT
  // value immediately. The write matters for late/conditional attach (e.g.
  // `{shown && <div ref={ref} />}`): the layout effect's initial write no-ops
  // when no element is mounted yet, so without this the element would appear
  // unstyled (missing its `from`/current value) until the next retarget/frame.
  // Idempotent with the layout-effect write; still no setState → zero renders.
  return useCallback(
    (el: HTMLElement | null) => {
      elRef.current = el;
      if (el !== null) write(ensureMv().value);
    },
    [ensureMv, write],
  );
}

// ─── useReducedMotion (#104) ───────────────────────────────────────────────

/**
 * Resolve the matchMedia seam: explicit arg, else the browser's, else undefined
 * (SSR/Node — no window). Injectable for deterministic tests (repo law: no jsdom
 * for unit-level determinism).
 */
function _resolveMatchMedia(
  mm: ((q: string) => MediaQueryList) | undefined,
): ((q: string) => MediaQueryList) | undefined {
  if (typeof mm === 'function') return mm;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia.bind(window);
  }
  return undefined;
}

const _REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Reactively reflect the system `prefers-reduced-motion: reduce` preference,
 * re-rendering the component when the user toggles it mid-session.
 *
 * Built on `useSyncExternalStore`, so it is hydration-safe: the server snapshot
 * is always `false` (matching SSR markup — no media query on the server), and
 * the real client value is read after commit. The reactive subscription REUSES
 * `../a11y` `createMotionConfig` (system matchMedia 'change' listener + legacy
 * `addListener` fallback + leak-safe `destroy()`) — no duplicated listener wiring.
 *
 * SSR/Node-safe: returns `false` when there is no `matchMedia`. Thin: owns no
 * physics/tokens/scheduler.
 *
 * @param matchMedia - Injectable matchMedia seam (default: `window.matchMedia`).
 *   Pass a STABLE reference (or omit it): a freshly-allocated function each render
 *   makes `useSyncExternalStore` tear down and re-create the subscription every
 *   render (wasteful churn — not a leak or loop). Omitting it uses the stable
 *   browser seam.
 * @returns `true` when reduced motion is preferred, else `false`.
 *
 * @example
 * ```tsx
 * function Fade({ show }: { show: boolean }) {
 *   const reduced = useReducedMotion();
 *   const ref = useMotionStyle({ target: show ? 1 : 0, property: 'opacity', from: 0 });
 *   return <div ref={ref} />; // reduced ? мгновенно : пружиной (см. useMotionStyle)
 * }
 * ```
 */
export function useReducedMotion(matchMedia?: (q: string) => MediaQueryList): boolean {
  // Subscribe via a11y config (reuses the change-listener machinery + destroy).
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const mm = _resolveMatchMedia(matchMedia);
      if (mm === undefined) return () => {};
      const cfg = createMotionConfig({ reducedMotion: 'system', matchMedia: mm });
      const unsub = cfg.onChange(() => onStoreChange());
      return () => {
        unsub();
        cfg.destroy();
      };
    },
    [matchMedia],
  );

  // Snapshot is a PURE read (no listener added) so it is safe during render.
  const getSnapshot = useCallback((): boolean => {
    const mm = _resolveMatchMedia(matchMedia);
    if (mm === undefined) return false;
    try {
      return mm(_REDUCE_QUERY).matches === true;
    } catch {
      return false;
    }
  }, [matchMedia]);

  // Hydration: server (and the initial hydrating client render) sees `false`,
  // matching the server markup; the real value lands after commit.
  const getServerSnapshot = (): boolean => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ─── useVelocity / useTransform (render-value derivations, #104) ────────────

/**
 * Read the live **velocity** (units·s⁻¹) of a {@link MotionValue} as a render
 * value: re-renders each frame the value moves, and settles at exactly `0` at
 * rest (analytic velocity from the solver — the same seam that powers C¹
 * handoff, #93). Pair with {@link useMotionValue}.
 *
 * This is a *render value* (like {@link useSpring}) — use it when the number
 * participates in render. For zero-render style writes, drive a second
 * {@link useMotionStyle} instead. Thin: subscribes to `onChange`, owns nothing.
 *
 * @example
 * ```tsx
 * const mv = useMotionValue(0);
 * const v = useVelocity(mv); // e.g. skew by velocity: `skewX(${v * 0.02}deg)`
 * ```
 */
export function useVelocity(value: MotionValue): number {
  const [v, setV] = useState<number>(() => value.velocity);
  useEffect(() => {
    // onChange emits the current value immediately, then on every frame; read
    // the live velocity each time. Cleanup unsubscribes (StrictMode-safe: one
    // live subscription after setup→cleanup→setup).
    return value.onChange(() => setV(value.velocity));
  }, [value]);
  return v;
}

/**
 * Map a {@link MotionValue}'s value through `transform` and read the result as
 * a render value, re-rendering when the mapped output changes. The classic
 * derive-one-channel-from-another primitive (e.g. opacity from x).
 *
 * Output always reflects `transform(value)`: the effect re-subscribes when
 * `value` OR `transform` identity changes, and `onChange`'s immediate-emit
 * recomputes with the current fn — so swapping `transform` while the value is at
 * rest updates the result (no staleness). Pass a stable `transform` (e.g.
 * `useCallback`) to avoid a cheap per-render re-subscribe when it's an inline fn.
 *
 * @example
 * ```tsx
 * const x = useMotionValue(0);
 * const opacity = useTransform(x, (px) => Math.max(0, 1 - Math.abs(px) / 200));
 * ```
 */
export function useTransform(value: MotionValue, transform: (v: number) => number): number {
  const [out, setOut] = useState<number>(() => transform(value.value));
  useEffect(() => {
    return value.onChange((v) => setOut(transform(v)));
  }, [value, transform]);
  return out;
}
