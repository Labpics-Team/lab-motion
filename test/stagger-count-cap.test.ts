/**
 * test/stagger-count-cap.test.ts — availability guard for extreme `count` (ST6)
 *
 * Invariant ST6: count is clamped to a fixed upper bound (MAX_STAGGER_COUNT
 * = 100_000, private to the stagger scheduler). A hostile or accidental
 * extreme count MUST NOT hang the event loop or attempt an unbounded
 * `new Array(n)` allocation — the guard exists precisely so
 * `stagger(Number.MAX_SAFE_INTEGER)` / `stagger(1e9)` complete fast and
 * return a bounded, fully finite array instead of stalling/OOM-ing.
 *
 * Test classes:
 *   A (Unit): direct boundary assertions at/around the cap
 *   C (Property): finiteness holds across the full bounded output
 *   D (Mutation proof, manual — see below): documented per test
 *
 * TDD RED-proof (manual — intentionally NOT automated in this suite):
 *   1. In src/stagger/index.ts, revert the clamp:
 *        const n = nRaw; // (remove `nRaw > MAX_STAGGER_COUNT ? ... : nRaw`)
 *   2. Run `pnpm test test/stagger-count-cap.test.ts` — the
 *      "completes within a bounded time budget" assertions below MUST fail
 *      (multi-second allocation of a billion-length array vs. the ms-level
 *      budget asserted here), or the process visibly stalls/OOMs.
 *   3. Restore the clamp → GREEN, fast.
 *   This is NOT automated as a revert-and-rerun mutation (unlike other
 *   stagger tests) because an actually-unguarded run risks hanging/crashing
 *   the CI worker — the whole point of the guard. The bounded-time
 *   assertions below are the executable proxy: they are only true because
 *   the clamp exists, and were verified to fail on the un-clamped code
 *   during authoring.
 */

import { describe, expect, it } from 'vitest';
import { stagger } from '../src/stagger/index.js';

// Mirrors the private MAX_STAGGER_COUNT in the stagger scheduler.
// Kept as a local literal (not exported) — the cap value is an
// implementation detail of ST6, not part of the public API surface.
const MAX_STAGGER_COUNT = 100_000;

describe('stagger — count-cap: extreme count is bounded, not hung (ST6)', () => {
  it('A: count=1e9 → bounded to MAX_STAGGER_COUNT, completes fast', () => {
    const start = Date.now();
    const result = stagger(1_000_000_000);
    const elapsed = Date.now() - start;

    expect(result).toHaveLength(MAX_STAGGER_COUNT);
    // Generous budget — a hung/unbounded allocation would blow past this
    // by orders of magnitude (seconds-to-never vs. milliseconds).
    expect(elapsed).toBeLessThan(2000);
  });

  it('A: count=Number.MAX_SAFE_INTEGER → bounded to MAX_STAGGER_COUNT, finite', () => {
    const start = Date.now();
    const result = stagger(Number.MAX_SAFE_INTEGER);
    const elapsed = Date.now() - start;

    expect(result).toHaveLength(MAX_STAGGER_COUNT);
    expect(elapsed).toBeLessThan(2000);
  });

  it('A: count=Number.MAX_VALUE → bounded, finite (no RangeError/hang)', () => {
    const result = stagger(Number.MAX_VALUE);
    expect(result).toHaveLength(MAX_STAGGER_COUNT);
  });

  it('A: count exactly at cap (100_000) → NOT further clamped', () => {
    const result = stagger(MAX_STAGGER_COUNT, { gap: 1 });
    expect(result).toHaveLength(MAX_STAGGER_COUNT);
  });

  it('A: count = cap + 1 → clamped down to cap', () => {
    const result = stagger(MAX_STAGGER_COUNT + 1, { gap: 1 });
    expect(result).toHaveLength(MAX_STAGGER_COUNT);
  });

  it('A: count well below cap (e.g. 500) → unaffected by the guard', () => {
    const result = stagger(500, { gap: 1 });
    expect(result).toHaveLength(500);
  });

  it('C: extreme count output is fully finite non-negative (ST1 holds under ST6)', () => {
    const result = stagger(1_000_000_000, { gap: 3, from: 'center' });
    expect(result).toHaveLength(MAX_STAGGER_COUNT);
    for (let i = 0; i < result.length; i += 997) {
      // Sparse sample — checking every element of 100k would be slow and
      // is already covered structurally by the finiteness fuzz suite.
      expect(Number.isFinite(result[i])).toBe(true);
      expect(result[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('C: reducedMotion + extreme count → bounded AND all-zero (ST3 + ST6 compose)', () => {
    const result = stagger(1_000_000_000, { reducedMotion: true });
    expect(result).toHaveLength(MAX_STAGGER_COUNT);
    expect(result.every((d) => d === 0)).toBe(true);
  });
});
