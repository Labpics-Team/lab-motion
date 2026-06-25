import { describe, expect, it, vi } from 'vitest';
import { drive } from '../src/index.js';

/**
 * Test: reduce short-circuits the loop
 * Class: unit
 * Invariant 4 — no public path runs a multi-frame animation when policy says reduce.
 *
 * Prove:
 *   1. The solver spy is NOT called more than 1 time with reduce active.
 *   2. The drive() promise resolves in <=1 tick (no rAF scheduling).
 *
 * RED proof:
 *   `drive` is not exported → TypeError on call → RED for the right reason.
 *
 * Mutation proof (for when implemented):
 *   Remove the reduce guard → the driver calls requestFrame → the spy gets
 *   called multiple times → the <=1 assertion fails.
 */

function reducedMatchMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: true, // prefers-reduced-motion: reduce
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

describe('reduce short-circuits the loop (invariant 4)', () => {
  it('solver loop is NOT entered with reduce active — spy proves 0 or 1 frame', async () => {
    const requestFrameSpy = vi.fn((_cb: () => void): number => 0);
    const onStep = vi.fn();

    await drive({
      from: 0,
      to: 100,
      matchMedia: reducedMatchMedia(),
      onStep,
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: requestFrameSpy,
    });

    // Core assertion: with reduce=true, requestFrame must NOT be called
    // (the loop is short-circuited before the first rAF).
    expect(requestFrameSpy).not.toHaveBeenCalled();
  });

  it('resolves to final value in <=1 tick with reduce active', async () => {
    const values: number[] = [];

    await drive({
      from: 0,
      to: 100,
      matchMedia: reducedMatchMedia(),
      onStep: (v) => values.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: (_cb: () => void): number => 0,
    });

    // Exactly one step call delivering the terminal value, or zero calls
    // (driver resolved synchronously to final).
    expect(values.length).toBeLessThanOrEqual(1);
    if (values.length === 1) {
      expect(values[0]).toBe(100);
    }
  });
});
