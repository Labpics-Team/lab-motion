import { describe, expect, it } from 'vitest';
import { MotionValue } from '../src/index.js';

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

describe('MotionValue', () => {
  it('instantiates with initial value and resolves getters', () => {
    const mv = new MotionValue(100);
    expect(mv.value).toBe(100);
    expect(mv.targetValue).toBe(100);
    expect(mv.velocity).toBe(0);
    expect(mv.springParams).toEqual({ mass: 1, stiffness: 100, damping: 10 });
  });

  it('allows updating spring parameters dynamically', () => {
    const mv = new MotionValue(100);
    mv.setSpringParams({ mass: 2, stiffness: 200, damping: 15 });
    expect(mv.springParams).toEqual({ mass: 2, stiffness: 200, damping: 15 });
  });

  it('triggers onChange callbacks during animation steps', async () => {
    const mv = new MotionValue(0);
    const steps: (number | string)[] = [];
    const unsubscribe = mv.onChange((v) => steps.push(v));

    const frameQueue: Array<(ts: number) => void> = [];
    let frameTs = 0;

    const stepClock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return frameQueue.length;
    };

    // We override requestFrame globally or pass it? Wait, setTarget doesn't accept requestFrame or matchMedia options,
    // so we mock/inject them if needed, or wait, since drive fallback uses setTimeout(0) when no requestFrame is passed,
    // we can just await the promise and it will resolve using setTimeout(0) fallback!
    // But to make it deterministic with stepClock, wait, let's see how drive gets options.
    // In drive.ts:
    // const scheduleFrame = requestFrame ?? (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : setTimeout)
    // If requestAnimationFrame is defined on global, it will use it.
    // If not, it falls back to setTimeout.
    // In node environment, requestAnimationFrame is undefined, so it will use setTimeout(cb, 16.6) or setTimeout(cb, 0).
    // Let's test using real timers or await.
    const done = mv.setTarget(100);
    await done;

    expect(steps.length).toBeGreaterThan(0);
    expect(steps[steps.length - 1]).toBe(100);
    expect(mv.value).toBe(100);

    unsubscribe();
  });

  it('supports unsubscribe from onChange', async () => {
    const mv = new MotionValue(0);
    const steps: (number | string)[] = [];
    const unsubscribe = mv.onChange((v) => steps.push(v));

    unsubscribe();

    await mv.setTarget(100);
    expect(steps).toHaveLength(0);
  });

  it('destroy clears callbacks and stops animations', async () => {
    const mv = new MotionValue(0);
    const steps: (number | string)[] = [];
    mv.onChange((v) => steps.push(v));

    const done = mv.setTarget(100);
    mv.destroy();

    await done;
    expect(steps).toHaveLength(0);
  });
});
