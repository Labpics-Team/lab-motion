import { describe, expect, it, vi } from 'vitest';
import { drive } from '../src/index.js';
import { REDUCED_MOTION_QUERY, reducedMotionMedia } from './helpers/reduced-motion.js';

/**
 * Test: reduce short-circuits the loop without becoming hard-off.
 * Class: unit + liveness/useful-outcome
 *
 * Safety alone ("no frame loop") is vacuous: an implementation that simply
 * returns without delivering the target also satisfies it. The contract is the
 * conjunction: exact prefers-reduced-motion query + zero scheduled frames +
 * exactly one synchronous terminal emission.
 */
describe('reduce short-circuits the loop (invariant 4)', () => {
  it('uses the exact media query, schedules no frame and snaps synchronously', async () => {
    const queries: string[] = [];
    const requestFrame = vi.fn((_cb: () => void): number => 1);
    const values: number[] = [];

    const done = drive({
      from: 0,
      to: 100,
      matchMedia: reducedMotionMedia(true, queries),
      onStep: (value) => values.push(value),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame,
    });

    // All three are synchronous observables. A wrong query takes the normal
    // path; hard-off produces []; a leaked frame calls requestFrame.
    expect(queries).toEqual([REDUCED_MOTION_QUERY]);
    expect(values).toEqual([100]);
    expect(requestFrame).not.toHaveBeenCalled();

    await done;
    expect(values).toEqual([100]);
  });
});
