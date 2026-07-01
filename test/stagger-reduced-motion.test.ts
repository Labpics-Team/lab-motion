/**
 * test/stagger-reduced-motion.test.ts — reduced-motion CHARACTER-switch for stagger()
 *
 * Invariant ST3 (northInvariant #5):
 *   When reducedMotion=true, all delays collapse to 0.
 *   Items still animate — they just start simultaneously with no stagger offset.
 *   This is a CHARACTER change (zero offset = instant cascade), NOT hard-off.
 *
 * TDD RED-proof:
 *   1. Remove the `if (options?.reducedMotion === true) { return [...].fill(0) }`
 *      block in src/stagger/index.ts.
 *   2. Run: pnpm test test/stagger-reduced-motion.test.ts
 *   3. Every test in 'stagger — reduced-motion: CHARACTER-switch' MUST fail.
 *   4. Restore → GREEN.
 *
 * Mutation proof:
 *   - Replacing `fill(0)` with `fill(gap)` → delays non-zero → toBe(0) fails.
 *   - Short-circuiting before the reducedMotion check → normal delays returned → fails.
 *
 * Test classes:
 *   A (Unit): reducedMotion=true collapses delays
 *   C (Property): CHARACTER invariant over a range of inputs
 *   D (Mutation proof): documented per test
 */

import { describe, expect, it } from 'vitest';
import { stagger } from '../src/stagger/index.js';

// ---------------------------------------------------------------------------
// Core CHARACTER-switch tests
// ---------------------------------------------------------------------------

describe('stagger — reduced-motion: CHARACTER-switch (ST3)', () => {
  it('A: reducedMotion=true → all delays are 0 (from=first)', () => {
    // Mutation proof: remove fill(0) branch → returns normal stagger delays → fails
    const result = stagger(5, { reducedMotion: true });
    expect(result).toHaveLength(5);
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: reducedMotion=true → all delays are 0 (from=last)', () => {
    const result = stagger(5, { from: 'last', reducedMotion: true });
    expect(result).toHaveLength(5);
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: reducedMotion=true → all delays are 0 (from=center)', () => {
    const result = stagger(7, { from: 'center', reducedMotion: true });
    expect(result).toHaveLength(7);
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: reducedMotion=true → all delays are 0 (from=edges)', () => {
    const result = stagger(6, { from: 'edges', reducedMotion: true });
    expect(result).toHaveLength(6);
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: reducedMotion=true → all delays are 0 (from=number)', () => {
    const result = stagger(5, { from: 2, reducedMotion: true });
    expect(result).toHaveLength(5);
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: reducedMotion=true overrides large gap', () => {
    // Even with gap=1000, all delays should be 0
    const result = stagger(5, { gap: 1000, reducedMotion: true });
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: reducedMotion=true overrides custom easing', () => {
    // Even with exotic easing, all delays should be 0
    const result = stagger(5, {
      easing: (t) => t * t * t,
      reducedMotion: true,
    });
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('A: reducedMotion=true with grid → all delays are 0', () => {
    const result = stagger(9, { grid: { columns: 3 }, reducedMotion: true });
    expect(result).toHaveLength(9);
    for (const d of result) {
      expect(d).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// CHARACTER = snap-to-start, NOT hard-off
// Delay=0 means items start simultaneously; they still animate to their targets.
// This test characterizes the contract (structural, not behavioral — stagger is
// pure math; the caller drives animation).
// ---------------------------------------------------------------------------

describe('stagger — reduced-motion: CHARACTER not hard-off', () => {
  it('C: reduced-motion result is an array (not undefined/null = not hard-off)', () => {
    // Mutation proof: returning undefined/null would break caller iteration
    const result = stagger(5, { reducedMotion: true });
    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeNull();
  });

  it('C: reduced-motion result has the same length as count (all items present)', () => {
    // All items are still "in the group" — they just start at t=0
    // Mutation proof: filtering items out (shorter array) would be hard-off
    for (const n of [1, 2, 5, 10, 100]) {
      const result = stagger(n, { reducedMotion: true });
      expect(result).toHaveLength(n);
    }
  });

  it('C: reduced-motion result has all zeros (items start simultaneously)', () => {
    // Simultaneous start = CHARACTER-switch (no stagger offset)
    // Mutation proof: returning non-zero delays → CHARACTER not changed
    const result = stagger(10, { gap: 200, from: 'center', reducedMotion: true });
    const allZero = result.every((d) => d === 0);
    expect(allZero).toBe(true);
  });

  it('C: full-motion stagger (reducedMotion=false) has non-zero delays', () => {
    // Negative test: without reduced-motion, delays are NOT all zero
    const result = stagger(5, { gap: 50, reducedMotion: false });
    const someNonZero = result.some((d) => d > 0);
    expect(someNonZero).toBe(true);
  });

  it('C: reducedMotion=false gives same result as omitting reducedMotion', () => {
    // Default (undefined) and false should behave identically
    const withFalse = stagger(5, { gap: 80, from: 'center', reducedMotion: false });
    const withUndefined = stagger(5, { gap: 80, from: 'center' });
    expect(withFalse).toEqual(withUndefined);
  });
});

// ---------------------------------------------------------------------------
// Edge counts in reduced-motion mode
// ---------------------------------------------------------------------------

describe('stagger — reduced-motion: edge counts', () => {
  it('A: count=0, reducedMotion=true → [] (empty, no element = not hard-off)', () => {
    expect(stagger(0, { reducedMotion: true })).toEqual([]);
  });

  it('A: count=1, reducedMotion=true → [0]', () => {
    const result = stagger(1, { reducedMotion: true });
    expect(result).toEqual([0]);
  });

  it('A: count=2, reducedMotion=true → [0, 0]', () => {
    const result = stagger(2, { reducedMotion: true });
    expect(result).toEqual([0, 0]);
  });

  it('A: very large count, reducedMotion=true → all zeros', () => {
    const n = 500;
    const result = stagger(n, { reducedMotion: true });
    expect(result).toHaveLength(n);
    expect(result.every((d) => d === 0)).toBe(true);
  });
});
