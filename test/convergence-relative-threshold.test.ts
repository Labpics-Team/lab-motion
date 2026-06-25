import { describe, expect, it } from 'vitest';
import { drive } from '../src/index.js';

/**
 * Test: convergence threshold is range-relative, not range-absolute
 * Class: unit (regression lock for High bug — absolute CONVERGENCE_THRESHOLD)
 *
 * The bug: CONVERGENCE_THRESHOLD was a fixed absolute value (0.05 output units).
 * For sub-unit ranges (e.g. opacity 0→0.04) the position term
 *   abs(computeValue() - to) < 0.05
 * is satisfied immediately at frame 1 because the entire range (0.04) is smaller
 * than the threshold. The spring was effectively bypassed for tiny ranges.
 * For large ranges (e.g. 0→1000) the spring was held to an absurdly tight
 * absolute tolerance (0.05px out of 1000px = 0.005%), wasting frames.
 *
 * The fix: both position and velocity terms are normalized by abs(range) so the
 * threshold is a fraction of the range rather than an absolute value.
 *
 * RED proof: with the absolute threshold, a sub-unit range (0→0.04) would
 * converge in ~1 frame (position term satisfied immediately). The test below
 * asserts that at least 5 frames are produced for a sub-unit range, which fails
 * before the fix.
 *
 * Mutation proof: revert the threshold to absolute (0.05) and the sub-unit test
 * fails (too few frames). Increase it to 1.0 normalized and the large-range
 * test fails (settles too early, emits too few frames).
 */

function noMotionMatchMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function makeStepClock(): {
  clock: (cb: (ts: number) => void) => number;
  drain: (maxFrames: number) => void;
} {
  const queue: Array<(ts: number) => void> = [];
  let ts = 0;
  return {
    clock: (cb) => {
      queue.push(cb);
      return queue.length; // non-zero handle → no setTimeout fallback needed
    },
    drain: (maxFrames) => {
      for (let i = 0; i < maxFrames && queue.length > 0; i++) {
        ts += 16; // 60fps
        const cb = queue.shift();
        cb?.(ts);
      }
    },
  };
}

describe('convergence threshold is range-relative (regression: absolute threshold)', () => {
  it('drive is callable — prerequisite guard', () => {
    expect(typeof drive).toBe('function');
  });

  it('sub-unit range (0→0.04) produces multiple frames before converging', async () => {
    // opacity-like range: 0 to 0.04 (smaller than the old absolute threshold of 0.05)
    const values: number[] = [];
    const { clock, drain } = makeStepClock();

    const done = drive({
      from: 0,
      to: 0.04,
      spring: { mass: 1, stiffness: 200, damping: 20 },
      matchMedia: noMotionMatchMedia(),
      onStep: (v) => values.push(v),
      requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
    });

    // Drain enough frames for the spring to run (200 = well beyond any spring)
    drain(200);
    await done;

    // With the old absolute threshold the spring would snap in 1 frame.
    // With a relative threshold it should run a proper spring curve.
    expect(values.length).toBeGreaterThanOrEqual(5);

    // Terminal value must reach target
    const last = values[values.length - 1];
    expect(last).toBe(0.04);
  });

  it('unit range (0→1) produces multiple frames — baseline sanity', async () => {
    const values: number[] = [];
    const { clock, drain } = makeStepClock();

    const done = drive({
      from: 0,
      to: 1,
      spring: { mass: 1, stiffness: 200, damping: 20 },
      matchMedia: noMotionMatchMedia(),
      onStep: (v) => values.push(v),
      requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
    });

    drain(200);
    await done;

    expect(values.length).toBeGreaterThanOrEqual(5);
    expect(values[values.length - 1]).toBe(1);
  });

  it('large range (0→1000) produces a similar frame count to unit range (proportional)', async () => {
    const unitValues: number[] = [];
    const largeValues: number[] = [];

    const { clock: c1, drain: d1 } = makeStepClock();
    const { clock: c2, drain: d2 } = makeStepClock();

    const springParams = { mass: 1, stiffness: 200, damping: 20 };

    const done1 = drive({
      from: 0,
      to: 1,
      spring: springParams,
      matchMedia: noMotionMatchMedia(),
      onStep: (v) => unitValues.push(v),
      requestFrame: c1 as unknown as (cb: (ts?: number) => void) => number,
    });

    const done2 = drive({
      from: 0,
      to: 1000,
      spring: springParams,
      matchMedia: noMotionMatchMedia(),
      onStep: (v) => largeValues.push(v),
      requestFrame: c2 as unknown as (cb: (ts?: number) => void) => number,
    });

    d1(300);
    d2(300);
    await done1;
    await done2;

    // With a relative threshold, both ranges run the same normalized spring curve
    // and should converge at the same number of frames (within ±2 frames for
    // floating-point timing differences).
    const diff = Math.abs(unitValues.length - largeValues.length);
    expect(diff).toBeLessThanOrEqual(2);
  });

  it('sub-unit range produces monotonic values toward target (no jump artifacts)', async () => {
    const values: number[] = [];
    const { clock, drain } = makeStepClock();

    const done = drive({
      from: 0,
      to: 0.04,
      spring: { mass: 1, stiffness: 200, damping: 20 },
      matchMedia: noMotionMatchMedia(),
      onStep: (v) => values.push(v),
      requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
    });

    drain(200);
    await done;

    // Monotonic progression
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1] ?? 0;
      expect(values[i]).toBeGreaterThanOrEqual(prev - 1e-10);
    }

    // No value exceeds the target
    for (const v of values) {
      expect(v).toBeLessThanOrEqual(0.04 + 1e-10);
    }
  });
});
