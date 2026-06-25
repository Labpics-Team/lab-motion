import { describe, expect, it } from 'vitest';
import { tween } from '../src/index.js';

/**
 * Test: tween boundary correctness
 * Class: unit
 *
 * RED proof:
 *   `tween` is not exported from the placeholder src/index.ts.
 *   Import resolves to undefined → calling it throws TypeError → RED for the
 *   right reason (behavior is missing, not a compile error).
 *
 * Mutation proof (for when implemented):
 *   Break by returning `from + (to - from) * 0.5` always (ignoring t).
 *   The t=0 ===from and t=1 ===to assertions will fail.
 */

describe('tween boundary correctness', () => {
  it('tween(from, to, 0) === from exactly', () => {
    expect(tween(10, 20, 0)).toBe(10);
    expect(tween(-5, 100, 0)).toBe(-5);
    expect(tween(0, 0, 0)).toBe(0);
  });

  it('tween(from, to, 1) === to exactly', () => {
    expect(tween(10, 20, 1)).toBe(20);
    expect(tween(-5, 100, 1)).toBe(100);
    expect(tween(0, 0, 1)).toBe(0);
  });

  it('tween midpoint is strictly between from and to', () => {
    const mid = tween(0, 100, 0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });

  it('tween is monotonically non-decreasing for from < to', () => {
    const t0 = tween(0, 10, 0.2);
    const t1 = tween(0, 10, 0.8);
    expect(t1).toBeGreaterThanOrEqual(t0);
  });
});
