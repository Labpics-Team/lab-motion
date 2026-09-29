import { describe, expect, it } from 'vitest';
import { MotionValue } from '../src/motion-value.js';

function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return queue.length;
    },
    step(ts: number): void {
      const cb = queue.shift();
      if (cb !== undefined) cb(ts);
    },
  };
}

describe('MotionValue: изоляция синхронного solver scratch', () => {
  it('реентерабельный кадр второго значения не меняет пару value/velocity первого', () => {
    const springA = { mass: 1, stiffness: 210, damping: 17 };
    const springB = { mass: 2, stiffness: 90, damping: 36 };
    const aClock = makeClock();
    const bClock = makeClock();
    const refClock = makeClock();
    const a = new MotionValue({ initial: 0, spring: springA, clamp: false, requestFrame: aClock.requestFrame });
    const b = new MotionValue({ initial: 30, spring: springB, clamp: false, requestFrame: bClock.requestFrame });
    const ref = new MotionValue({ initial: 0, spring: springA, clamp: false, requestFrame: refClock.requestFrame });
    let reentered = false;
    a.onChange((value) => {
      if (!reentered && value !== 0) {
        reentered = true;
        bClock.step(1000 / 60);
      }
    });
    a.setTarget(100);
    b.setTarget(-40);
    ref.setTarget(100);
    aClock.step(0);
    bClock.step(0);
    refClock.step(0);
    aClock.step(1000 / 60);
    refClock.step(1000 / 60);
    expect(reentered).toBe(true);
    expect(a.value).toBe(ref.value);
    expect(a.velocity).toBe(ref.velocity);
    a.destroy();
    b.destroy();
    ref.destroy();
  });
});
