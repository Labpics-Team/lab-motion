/**
 * easing-endpoints.test.ts — unit
 * Class: unit + characterization
 * Invariant NE2 — endpoint correctness: linear(0)===0 and linear(1)===1 EXACTLY
 * (bit-exact, no floating-point drift), mirroring tween.ts exact-endpoint discipline.
 *
 * RED proof (before implementation):
 *   linear is not yet exported from ../src/easing/index.ts.
 *   The `typeof linear === 'function'` guard fires FIRST, failing with:
 *   "expected 'undefined' to be 'function'"
 *   This blocks the endpoint assertions from producing wrong-reason failures.
 *
 * Mutation proof (for when implemented):
 *   Replace `linear = (t) => t` with `linear = (t) => Math.min(1, Math.max(0, t))`:
 *   → linear(-1) would return 0 ✓ but linear(0) returns 0 ✓ — no mutation caught.
 *   So the real mutation is: remove the t<=0→0 early-return:
 *   → linear(0) may return 0+0*(1-0) = 0 (still passes, depends on impl).
 *   Critical mutation: return `t + 1e-16` always:
 *   → linear(0) = 1e-16 ≠ 0 → fails the ===0 strict check.
 *   The bit-exact `===` (not `toBeCloseTo`) is what bites mutations.
 */

import { describe, expect, it } from 'vitest';
import { linear, normalizeEasing } from '../src/easing/index.js';

describe('easing endpoint correctness — NE2', () => {
  it('linear is callable — prerequisite guard (RED if absent)', () => {
    expect(typeof linear).toBe('function');
  });

  it('linear(0) === 0 exactly (bit-exact, no float drift) — NE2', () => {
    expect(linear(0)).toBe(0);
  });

  it('linear(1) === 1 exactly (bit-exact, no float drift) — NE2', () => {
    expect(linear(1)).toBe(1);
  });

  it('linear(0.5) === 0.5 exactly — midpoint correct', () => {
    expect(linear(0.5)).toBe(0.5);
  });

  it('linear(-0) === 0 exactly — negative zero treated as zero endpoint', () => {
    // -0 <= 0 is true, so the early-return branch gives 0 (not -0)
    expect(linear(-0)).toBe(0);
    expect(Object.is(linear(-0), 0)).toBe(true); // Not -0
  });

  it('linear maps [0,1] monotonically — t<0.5 → result<0.5, t>0.5 → result>0.5', () => {
    // Corollary of exact endpoints + monotonicity
    expect(linear(0.25)).toBeLessThan(0.5);
    expect(linear(0.75)).toBeGreaterThan(0.5);
  });

  it('normalizeEasing(linear)(0) === 0 exactly — normalized wrapper preserves endpoints', () => {
    const normalized = normalizeEasing(linear);
    expect(normalized(0)).toBe(0);
  });

  it('normalizeEasing(linear)(1) === 1 exactly — normalized wrapper preserves endpoints', () => {
    const normalized = normalizeEasing(linear);
    expect(normalized(1)).toBe(1);
  });
});
