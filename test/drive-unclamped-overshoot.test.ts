import { describe, expect, it } from 'vitest';
import { drive } from '../src/index.js';

/**
 * Test: clamp:false emits honest underdamped overshoot; default stays CSS-safe
 * Class: contract (new capability) + regression pin of the legacy default
 * Finding (audit 2026-07-03, критическая дыра A): аналитический солвер честно
 *   считает overshoot underdamped-пружины, но каждый драйвер срезал его клэмпом
 *   в [from, to] и монотонизацией — spring конструктивно не мог пружинить.
 *   Единственный путь к bounce был косвенный (springAsEasing → keyframes).
 *
 * Contract under clamp:false:
 *   (1) trajectory overshoots: max(emitted) > to for an underdamped spring;
 *   (2) it comes back: some later value < to after the overshoot peak (bounce);
 *   (3) settle is exact: last emitted value === to;
 *   (4) every emitted value is finite (CSS-safety without the clamp).
 * Contract pinned for the default (clamp omitted):
 *   (5) no emitted value exceeds `to` — legacy monotone-toward-`to` behaviour.
 *
 * RED proof (mutation targets):
 *   - Reapply the clamp on the bounded=false path → assertion (1) fails.
 *   - Keep monotonisation on the bounded=false path → assertion (2) fails.
 *   - Drop the final settle emission → assertion (3) fails.
 */

/** Stub matchMedia: no reduced-motion preference. */
function noReduceMedia(): (query: string) => MediaQueryList {
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

/** Manual step clock: collects callbacks, drains them with a fixed timestep. */
function makeStepClock(): {
  clock: (cb: (ts?: number) => void) => number;
  drainUntilIdle: (maxFrames: number) => void;
} {
  const queue: Array<(ts?: number) => void> = [];
  let ts = 0;
  let handle = 0;
  return {
    clock: (cb) => {
      queue.push(cb);
      handle += 1;
      return handle;
    },
    drainUntilIdle: (maxFrames) => {
      for (let i = 0; i < maxFrames && queue.length > 0; i++) {
        ts += 1000 / 60;
        const cb = queue.shift();
        if (cb) cb(ts);
      }
    },
  };
}

/** Underdamped spring well above the validator floors: zeta = 0.25, omega0 = 8. */
const UNDERDAMPED = { mass: 1, stiffness: 64, damping: 4 } as const;

describe('drive clamp:false — честная underdamped-пружина', () => {
  it('emits overshoot past `to`, bounces back, settles exactly at `to`', async () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const done = drive({
      from: 0,
      to: 100,
      spring: UNDERDAMPED,
      clamp: false,
      onStep: (v) => emitted.push(v),
      matchMedia: noReduceMedia(),
      requestFrame: clock,
    });
    drainUntilIdle(2000);
    await done;

    // (4) CSS-safety without the clamp: analytic solver never yields non-finite.
    for (const v of emitted) expect(Number.isFinite(v)).toBe(true);

    // (1) Physical overshoot is emitted, not absorbed. zeta=0.25 overshoots by
    // exp(-pi*zeta/sqrt(1-zeta^2)) ≈ 44% — far above any numeric tolerance.
    const peak = Math.max(...emitted);
    expect(peak).toBeGreaterThan(100 + 1);

    // (2) It is a bounce, not a one-way ramp: after the peak the trajectory
    // returns below `to` before settling.
    const peakIndex = emitted.indexOf(peak);
    const afterPeak = emitted.slice(peakIndex + 1);
    expect(Math.min(...afterPeak)).toBeLessThan(100);

    // (3) Exact settle.
    expect(emitted[emitted.length - 1]).toBe(100);
  });

  it('supports negative range (to < from) with symmetric undershoot', async () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const done = drive({
      from: 100,
      to: 0,
      spring: UNDERDAMPED,
      clamp: false,
      onStep: (v) => emitted.push(v),
      matchMedia: noReduceMedia(),
      requestFrame: clock,
    });
    drainUntilIdle(2000);
    await done;

    // Overshoot below `to` on a descending range, return above, exact settle.
    expect(Math.min(...emitted)).toBeLessThan(-1);
    expect(emitted[emitted.length - 1]).toBe(0);
  });

  it('default (clamp omitted) pins the legacy CSS-safe contract: never exceeds `to`', async () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const done = drive({
      from: 0,
      to: 100,
      spring: UNDERDAMPED,
      onStep: (v) => emitted.push(v),
      matchMedia: noReduceMedia(),
      requestFrame: clock,
    });
    drainUntilIdle(2000);
    await done;

    for (const v of emitted) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(emitted[emitted.length - 1]).toBe(100);
  });
});
