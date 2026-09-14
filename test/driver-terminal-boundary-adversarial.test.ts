import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriver } from '../src/driver.js';
import { FIXED_DT_S } from '../src/internal/constants.js';
import { reducedMotionMedia } from './helpers/reduced-motion.js';

const SPRING = { mass: 1, stiffness: 100, damping: 20 };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('driver terminal/platform boundaries', () => {
  it('uses the setTimeout host fallback when requestAnimationFrame is unavailable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: SPRING,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
    });

    // The default scheduler itself must have admitted one real host timer.
    expect(vi.getTimerCount()).toBe(1);
    expect(values).toEqual([]);

    await vi.runAllTimersAsync();
    expect(values.length).toBeGreaterThan(1);
    expect(values.at(-1)).toBe(100);
    expect(controls.progress).toBe(1);
  });

  it('a stale reserved frame after complete cannot mutate virtual time or emit again', async () => {
    const frames: Array<(ts?: number) => void> = [];
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: SPRING,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: cb => { frames.push(cb); return frames.length; },
    });

    expect(frames).toHaveLength(1);
    controls.complete();
    await controls;
    expect(values).toEqual([100]);
    const terminalTime = controls.time;

    frames.shift()!(1000);
    expect(controls.time).toBe(terminalTime);
    expect(values).toEqual([100]);
  });

  it('pause resets timestamp ownership so resume does not consume wall time spent paused', () => {
    const frames: Array<(ts?: number) => void> = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: SPRING,
      onStep: () => {},
      matchMedia: reducedMotionMedia(false),
      requestFrame: cb => { frames.push(cb); return frames.length; },
    });

    frames.shift()!(1000);
    expect(controls.time).toBeCloseTo(FIXED_DT_S, 14);

    controls.pause();
    frames.shift()!(5000); // reserved frame observes pause and clears last real ts
    const pausedAt = controls.time;
    controls.play();
    frames.shift()!(9000); // first resumed frame must use FIXED_DT, not +4 seconds

    expect(controls.time).toBeCloseTo(pausedAt + FIXED_DT_S, 14);
    controls.cancel();
  });
});
