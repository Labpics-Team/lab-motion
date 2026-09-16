import { describe, expect, it } from 'vitest';
import { springStore } from '../src/svelte/index.js';

function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  let time = 0;

  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return queue.length;
    },
    drain(max = 3000): void {
      for (let i = 0; queue.length > 0 && i < max; i += 1) {
        time += dtMs;
        queue.shift()!(time);
      }
    },
  };
}

describe('springStore current-value ownership', () => {
  it('a late subscriber immediately observes the latest emitted value', () => {
    const clock = makeVirtualClock();
    const store = springStore(
      0,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      clock.requestFrame,
    );

    let latest = 0;
    const unsubscribeFirst = store.subscribe((value) => {
      latest = value;
    });

    store.set(100);
    clock.drain();
    expect(latest).toBe(100);

    const lateValues: number[] = [];
    const unsubscribeLate = store.subscribe((value) => {
      lateValues.push(value);
    });

    // Mutation proof: replacing `run(mv.value)` with `run(initial)` makes this RED.
    expect(lateValues).toEqual([100]);

    unsubscribeLate();
    unsubscribeFirst();
    store.destroy();
  });
});
