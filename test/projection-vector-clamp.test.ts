import { describe, expect, it } from 'vitest';
import { createProjection } from '../src/projection/index.js';

function makeClock(): {
  readonly requestFrame: (cb: (ts?: number) => void) => number;
  step(ms?: number): void;
} {
  const queue: Array<(ts?: number) => void> = [];
  let now = 0;
  return {
    requestFrame(cb) {
      queue.push(cb);
      return queue.length;
    },
    step(ms = 1000 / 240) {
      now += ms;
      const cb = queue.shift();
      if (cb === undefined) throw new Error('projection clamp witness: no frame queued');
      cb(now);
    },
  };
}

describe('projection vector retarget clamp contract', () => {
  it('clamp:true keeps a newly introduced axis between its pickup and target', () => {
    const clock = makeClock();
    const ys: number[] = [];
    const controls = createProjection({
      clamp: true,
      spring: { mass: 1, stiffness: 200, damping: 14 },
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        ys.push(100 + frames[0]!.ty);
      },
    });

    controls.play([
      {
        id: 'card',
        first: { x: 0, y: 0, width: 100, height: 100 },
        last: { x: 200, y: 0, width: 100, height: 100 },
      },
    ]);
    for (let i = 0; i < 20; i++) clock.step();

    controls.play([
      { id: 'card', last: { x: 300, y: 100, width: 100, height: 100 } },
    ]);
    expect(ys.at(-1)).toBeCloseTo(0, 10);

    // Settlement time is physics, not part of the clamp contract. Drain only
    // within the driver's existing MAX_FRAMES budget and assert the endpoint
    // once the owner itself declares rest.
    for (let i = 0; i < 2000 && controls.playing; i++) clock.step();
    expect(controls.playing).toBe(false);

    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(100 + 1e-9);
    }
    expect(ys.at(-1)).toBeCloseTo(100, 9);
  });
});
