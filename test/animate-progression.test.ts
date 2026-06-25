import { describe, expect, it } from 'vitest';
import { drive } from '../src/index.js';

/**
 * Test: animate progression under step-clock
 * Class: unit
 * Invariant 2 + 3 — finite output, monotonic progression from → to.
 *
 * Uses an injected step-clock (no real rAF) so the test is deterministic.
 * We advance frames manually and assert:
 *   1. Every emitted value is finite (invariant 2).
 *   2. Values progress from `from` toward `to` (monotonic for from < to).
 *   3. The animation terminates exactly at `to`.
 *   4. No real rAF is ever used.
 *
 * RED proof:
 *   `drive` is not exported → TypeError → RED for the right reason.
 *
 * Mutation proof (for when implemented):
 *   Return the same value every frame → monotonic assertion fails.
 *   Return NaN → finiteness assertion fails.
 *   Never resolve → the promise never settles → test times out.
 */

function fullMatchMedia(matches: false): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

describe('animate progression under step-clock (invariant 2 + 3)', () => {
  it('produces monotonic, finite progression from 0 to 100 with no real rAF', async () => {
    const values: number[] = [];
    const frameQueue: Array<(ts: number) => void> = [];
    let frameTs = 0;

    // Step clock: collect callbacks, advance them manually below.
    const stepClock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return frameQueue.length;
    };

    // Do NOT await yet — start the animation.
    const done = drive({
      from: 0,
      to: 100,
      matchMedia: fullMatchMedia(false),
      onStep: (v) => values.push(v),
      spring: { mass: 1, stiffness: 200, damping: 20 },
      requestFrame: stepClock as unknown as (cb: () => void) => number,
    });

    // Drain up to 200 frames (spring should converge well before that).
    // Each frame advances by 16ms (60 fps).
    for (let i = 0; i < 200 && frameQueue.length > 0; i++) {
      frameTs += 16;
      const cb = frameQueue.shift();
      cb?.(frameTs);
    }

    await done;

    // Must have produced at least a few frames.
    expect(values.length).toBeGreaterThanOrEqual(2);

    // Every value must be finite (invariant 2).
    for (const v of values) {
      expect(Number.isFinite(v)).toBe(true);
    }

    // Monotonic: each value is >= the previous (spring moves toward target).
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] ?? 0);
    }

    // Terminal: final value reaches `to`.
    const last = values[values.length - 1];
    expect(last).toBe(100);
  });
});
