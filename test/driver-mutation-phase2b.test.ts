import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriver } from '../src/driver.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from '../src/internal/constants.js';
import { springUnchecked, type SpringParams } from '../src/spring.js';
import { REDUCED_MOTION_QUERY, reducedMotionMedia } from './helpers/reduced-motion.js';

const CRITICAL: SpringParams = { mass: 1, stiffness: 100, damping: 20 };
const UNDERDAMPED: SpringParams = { mass: 1, stiffness: 100, damping: 10 };

function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 1;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return handle++;
    },
    step(): void {
      queue.shift()?.();
    },
    drain(limit = MAX_FRAMES * 6): number {
      let frames = 0;
      while (queue.length > 0 && frames < limit) {
        queue.shift()!();
        frames++;
      }
      return frames;
    },
    pending(): number {
      return queue.length;
    },
  };
}

function expectedUnclampedSettleFrame(spring: SpringParams): number {
  for (let frame = 1; frame < MAX_FRAMES; frame++) {
    const sample = springUnchecked(spring, frame * FIXED_DT_S);
    if (
      Math.abs(sample.value - 1) < CONVERGENCE_THRESHOLD &&
      Math.abs(sample.velocity) < CONVERGENCE_THRESHOLD
    ) return frame;
  }
  return MAX_FRAMES;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('driver phase-2b mutation closure', () => {
  it('settles on the exact first frame where BOTH normalized position and velocity converge', async () => {
    const clock = makeClock();
    const values: number[] = [];
    const expectedFrames = expectedUnclampedSettleFrame(UNDERDAMPED);
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: UNDERDAMPED,
      clamp: false,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    const actualFrames = clock.drain();

    // Exact first-hit equality kills weakened conjunctions, wrong normalization,
    // early visual-saturation reuse and threshold arithmetic mutations.
    expect(actualFrames).toBe(expectedFrames);
    expect(clock.pending()).toBe(0);
    expect(values.at(-1)).toBe(100);
    await controls;
  });

  it('progress is the exact normalized spring state before and after an intermediate cancel', () => {
    const clock = makeClock();
    const controls = createDriver({
      from: -40,
      to: 160,
      spring: CRITICAL,
      onStep: () => {},
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });
    controls.pause();

    for (const t of [0.03125, 0.137, 0.411]) {
      controls.seek(t);
      const expected = Math.max(0, Math.min(1, springUnchecked(CRITICAL, t).value));
      expect(controls.time).toBe(t);
      expect(controls.progress).toBe(expected);
    }

    const t = controls.time;
    const expected = Math.max(0, Math.min(1, springUnchecked(CRITICAL, t).value));
    controls.cancel();
    expect(controls.progress).toBe(expected);
    expect(clock.pending()).toBe(1); // stale pre-pause reservation; settled guard owns it.
    clock.step();
    expect(clock.pending()).toBe(0);
  });

  it('handle=0 demotes once to the timer fallback and still makes progress to the target', async () => {
    vi.useFakeTimers();
    const requestFrame = vi.fn((_cb: (ts?: number) => void): number => 0);
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame,
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(values).toEqual([]);

    await vi.runAllTimersAsync();

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(values.length).toBeGreaterThan(1);
    expect(values.at(-1)).toBe(100);
    expect(controls.progress).toBe(1);
  });

  it('finite reverse timeScale advances virtual time backwards before settling exactly at from', async () => {
    const clock = makeClock();
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    for (let i = 0; i < 9; i++) clock.step();
    const before = controls.time;
    expect(before).toBeGreaterThan(0);

    controls.timeScale = -2;
    clock.step();
    expect(controls.time).toBeCloseTo(Math.max(0, before - 2 * FIXED_DT_S), 14);

    clock.drain();
    expect(clock.pending()).toBe(0);
    expect(values.at(-1)).toBe(0);
    expect(controls.time).toBe(0);
    expect(controls.progress).toBe(0);
    await controls;
  });

  it('reduced motion observes the exact media feature and is a one-value character switch', async () => {
    const queries: string[] = [];
    const clock = makeClock();
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(true, queries),
      requestFrame: clock.requestFrame,
    });

    expect(queries).toEqual([REDUCED_MOTION_QUERY]);
    expect(values).toEqual([100]);
    expect(clock.pending()).toBe(0);
    expect(controls.progress).toBe(1);
    await controls;
  });
});
