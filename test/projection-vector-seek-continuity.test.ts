import { describe, expect, it } from 'vitest';
import { createProjection, type ProjectionFrame } from '../src/projection/index.js';

const STEP_MS = 1000 / 60;

function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  let now = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return queue.length;
    },
    step(): void {
      now += STEP_MS;
      const cb = queue.shift();
      if (cb === undefined) throw new Error('projection seek witness: no frame queued');
      cb(now);
    },
  };
}

function pagePosition(frame: ProjectionFrame, last: { x: number; y: number }) {
  return { x: last.x + frame.tx, y: last.y + frame.ty };
}

describe('projection vector seek continuity', () => {
  it('seek на текущем progress сохраняет накопленный Q-базис и release не телепортирует кадр', () => {
    const clock = makeClock();
    let latest: ProjectionFrame | undefined;
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        latest = { ...frames[0]! };
      },
    });

    const first = { x: 0, y: 0, width: 100, height: 100 };
    const horizontal = { x: 200, y: 0, width: 100, height: 100 };
    const retargeted = { x: 300, y: 100, width: 100, height: 100 };

    controls.play([{ id: 'card', first, last: horizontal }]);
    for (let i = 0; i < 8; i++) clock.step();
    controls.play([{ id: 'card', last: retargeted }]);
    clock.step();

    const beforeSeek = pagePosition(latest!, retargeted);
    const heldProgress = controls.progress;
    controls.seek(heldProgress);
    const afterSeek = pagePosition(latest!, retargeted);

    expect(afterSeek.x).toBeCloseTo(beforeSeek.x, 10);
    expect(afterSeek.y).toBeCloseTo(beforeSeek.y, 10);
    expect(controls.velocity).toBe(0);
    expect(controls.playing).toBe(true);

    controls.release();
    const afterRelease = pagePosition(latest!, retargeted);
    expect(afterRelease.x).toBeCloseTo(afterSeek.x, 10);
    expect(afterRelease.y).toBeCloseTo(afterSeek.y, 10);
  });
});
