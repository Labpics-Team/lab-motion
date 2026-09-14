import { describe, expect, it, vi } from 'vitest';
import { drive } from '../src/index.js';
import { REDUCED_MOTION_QUERY, reducedMotionMedia } from './helpers/reduced-motion.js';

/**
 * Test: reduced-motion policy both states + node
 * Class: unit + semantic seam contract
 * Invariant 4 — reduced-motion honoured at the API boundary, always.
 *
 * The media query itself is part of the contract. A fake that returns the same
 * `matches` value for every query is not a valid oracle: an implementation that
 * accidentally asks for prefers-color-scheme would look correct. The shared
 * helper is query-sensitive and these tests assert the observed query.
 *
 * Reduced motion is a CHARACTER-switch, not hard-off: drive must synchronously
 * deliver exactly one terminal `to` value and schedule no frame loop.
 */

describe('reduced-motion policy (invariant 4)', () => {
  it('queries the exact reduced-motion feature and emits exactly one terminal value', async () => {
    const queries: string[] = [];
    const onStep = vi.fn();
    const requestFrame = vi.fn((_cb: () => void): number => 1);

    const done = drive({
      from: 0,
      to: 100,
      matchMedia: reducedMotionMedia(true, queries),
      onStep,
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame,
    });

    // CHARACTER-switch is synchronous at admission, before any await/microtask.
    expect(queries).toEqual([REDUCED_MOTION_QUERY]);
    expect(onStep.mock.calls).toEqual([[100]]);
    expect(requestFrame).not.toHaveBeenCalled();
    await done;
  });

  it('enters multi-frame animation when the exact query reports no preference', async () => {
    const queries: string[] = [];
    const stepValues: number[] = [];

    // Use a non-draining step clock (returns 0 without invoking its callback).
    // drive switches to its liveness fallback and eventually completes.
    const stepClock = (_cb: () => void): number => 0;

    await drive({
      from: 0,
      to: 100,
      matchMedia: reducedMotionMedia(false, queries),
      onStep: (v) => stepValues.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: stepClock,
    });

    expect(queries).toEqual([REDUCED_MOTION_QUERY]);
    expect(stepValues.length).toBeGreaterThanOrEqual(2);
    expect(stepValues.at(-1)).toBe(100);
  }, 5000);

  it('does NOT throw in node / no-matchMedia environment (SSR fault safety)', () => {
    expect(() => {
      void drive({
        from: 0,
        to: 100,
        matchMedia: undefined,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
        requestFrame: (_cb: () => void) => 0,
      });
    }).not.toThrow();
  });
});
