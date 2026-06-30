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
 *
 * @labpics/motion/stagger (subpath-only, tree-shakeable from core bundle)
 */

// ---------------------------------------------------------------------------
// Internal finiteness guard — mirrors easing/index.ts clampFinite discipline
// ---------------------------------------------------------------------------

/**
 * Clamps a delay value to a finite non-negative number.
 *
 * Finite and non-negative → pass through unchanged.
 * NaN, Infinity, -Infinity, or negative → 0.
 *
 * Private — not exported. Invariant ST1.
 */
function clampDelay(x: number): number {
  return Number.isFinite(x) && x >= 0 ? x : 0;
}

/**
 * Minimal safe linear easing — used as fallback when caller passes no easing.
 * Identical contract to easing/index.ts `linear`: clamps hostile t, identity interior.
 * Defined here (not imported) so stagger has ZERO runtime deps.
 */
function linearFallback(t: number): number {
  if (!Number.isFinite(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

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
export type StaggerFrom = 'first' | 'last' | 'center' | 'edges' | number;

/**
 * Grid layout descriptor for 2D stagger distance calculation.
 * When provided, distances are computed as Euclidean (or border) distances
 * in row/column space rather than 1D linear index distance.
 */
export interface StaggerGridOptions {
  /** Number of columns in the grid layout. Must be a positive integer. */
  columns: number;
}

/**
 * Options for the stagger() function.
 */
export interface StaggerOptions {
  /**
   * Base delay gap between consecutive items (ms).
   * Non-finite or negative → treated as 0 (all delays = 0).
   * Default: 50.
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
  // ── count validation ────────────────────────────────────────────────────
  // Non-finite, zero, or negative → empty (ST5)
  const n =
    Number.isFinite(count) && count > 0 ? Math.floor(Math.abs(count)) : 0;
  if (n === 0) return [];
  if (n === 1) return [0];

  // ── Reduced-motion CHARACTER-switch (ST3) ───────────────────────────────
  if (options?.reducedMotion === true) {
    return new Array<number>(n).fill(0);
  }

  // ── Options resolution ──────────────────────────────────────────────────
  const gapRaw = options?.gap;
  const gap: number =
    gapRaw != null && Number.isFinite(gapRaw) && gapRaw >= 0 ? gapRaw : 50;

  const from: StaggerFrom = options?.from ?? 'first';
  const ease: (t: number) => number =
    typeof options?.easing === 'function' ? options.easing : linearFallback;

  const gridCols: number | undefined =
    options?.grid?.columns != null &&
    Number.isFinite(options.grid.columns) &&
    options.grid.columns >= 1
      ? Math.floor(options.grid.columns)
      : undefined;

  // ── Distance computation ────────────────────────────────────────────────
  const distances =
    gridCols != null
      ? computeGridDistances(n, from, gridCols)
      : computeLinearDistances(n, from);

  // ── Normalize → easing → delay ─────────────────────────────────────────
  let maxDist = 0;
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    if (Number.isFinite(d) && d > maxDist) maxDist = d;
  }

  const result = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (maxDist === 0 || gap === 0) {
      result[i] = 0;
      continue;
    }
    const rawDist = distances[i];
    const pos = Number.isFinite(rawDist) ? rawDist / maxDist : 0; // [0,1]
    const easedPos = ease(pos);
    // delay = eased position * max delay
    // max delay = maxDist * gap (distance in "gap units")
    result[i] = clampDelay(
      Number.isFinite(easedPos) ? easedPos * maxDist * gap : 0,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal: 1D linear distance computation
// ---------------------------------------------------------------------------

function computeLinearDistances(n: number, from: StaggerFrom): number[] {
  const distances = new Array<number>(n);

  if (from === 'first') {
    for (let i = 0; i < n; i++) distances[i] = i;
  } else if (from === 'last') {
    for (let i = 0; i < n; i++) distances[i] = n - 1 - i;
  } else if (from === 'center') {
    const center = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      distances[i] = Math.abs(i - center);
    }
  } else if (from === 'edges') {
    // Edges start first (distance=0), center starts last.
    // Distance from nearest edge = min(i, n-1-i).
    for (let i = 0; i < n; i++) {
      distances[i] = Math.min(i, n - 1 - i);
    }
  } else {
    // from = number: specific index as origin
    const originRaw = typeof from === 'number' ? from : 0;
    const origin = Number.isFinite(originRaw)
      ? Math.max(0, Math.min(n - 1, Math.round(originRaw)))
      : 0;
    for (let i = 0; i < n; i++) {
      distances[i] = Math.abs(i - origin);
    }
  }

  return distances;
}

// ---------------------------------------------------------------------------
// Internal: 2D grid distance computation
// ---------------------------------------------------------------------------

function computeGridDistances(
  n: number,
  from: StaggerFrom,
  cols: number,
): number[] {
  const rows = Math.ceil(n / cols);
  const distances = new Array<number>(n);

  if (from === 'edges') {
    // For grid 'edges': each cell's distance = min steps to the grid border.
    // Border cells (row=0, row=lastRow, col=0, col=lastCol) have distance=0.
    const lastRow = rows - 1;
    const lastCol = cols - 1;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const dRow = Math.min(row, lastRow - row);
      const dCol = Math.min(col, lastCol - col);
      distances[i] = Math.min(dRow, dCol);
    }
    return distances;
  }

  // Resolve origin row/col for all other from modes
  let originRow: number;
  let originCol: number;

  if (from === 'first') {
    originRow = 0;
    originCol = 0;
  } else if (from === 'last') {
    const lastIdx = n - 1;
    originRow = Math.floor(lastIdx / cols);
    originCol = lastIdx % cols;
  } else if (from === 'center') {
    originRow = (rows - 1) / 2;
    originCol = (cols - 1) / 2;
  } else {
    // number: specific element index
    const originRaw = typeof from === 'number' ? from : 0;
    const originIdx = Number.isFinite(originRaw)
      ? Math.max(0, Math.min(n - 1, Math.round(originRaw)))
      : 0;
    originRow = Math.floor(originIdx / cols);
    originCol = originIdx % cols;
  }

  // Euclidean distance in row/col space
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const dr = row - originRow;
    const dc = col - originCol;
    const dist = Math.sqrt(dr * dr + dc * dc);
    distances[i] = Number.isFinite(dist) ? dist : 0;
  }

  return distances;
}
