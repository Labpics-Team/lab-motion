import { describe, expect, it } from 'vitest';
import { createProjection } from '../../src/projection/index.js';

type Point = { x: number; y: number };

function clock() {
  const queue: Array<(ts?: number) => void> = [];
  let now = 0;
  return {
    requestFrame(cb: (ts?: number) => void) {
      queue.push(cb);
      return queue.length;
    },
    step(ms = 1000 / 120) {
      now += ms;
      const cb = queue.shift();
      if (!cb) throw new Error('clamp-search:no-frame');
      cb(now);
    },
  };
}

function close(a: number, b: number, eps = 1e-7) {
  return Math.abs(a - b) <= eps;
}

describe('research: clamp emitted state equals analytical pickup state', () => {
  it('searches 2D retarget envelopes for hidden unclamped state', () => {
    const springs = [
      { mass: 1, stiffness: 200, damping: 4 },
      { mass: 1, stiffness: 200, damping: 8 },
      { mass: 1, stiffness: 200, damping: 14 },
    ] as const;
    const initialTargets: Point[] = [
      { x: 240, y: 0 },
      { x: 240, y: 240 },
      { x: 0, y: 240 },
      { x: 420, y: 120 },
      { x: -240, y: 180 },
    ];
    const interceptSteps = [2, 4, 8, 12, 20, 32];
    const offsets: Point[] = [
      { x: 5, y: 220 },
      { x: 220, y: 5 },
      { x: 20, y: 300 },
      { x: 300, y: 20 },
      { x: -20, y: 180 },
      { x: 180, y: -20 },
      { x: -160, y: 15 },
      { x: 15, y: -160 },
      { x: 600, y: 10 },
      { x: 10, y: 600 },
    ];

    let cases = 0;
    for (const spring of springs) {
      for (const initial of initialTargets) {
        for (const beforeSteps of interceptSteps) {
          for (const offset of offsets) {
            cases++;
            const c = clock();
            let target: Point = { ...initial };
            let emitted: Point = { x: 0, y: 0 };
            const controls = createProjection({
              clamp: true,
              spring,
              requestFrame: c.requestFrame,
              onFrame(frames) {
                emitted = {
                  x: target.x + frames[0]!.tx,
                  y: target.y + frames[0]!.ty,
                };
              },
            });
            controls.play([
              {
                id: 'n',
                first: { x: 0, y: 0, width: 100, height: 100 },
                last: { x: target.x, y: target.y, width: 100, height: 100 },
              },
            ]);
            for (let i = 0; i < beforeSteps && controls.playing; i++) c.step();
            const pickup = controls.boxAt('n')!;
            target = { x: pickup.x + offset.x, y: pickup.y + offset.y };
            controls.play([
              { id: 'n', last: { x: target.x, y: target.y, width: 100, height: 100 } },
            ]);

            for (let frame = 0; frame < 240 && controls.playing; frame++) {
              const box = controls.boxAt('n')!;
              if (!close(box.x, emitted.x) || !close(box.y, emitted.y)) {
                throw new Error(
                  `CLAMP_STATE_DIVERGENCE ${JSON.stringify({ spring, initial, beforeSteps, offset, frame, progress: controls.progress, box: { x: box.x, y: box.y }, emitted })}`,
                );
              }
              c.step();
            }
            const box = controls.boxAt('n')!;
            expect(close(box.x, emitted.x) && close(box.y, emitted.y)).toBe(true);
          }
        }
      }
    }
    expect(cases).toBe(900);
  });
});
