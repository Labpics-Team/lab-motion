import { describe, expect, it } from 'vitest';
import { createProjection } from '../src/projection/index.js';

function clock() {
  const q: Array<(ts?: number) => void> = [];
  let now = 0;
  return {
    requestFrame(cb: (ts?: number) => void) { q.push(cb); return q.length; },
    step(ms = 1000 / 240) { now += ms; const cb = q.shift(); if (!cb) throw new Error('no frame'); cb(now); },
  };
}

describe('vector clamp probe', () => {
  it('changed-target vector correction remains continuous and bounded under clamp:true', () => {
    const c = clock();
    const ys: number[] = [];
    const controls = createProjection({
      clamp: true,
      spring: { mass: 1, stiffness: 200, damping: 14 },
      requestFrame: c.requestFrame,
      onFrame(frames) { ys.push(100 + frames[0]!.ty); },
    });
    controls.play([{ id: 'a', first: { x: 0, y: 0, width: 100, height: 100 }, last: { x: 200, y: 0, width: 100, height: 100 } }]);
    for (let i = 0; i < 20; i++) c.step();
    controls.play([{ id: 'a', last: { x: 300, y: 100, width: 100, height: 100 } }]);
    for (let i = 0; i < 240 && controls.playing; i++) c.step();

    let maxJump = 0;
    for (let i = 1; i < ys.length; i++) maxJump = Math.max(maxJump, Math.abs(ys[i]! - ys[i - 1]!));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(100 + 1e-9);
    }
    expect(maxJump).toBeLessThan(2);
    expect(ys.at(-1)).toBeCloseTo(100, 9);
  });
});
