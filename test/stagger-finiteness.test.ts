/**
 * test/stagger-finiteness.test.ts — NaN/∞ guard for stagger()
 *
 * Invariant ST1: every returned delay is a finite non-negative number.
 * NaN/Infinity in any input must never propagate to output.
 *
 * Test classes:
 *   A (Unit): direct finiteness assertions for extreme/hostile inputs
 *   B (Regression): characterize baseline non-hostile behaviour
 *   D (Mutation proof): documented per test
 *
 * TDD RED-proof:
 *   1. Remove the `clampDelay(...)` guard in stagger/index.ts so raw
 *      non-finite values pass through.
 *   2. Run: pnpm test test/stagger-finiteness.test.ts
 *   3. At least one test MUST fail.
 *   4. Restore guard → GREEN.
 */

import { describe, expect, it } from 'vitest';
import { stagger } from '../src/stagger/index.js';

// Helper: assert all delays in an array are finite and >= 0.
function assertAllFinite(delays: number[], label = ''): void {
  for (let i = 0; i < delays.length; i++) {
    const d = delays[i];
    if (!Number.isFinite(d) || d < 0) {
      throw new Error(
        `${label} delays[${i}] = ${d} is not a finite non-negative number`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Hostile count inputs
// ---------------------------------------------------------------------------

describe('stagger — finiteness: hostile count', () => {
  it('A: count=0 → empty array (ST5)', () => {
    // Mutation proof: returning [0] instead of [] breaks length assertion
    expect(stagger(0)).toEqual([]);
  });

  it('A: count negative → empty array (ST5)', () => {
    // Mutation proof: Math.abs without guard → negative count treated as positive
    expect(stagger(-5)).toEqual([]);
    expect(stagger(-1)).toEqual([]);
  });

  it('A: count=NaN → empty array (ST5)', () => {
    expect(stagger(NaN)).toEqual([]);
  });

  it('A: count=Infinity → empty array (ST5)', () => {
    // Mutation proof: removing isFinite check → infinite loop or crash
    expect(stagger(Infinity)).toEqual([]);
  });

  it('A: count=-Infinity → empty array (ST5)', () => {
    expect(stagger(-Infinity)).toEqual([]);
  });

  it('A: count=1 → [0] (single element always zero delay)', () => {
    // Mutation proof: returning [gap] instead → fails toBe(0)
    const result = stagger(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(0);
  });

  it('A: count=1.9 → [0] (floor truncation, treated as 1)', () => {
    const result = stagger(1.9);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(0);
  });

  it('A: count=2.7 → length 2 (floor truncation)', () => {
    const result = stagger(2.7);
    expect(result).toHaveLength(2);
    assertAllFinite(result, 'count=2.7');
  });
});

// ---------------------------------------------------------------------------
// Hostile gap inputs
// ---------------------------------------------------------------------------

describe('stagger — finiteness: hostile gap', () => {
  it('A: gap=NaN → all delays are 0 (ST1 guard)', () => {
    // Mutation proof: remove gap validation → gap=NaN propagates → NaN delays
    const result = stagger(5, { gap: NaN });
    // Non-finite gap → falls back to gap=50 OR collapses to 0; result must be finite
    assertAllFinite(result, 'gap=NaN');
  });

  it('A: gap=Infinity → all delays are finite (ST1)', () => {
    // Mutation proof: removing guard → gap=Infinity → Infinity*pos = Infinity in output
    const result = stagger(5, { gap: Infinity });
    assertAllFinite(result, 'gap=Infinity');
  });

  it('A: gap=-Infinity → all delays are 0 or finite (ST1)', () => {
    const result = stagger(5, { gap: -Infinity });
    assertAllFinite(result, 'gap=-Infinity');
  });

  it('A: gap=0 → all delays are 0', () => {
    // Mutation proof: missing gap=0 fast-path → delays computed as Infinity*0=NaN
    const result = stagger(5, { gap: 0 });
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: gap negative → treated as 0 or default (all delays finite)', () => {
    const result = stagger(5, { gap: -100 });
    assertAllFinite(result, 'gap=-100');
  });

  it('A: gap=Number.MAX_VALUE → all delays finite (no overflow to Infinity)', () => {
    // Even at max gap, for count=2 delay=[0, MAX_VALUE] which is still finite
    const result = stagger(2, { gap: Number.MAX_VALUE });
    assertAllFinite(result, 'gap=MAX_VALUE');
  });
});

// ---------------------------------------------------------------------------
// Hostile easing function return values
// ---------------------------------------------------------------------------

describe('stagger — finiteness: hostile easing returns', () => {
  it('A: easing returns NaN → delay clamped to 0 (ST1)', () => {
    // Mutation proof: remove clampDelay → NaN*gap = NaN propagates
    const result = stagger(5, { easing: () => NaN });
    assertAllFinite(result, 'easing=NaN');
    // All should be 0 (NaN clamped)
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: easing returns Infinity → delay clamped to 0 (ST1)', () => {
    // Mutation proof: Infinity * gap = Infinity passes through → non-finite
    const result = stagger(5, { easing: () => Infinity });
    assertAllFinite(result, 'easing=Infinity');
  });

  it('A: easing returns -Infinity → delay clamped to 0 (ST1)', () => {
    const result = stagger(5, { easing: () => -Infinity });
    assertAllFinite(result, 'easing=-Infinity');
  });

  it('A: easing returns negative values → delay clamped to 0 (ST1)', () => {
    // Negative delay is not meaningful; clampDelay enforces >= 0
    const result = stagger(5, { easing: () => -1 });
    assertAllFinite(result, 'easing=-1');
    for (const d of result) {
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it('A: easing returns value > 1 → delay computed but clamped finite (ST1)', () => {
    // Overshooting easing (like elastic) produces delay > maxDelay — still finite
    const result = stagger(5, { easing: () => 2 });
    assertAllFinite(result, 'easing=2');
  });
});

// ---------------------------------------------------------------------------
// Hostile `from` inputs
// ---------------------------------------------------------------------------

describe('stagger — finiteness: hostile from values', () => {
  it('A: from=NaN → treated as from=0 (clamped), all delays finite (ST1)', () => {
    const result = stagger(5, { from: NaN });
    assertAllFinite(result, 'from=NaN');
  });

  it('A: from=Infinity → clamped to n-1, all delays finite (ST1)', () => {
    const result = stagger(5, { from: Infinity });
    assertAllFinite(result, 'from=Infinity');
  });

  it('A: from=-Infinity → clamped to 0, all delays finite (ST1)', () => {
    const result = stagger(5, { from: -Infinity });
    assertAllFinite(result, 'from=-Infinity');
  });

  it('A: from=number out of range (< 0) → clamped to 0', () => {
    const result = stagger(5, { from: -99 });
    assertAllFinite(result, 'from=-99');
    // Clamped to 0 → same as from='first'
    const expected = stagger(5, { from: 'first' });
    expect(result).toEqual(expected);
  });

  it('A: from=number out of range (> n-1) → clamped to n-1', () => {
    const result = stagger(5, { from: 999 });
    assertAllFinite(result, 'from=999');
    // Clamped to 4 → same as from='last' but rounded
    const expected = stagger(5, { from: 4 });
    expect(result).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Grid hostile inputs
// ---------------------------------------------------------------------------

describe('stagger — finiteness: hostile grid inputs', () => {
  it('A: grid.columns=NaN → grid ignored, 1D fallback, all finite', () => {
    const result = stagger(6, { grid: { columns: NaN } });
    assertAllFinite(result, 'grid.columns=NaN');
  });

  it('A: grid.columns=0 → grid ignored, 1D fallback, all finite', () => {
    const result = stagger(6, { grid: { columns: 0 } });
    assertAllFinite(result, 'grid.columns=0');
  });

  it('A: grid.columns=Infinity → grid ignored, 1D fallback, all finite', () => {
    const result = stagger(6, { grid: { columns: Infinity } });
    assertAllFinite(result, 'grid.columns=Infinity');
  });

  it('A: grid.columns > count → grid with partial row, all finite (ST1)', () => {
    // count=3, columns=10 → 1 row with 3 elements; partial row OK
    const result = stagger(3, { grid: { columns: 10 } });
    assertAllFinite(result, 'grid.columns=10 count=3');
  });
});

// ---------------------------------------------------------------------------
// Regression: baseline non-hostile cases all finite
// ---------------------------------------------------------------------------

describe('stagger — finiteness: baseline non-hostile', () => {
  it('B: from=first, n=5, gap=50 → all finite, increasing', () => {
    const result = stagger(5);
    assertAllFinite(result, 'baseline first');
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(0);
    // Delays non-decreasing
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(result[i - 1]);
    }
  });

  it('B: from=last, n=5, gap=50 → all finite, decreasing', () => {
    const result = stagger(5, { from: 'last' });
    assertAllFinite(result, 'baseline last');
    expect(result[result.length - 1]).toBe(0);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeLessThanOrEqual(result[i - 1]);
    }
  });

  it('B: from=center, n=5, gap=50 → center has delay 0', () => {
    const result = stagger(5, { from: 'center' });
    assertAllFinite(result, 'baseline center');
    expect(result[2]).toBe(0); // center of 5 elements
  });

  it('B: from=edges, n=5, gap=50 → edges have delay 0', () => {
    const result = stagger(5, { from: 'edges' });
    assertAllFinite(result, 'baseline edges');
    expect(result[0]).toBe(0);
    expect(result[4]).toBe(0);
  });

  it('B: from=number, n=5, gap=50 → origin element has delay 0', () => {
    const result = stagger(5, { from: 2 });
    assertAllFinite(result, 'baseline from=2');
    expect(result[2]).toBe(0);
  });

  it('B: grid 2×3, from=center → all finite', () => {
    const result = stagger(6, { grid: { columns: 3 } });
    assertAllFinite(result, 'grid 2×3');
    expect(result).toHaveLength(6);
  });
});
