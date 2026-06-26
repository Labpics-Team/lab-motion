import { describe, expect, it } from 'vitest';
import { drive } from '../src/index.js';

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

describe('drive() retargeting (seamless transition interruption)', () => {
  it('interrupts an active animation on the same target, inheriting position and velocity', async () => {
    const target = {} as Element;
    const values1: number[] = [];
    const values2: number[] = [];
    const frameQueue: Array<(ts: number) => void> = [];
    let frameTs = 0;

    const stepClock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return frameQueue.length;
    };

    // Start first animation: 0 -> 100
    const done1 = drive({
      from: 0,
      to: 100,
      target,
      matchMedia: fullMatchMedia(false),
      onStep: (v) => values1.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: stepClock as unknown as (cb: () => void) => number,
    });

    // Run 3 frames of the first animation to build some speed and displacement
    for (let i = 0; i < 3; i++) {
      frameTs += 16;
      const cb = frameQueue.shift();
      cb?.(frameTs);
    }

    expect(values1.length).toBe(3);
    const lastValue1 = values1[values1.length - 1];
    expect(lastValue1).toBeGreaterThan(0);
    expect(lastValue1).toBeLessThan(100);

    // Now start a second animation targeting 200 on the same target.
    // Since we pass target, it should interrupt done1.
    const done2 = drive({
      from: 100, // even if from is specified as 100, retargeting should override start value with lastValue1
      to: 200,
      target,
      matchMedia: fullMatchMedia(false),
      onStep: (v) => values2.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: stepClock as unknown as (cb: () => void) => number,
    });

    // done1 should resolve immediately because it was interrupted (and .stop() calls settle())
    await done1;

    // Run frames for the second animation
    for (let i = 0; i < 200 && frameQueue.length > 0; i++) {
      frameTs += 16;
      const cb = frameQueue.shift();
      cb?.(frameTs);
    }

    await done2;

    // The second animation must start precisely from the last value of the first animation
    expect(values2[0]).toBe(lastValue1);

    // It must reach 200
    expect(values2[values2.length - 1]).toBe(200);
  });
});
