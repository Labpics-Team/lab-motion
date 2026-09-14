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
    let targetY = 0;
    const controls = createProjection({
      clamp: true,
      spring: { mass: 1, stiffness: 200, damping: 14 },
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        ys.push(targetY + frames[0]!.ty);
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

    targetY = 100;
    controls.play([
      { id: 'card', last: { x: 300, y: targetY, width: 100, height: 100 } },
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

  it('repeated play at a held clamp boundary uses the emitted box and cannot revive outward velocity', () => {
    const clock = makeClock();
    const ys: number[] = [];
    let targetY = 0;
    const controls = createProjection({
      clamp: true,
      spring: { mass: 1, stiffness: 200, damping: 8 },
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        // ProjectionFrame.ty is local to the current last/anchor. Reconstruct
        // the page-space visual position against the target active for this run.
        ys.push(targetY + frames[0]!.ty);
      },
    });

    controls.play([
      {
        id: 'card',
        first: { x: 0, y: 0, width: 100, height: 100 },
        last: { x: 240, y: 0, width: 100, height: 100 },
      },
    ]);
    for (let i = 0; i < 12; i++) clock.step();

    targetY = 100;
    controls.play([
      { id: 'card', last: { x: 320, y: targetY, width: 100, height: 100 } },
    ]);

    // Stop while the visual output is pinned at the upper clamp edge but the
    // underlying spring is still live. This is the exact boundary where an
    // unbounded reconstruction could diverge from what the user actually saw.
    let hitBoundary = false;
    for (let i = 0; i < 1200 && controls.playing; i++) {
      clock.step();
      if (Math.abs((ys.at(-1) ?? NaN) - 100) < 1e-10 && controls.playing) {
        hitBoundary = true;
        break;
      }
    }
    expect(hitBoundary).toBe(true);
    const before = ys.at(-1)!;
    expect(before).toBeCloseTo(100, 10);
    expect(controls.boxAt('card')!.y).toBeCloseTo(before, 10);

    // Retarget inward while the old visual is pinned. C0 says the synchronous
    // pickup frame is exactly the emitted boundary, not an unclamped hidden box.
    targetY = 50;
    controls.play([
      { id: 'card', last: { x: 360, y: targetY, width: 100, height: 100 } },
    ]);
    expect(ys.at(-1)).toBeCloseTo(before, 10);

    // The next frame must move inward or stay pinned. An outward velocity that
    // was hidden behind the clamp must not be resurrected by the new run.
    clock.step();
    expect(ys.at(-1)!).toBeLessThanOrEqual(before + 1e-9);
  });

  it('boxAt and repeated pickup share the emitted per-axis clamp state', () => {
    const clock = makeClock();
    let target = { x: 240, y: 0 };
    let emitted = { x: 0, y: 0 };
    const controls = createProjection({
      clamp: true,
      spring: { mass: 1, stiffness: 200, damping: 4 },
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        emitted = {
          x: target.x + frames[0]!.tx,
          y: target.y + frames[0]!.ty,
        };
      },
    });

    controls.play([
      {
        id: 'card',
        first: { x: 0, y: 0, width: 100, height: 100 },
        last: { x: target.x, y: target.y, width: 100, height: 100 },
      },
    ]);
    clock.step(1000 / 120);
    clock.step(1000 / 120);

    const pickup = controls.boxAt('card')!;
    target = { x: pickup.x + 5, y: pickup.y + 220 };
    controls.play([
      { id: 'card', last: { x: target.x, y: target.y, width: 100, height: 100 } },
    ]);
    clock.step(1000 / 120);

    const before = { ...emitted };
    const analytical = controls.boxAt('card')!;
    expect(analytical.x).toBeCloseTo(before.x, 10);
    expect(analytical.y).toBeCloseTo(before.y, 10);
    // Non-vacuous witness: x is held at its upper pickup→target envelope while
    // the hidden homogeneous state would otherwise continue outside it.
    expect(before.x).toBeCloseTo(target.x, 10);

    target = { x: before.x - 40, y: before.y + 20 };
    controls.play([
      { id: 'card', last: { x: target.x, y: target.y, width: 100, height: 100 } },
    ]);
    expect(emitted.x).toBeCloseTo(before.x, 10);
    expect(emitted.y).toBeCloseTo(before.y, 10);

    // A velocity hidden beyond the old clamp edge is not a visible boundary
    // velocity. The next run may move inward, but cannot revive an outward kick.
    clock.step(1000 / 120);
    expect(emitted.x).toBeLessThanOrEqual(before.x + 1e-9);
  });

});
