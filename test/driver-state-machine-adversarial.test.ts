import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriver, type AnimationControls } from '../src/driver.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from '../src/internal/constants.js';
import { springUnchecked, type SpringParams } from '../src/spring.js';
import { reducedMotionMedia } from './helpers/reduced-motion.js';

const CRITICAL: SpringParams = { mass: 1, stiffness: 100, damping: 20 };
const UNDER: SpringParams = { mass: 1, stiffness: 100, damping: 10 };

function queuedClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 1;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return handle++;
    },
    step(ts?: number): void {
      const cb = queue.shift();
      if (!cb) throw new Error('expected a scheduled frame');
      cb(ts);
    },
    drain(limit = MAX_FRAMES * 6): number {
      let count = 0;
      while (queue.length > 0 && count < limit) {
        queue.shift()!();
        count++;
      }
      return count;
    },
    pending: () => queue.length,
    take: () => queue.shift(),
  };
}

function firstSaturationFrame(params: SpringParams): number {
  for (let frame = 1; frame < MAX_FRAMES; frame++) {
    if (springUnchecked(params, frame * FIXED_DT_S).value >= 1) return frame;
  }
  throw new Error('spring never reaches target');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('driver scheduler/lifecycle adversarial closure', () => {
  it('bounded output settles on the first visual-saturation frame, not a later physical threshold', async () => {
    const clock = queuedClock();
    const values: number[] = [];
    const crossing = firstSaturationFrame(UNDER);
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: UNDER,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    for (let frame = 1; frame < crossing; frame++) {
      clock.step();
      expect(clock.pending()).toBe(1);
      expect(controls.progress).toBeLessThan(1);
    }
    clock.step();

    expect(clock.pending()).toBe(0);
    expect(values.at(-1)).toBe(100);
    expect(controls.progress).toBe(1);
    await controls;
  });

  it('timeScale=0 reaches the GLOBAL_CAP exactly and settles at the current value, not the target', async () => {
    const clock = queuedClock();
    const values: number[] = [];
    const controls = createDriver({
      from: 7,
      to: 107,
      spring: CRITICAL,
      initialTimeScale: 0,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    const frames = clock.drain(MAX_FRAMES * 5 + 1);
    expect(frames).toBe(MAX_FRAMES * 5);
    expect(values).toHaveLength(MAX_FRAMES * 5);
    expect(values.at(-1)).toBe(7);
    expect(controls.time).toBe(0);
    expect(controls.progress).toBe(0);
    expect(clock.pending()).toBe(0);
    await controls;
  });

  it('very slow forward playback is bounded by MAX_FRAMES with an exact target settle', async () => {
    const clock = queuedClock();
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      initialTimeScale: 1e-6,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    const frames = clock.drain(MAX_FRAMES + 2);
    expect(frames).toBe(MAX_FRAMES);
    expect(values).toHaveLength(MAX_FRAMES);
    expect(values.at(-1)).toBe(100);
    expect(controls.progress).toBe(1);
    expect(clock.pending()).toBe(0);
    await controls;
  });

  it('mixed timestamp/no-timestamp frames preserve the last real timestamp across the fixed-dt frame', () => {
    const clock = queuedClock();
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: () => {},
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    clock.step(1000);
    clock.step(undefined);
    clock.step(1100);

    expect(controls.time).toBeCloseTo(FIXED_DT_S + FIXED_DT_S + 0.1, 14);
    controls.cancel();
  });

  it('reverse settles exactly when virtual time reaches zero, without an extra frame', async () => {
    const clock = queuedClock();
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    controls.pause();
    controls.seek(FIXED_DT_S);
    controls.timeScale = -1;
    controls.play();
    expect(clock.pending()).toBe(1);

    clock.step();
    expect(controls.time).toBe(0);
    expect(controls.progress).toBe(0);
    expect(values.at(-1)).toBe(0);
    expect(clock.pending()).toBe(0);
    await controls;
  });

  it('pause prevents the already-reserved frame from advancing state or emitting', () => {
    const clock = queuedClock();
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    controls.pause();
    const time = controls.time;
    const emissions = values.length;
    clock.step(1000);

    expect(controls.time).toBe(time);
    expect(values).toHaveLength(emissions);
    expect(clock.pending()).toBe(0);
    controls.cancel();
  });

  it('play while already playing is a true no-op and does not reset timestamp continuity', () => {
    const clock = queuedClock();
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: () => {},
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    clock.step(1000);
    expect(controls.time).toBeCloseTo(FIXED_DT_S, 14);
    controls.play();
    expect(clock.pending()).toBe(1);
    clock.step(1100);

    expect(controls.time).toBeCloseTo(FIXED_DT_S + 0.1, 14);
    controls.cancel();
  });

  it('pause/play re-entry preserves one loop owner even before the reserved frame drains', () => {
    const clock = queuedClock();
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: () => {},
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    controls.pause();
    clock.step();
    expect(clock.pending()).toBe(0);

    controls.play();
    expect(clock.pending()).toBe(1);
    controls.pause();
    controls.play();
    expect(clock.pending()).toBe(1);

    controls.cancel();
    clock.step();
  });

  it('a scheduler that becomes non-draining after the first frame demotes to timer fallback', async () => {
    vi.useFakeTimers();
    const queue: Array<(ts?: number) => void> = [];
    let calls = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      calls++;
      if (calls === 1) {
        queue.push(cb);
        return 1;
      }
      return 0;
    };
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame,
    });

    queue.shift()!();
    expect(calls).toBe(2);
    expect(values.length).toBe(1);

    await vi.runAllTimersAsync();
    expect(calls).toBe(2);
    expect(values.length).toBeGreaterThan(1);
    expect(values.at(-1)).toBe(100);
    expect(controls.progress).toBe(1);
  });

  it('a hostile onStep cannot re-enter the same tick and create a second loop owner', () => {
    const clock = queuedClock();
    let activeFrame: ((ts?: number) => void) | undefined;
    let reentered = false;
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => {
        values.push(value);
        if (!reentered) {
          reentered = true;
          activeFrame?.();
        }
      },
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    activeFrame = clock.take();
    expect(activeFrame).toBeTypeOf('function');
    activeFrame!();

    expect(values).toHaveLength(1);
    expect(controls.time).toBeCloseTo(FIXED_DT_S, 14);
    expect(clock.pending()).toBe(1);
    controls.cancel();
  });

  it('settle is re-entrancy safe when terminal onStep calls complete again', async () => {
    const clock = queuedClock();
    let controls!: AnimationControls;
    let terminalCalls = 0;
    controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => {
        if (value === 100) {
          terminalCalls++;
          controls.complete();
        }
      },
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    clock.drain();
    expect(terminalCalls).toBe(1);
    expect(clock.pending()).toBe(0);
    await controls;
  });

  it('throwing matchMedia degrades to normal motion rather than reduce=true', () => {
    const clock = queuedClock();
    const values: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: value => values.push(value),
      matchMedia: () => { throw new Error('host matchMedia failed'); },
      requestFrame: clock.requestFrame,
    });

    expect(values).toEqual([]);
    expect(clock.pending()).toBe(1);
    controls.cancel();
  });

  it('uses the host requestAnimationFrame when no scheduler seam is supplied', () => {
    const raf = vi.fn((_cb: (ts?: number) => void): number => 17);
    vi.stubGlobal('requestAnimationFrame', raf);
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: CRITICAL,
      onStep: () => {},
      matchMedia: reducedMotionMedia(false),
    });

    expect(raf).toHaveBeenCalledTimes(1);
    controls.cancel();
  });

  it('clamp:false never emits non-finite values even when an overshoot overflows binary64', async () => {
    const clock = queuedClock();
    const values: number[] = [];
    const params: SpringParams = { mass: 1, stiffness: 100, damping: 4 };
    const controls = createDriver({
      from: 0,
      to: 1.5e308,
      spring: params,
      clamp: false,
      onStep: value => values.push(value),
      matchMedia: reducedMotionMedia(false),
      requestFrame: clock.requestFrame,
    });

    clock.drain();
    expect(values.length).toBeGreaterThan(1);
    expect(values.every(Number.isFinite)).toBe(true);
    expect(values.at(-1)).toBe(1.5e308);
    await controls;
  });

  it('the exact unclamped convergence oracle remains strictly below both normalized thresholds', () => {
    const frame = (() => {
      for (let i = 1; i < MAX_FRAMES; i++) {
        const s = springUnchecked(UNDER, i * FIXED_DT_S);
        if (Math.abs(s.value - 1) < CONVERGENCE_THRESHOLD && Math.abs(s.velocity) < CONVERGENCE_THRESHOLD) return i;
      }
      throw new Error('no convergence');
    })();
    const sample = springUnchecked(UNDER, frame * FIXED_DT_S);
    const previous = springUnchecked(UNDER, (frame - 1) * FIXED_DT_S);

    expect(Math.abs(sample.value - 1)).toBeLessThan(CONVERGENCE_THRESHOLD);
    expect(Math.abs(sample.velocity)).toBeLessThan(CONVERGENCE_THRESHOLD);
    expect(
      Math.abs(previous.value - 1) >= CONVERGENCE_THRESHOLD ||
      Math.abs(previous.velocity) >= CONVERGENCE_THRESHOLD,
    ).toBe(true);
  });
});
