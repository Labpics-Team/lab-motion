/**
 * stagger/index.ts — L1 Domain: headless stagger delay distribution.
 *
 * Subpath export: import { stagger } from '@labpics/motion/stagger'
 *
 * Pure function: (count, options) → finite non-negative delay (ms) for each element.
 * Zero DOM — no querySelector, document, window. SSR-safe.
 * No runtime dependencies (easing is injected by caller from @labpics/motion/easing).
 *
 * Invariants:
 *   ST1. Finiteness: every returned delay is a finite non-negative number.
 *        NaN/Infinity in any input (count, gap, easing return) → clamped to 0.
 *   ST2. Zero-DOM: no querySelector/document/window on the import path.
 *   ST3. Reduced-motion CHARACTER-switch: when reducedMotion=true, all delays
 *        collapse to 0. Items still animate — they just start simultaneously.
 *        This is a CHARACTER change (instant snap-to-start), NOT hard-off.
 *   ST4. Deterministic: same inputs → same outputs, bit-identical across platforms.
 *   ST5. count=0 → []. count=1 → [0]. Negative/non-finite → [].
 *   ST6. Availability: count is capped at MAX_STAGGER_COUNT. A hostile or
 *        accidental extreme count (Number.MAX_SAFE_INTEGER, 1e9, ...) is
 *        CLAMPED, not zeroed — the caller still gets a usable bounded array
 *        instead of an OOM/hang from an unbounded Array allocation.
 *
 * @labpics/motion/stagger (subpath-only, tree-shakeable from core bundle)
 */

import {
  MAX_STAGGER_COUNT,
  scheduleStagger,
  type StaggerFrom,
  type StaggerGridOptions,
} from './scheduler.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Origin for stagger distribution — which element(s) start first.
 *
 * - 'first'   : Element 0 starts first; delays increase toward the end.
 * - 'last'    : Last element starts first; delays increase toward the start.
 * - 'center'  : Center element(s) start first; delays increase outward.
 * - 'edges'   : Both edge elements start simultaneously first; delays increase inward.
 * - number    : Specific 0-based index starts first; delays increase outward.
 *               Clamped to [0, count-1] if out of range.
 */
export type { StaggerFrom } from './scheduler.js';

/**
 * Grid layout descriptor for 2D stagger distance calculation.
 * When provided, distances are computed as Euclidean (or border) distances
 * in row/column space rather than 1D linear index distance.
 */
export type { StaggerGridOptions } from './scheduler.js';

/**
 * Options for the stagger() function.
 */
export interface StaggerOptions {
  /**
   * Базовый шаг задержки между соседними элементами в миллисекундах.
   * Неконечное или отрицательное значение заменяется значением по умолчанию.
   * По умолчанию: 50.
   */
  gap?: number;

  /**
   * Origin of stagger — which element(s) start first (delay = 0).
   * See StaggerFrom type for details.
   * Default: 'first'.
   */
  from?: StaggerFrom;

  /**
   * Easing applied to the [0,1] normalized position of each element.
   * position 0 = closest to origin (smallest delay).
   * position 1 = farthest from origin (largest delay).
   * Default: linear (identity).
   *
   * Tip: import from '@labpics/motion/easing' — e.g. easeOut, circOut, etc.
   * Non-finite return from easing → treated as 0 (delay clamped).
   */
  easing?: (t: number) => number;

  /**
   * 2D grid layout for distance calculation.
   * When provided, elements are treated as a grid with `columns` per row.
   * Distance from origin is Euclidean (row/col); 'edges' uses min border distance.
   */
  grid?: StaggerGridOptions;

  /**
   * Reduced-motion CHARACTER-switch (northInvariant #5).
   *
   * When true: all delays collapse to 0 — the stagger offset is removed.
   * Items still animate to their targets; they just start simultaneously.
   * This is NOT a hard-off — animation still occurs, only the delay CHARACTER changes.
   *
   * Caller should detect `window.matchMedia('(prefers-reduced-motion: reduce)')` and
   * pass the result here. stagger() itself is DOM-free (ST2).
   *
   * Default: false.
   */
  reducedMotion?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes start delays (ms) for a staggered group of `count` elements.
 *
 * Elements farther from the `from` origin receive larger delays, creating a
 * cascading start sequence. Delays are normalized through the optional `easing`
 * function and guaranteed finite (ST1).
 *
 * @param count   - Number of elements. Must be a positive finite integer.
 *                  Zero, negative, or non-finite → returns [].
 * @param options - Distribution options (gap, from, easing, grid, reducedMotion).
 * @returns Array of `count` finite non-negative delays (ms).
 *
 * @example
 * // Linear stagger: [0, 50, 100, 150, 200]
 * stagger(5)
 *
 * @example
 * // Center-out stagger with easeOut distribution
 * import { easeOut } from '@labpics/motion/easing';
 * stagger(5, { from: 'center', easing: easeOut, gap: 80 })
 *
 * @example
 * // Reduced-motion: all delays collapse to 0 (items animate, just simultaneously)
 * stagger(5, { reducedMotion: true }) // [0, 0, 0, 0, 0]
 */
export function stagger(count: number, options?: StaggerOptions): number[] {
  const nRaw =
    Number.isFinite(count) && count > 0 ? Math.floor(Math.abs(count)) : 0;
  const n = nRaw > MAX_STAGGER_COUNT ? MAX_STAGGER_COUNT : nRaw;
  return scheduleStagger(
    n,
    false,
    options?.gap,
    options?.from,
    options?.easing,
    options?.grid?.columns,
    options?.reducedMotion,
  );
}
