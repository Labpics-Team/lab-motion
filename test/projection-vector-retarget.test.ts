import { describe, expect, it } from 'vitest';
import { createProjection, type ProjectionFrame } from '../src/projection/index.js';

const SPRING = { mass: 1, stiffness: 200, damping: 24 } as const;
const STEP_S = 1 / 60;
const STEP_MS = STEP_S * 1000;

function makeClock(): {
  readonly requestFrame: (cb: (ts?: number) => void) => number;
  step(ms: number): void;
  failNextRequest(): void;
} {
  const queue: Array<(ts?: number) => void> = [];
  let now = 0;
  let failNext = false;
  return {
    requestFrame(cb): number {
      if (failNext) {
        failNext = false;
        throw new Error('projection vector witness: injected requestFrame failure');
      }
      queue.push(cb);
      return queue.length;
    },
    step(ms): void {
      now += ms;
      const cb = queue.shift();
      if (cb === undefined) throw new Error('projection vector witness: no frame queued');
      cb(now);
    },
    failNextRequest(): void {
      failNext = true;
    },
  };
}

/**
 * Independent second-order oracle. It deliberately does not import solveSpring or
 * any projection evaluator. Small fixed RK4 steps make the comparison about the
 * physical boundary condition, not about sharing implementation machinery.
 */
function integrateSpring(
  x0: number,
  v0: number,
  target: number,
  dt: number,
  subdivisions = 2048,
): { x: number; v: number } {
  let x = x0;
  let v = v0;
  const h = dt / subdivisions;
  const accel = (position: number, velocity: number): number =>
    (SPRING.stiffness * (target - position) - SPRING.damping * velocity) / SPRING.mass;

  for (let i = 0; i < subdivisions; i++) {
    const k1x = v;
    const k1v = accel(x, v);

    const k2x = v + (h * k1v) / 2;
    const k2v = accel(x + (h * k1x) / 2, v + (h * k1v) / 2);

    const k3x = v + (h * k2v) / 2;
    const k3v = accel(x + (h * k2x) / 2, v + (h * k2v) / 2);

    const k4x = v + h * k3v;
    const k4v = accel(x + h * k3x, v + h * k3v);

    x += (h * (k1x + 2 * k2x + 2 * k3x + k4x)) / 6;
    v += (h * (k1v + 2 * k2v + 2 * k3v + k4v)) / 6;
  }
  return { x, v };
}

type FrameSnap = Pick<ProjectionFrame, 'id' | 'tx' | 'ty' | 'kx' | 'ky'>;

function copyFrames(frames: readonly ProjectionFrame[]): FrameSnap[] {
  return frames.map(({ id, tx, ty, kx, ky }) => ({ id, tx, ty, kx, ky }));
}

function frameById(frames: readonly FrameSnap[], id: string): FrameSnap {
  const frame = frames.find((candidate) => candidate.id === id);
  if (frame === undefined) throw new Error(`projection vector witness: missing frame ${id}`);
  return frame;
}

describe('projection vector retarget continuity', () => {
  it('a horizontal flight does not acquire vertical boundary velocity when the target gains y', () => {
    const clock = makeClock();
    const yTransforms: number[] = [];
    const controls = createProjection({
      spring: SPRING,
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        yTransforms.push(frames[0]!.ty);
      },
    });

    const first = { x: 0, y: 0, width: 100, height: 100 };
    const horizontal = { x: 200, y: 0, width: 100, height: 100 };
    const retargeted = { x: 300, y: 100, width: 100, height: 100 };

    controls.play([{ id: 'card', first, last: horizontal }]);
    for (let i = 0; i < 8; i++) clock.step(STEP_MS);
    expect(Math.abs(controls.velocity)).toBeGreaterThan(0.1);

    controls.play([{ id: 'card', last: retargeted }]);
    const boundaryY = retargeted.y + yTransforms[yTransforms.length - 1]!;
    expect(boundaryY).toBeCloseTo(0, 10);

    const oracle = integrateSpring(0, 0, retargeted.y, STEP_S);
    clock.step(STEP_MS);
    const actualY = retargeted.y + yTransforms[yTransforms.length - 1]!;

    expect(Number.isFinite(actualY)).toBe(true);
    expect(Math.abs(actualY - oracle.x)).toBeLessThan(0.02);
  });

  it('requestFrame failure cancels carried vector velocity before a retry', () => {
    const clock = makeClock();
    let latest: FrameSnap[] = [];
    const controls = createProjection({
      spring: SPRING,
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        latest = copyFrames(frames);
      },
    });

    const first = { x: 0, y: 0, width: 100, height: 100 };
    const target1 = { x: 200, y: 0, width: 100, height: 100 };
    const target2 = { x: 300, y: 100, width: 100, height: 100 };
    const target3 = { x: 120, y: -80, width: 100, height: 100 };

    controls.play([{ id: 'card', first, last: target1 }]);
    for (let i = 0; i < 8; i++) clock.step(STEP_MS);
    controls.play([{ id: 'card', last: target2 }]);

    // The frame itself is emitted successfully. Only re-arming the next frame
    // throws, so the cancellation boundary has an unambiguous frozen visual box.
    clock.failNextRequest();
    expect(() => clock.step(STEP_MS)).toThrow('injected requestFrame failure');
    const frozen = frameById(latest, 'card');
    const frozenX = target2.x + frozen.tx;
    const frozenY = target2.y + frozen.ty;
    expect(controls.playing).toBe(false);
    expect(controls.velocity).toBe(0);

    controls.play([{ id: 'card', last: target3 }]);
    const boundary = frameById(latest, 'card');
    expect(target3.x + boundary.tx).toBeCloseTo(frozenX, 10);
    expect(target3.y + boundary.ty).toBeCloseTo(frozenY, 10);

    const expectedX = integrateSpring(frozenX, 0, target3.x, STEP_S);
    const expectedY = integrateSpring(frozenY, 0, target3.y, STEP_S);
    clock.step(STEP_MS);
    const retried = frameById(latest, 'card');
    expect(Math.abs(target3.x + retried.tx - expectedX.x)).toBeLessThan(0.03);
    expect(Math.abs(target3.y + retried.ty - expectedY.x)).toBeLessThan(0.03);
  });

  it('repeated 2D retarget preserves the already-carried x/y state against an independent oracle', () => {
    const clock = makeClock();
    let latest: FrameSnap[] = [];
    const controls = createProjection({
      spring: SPRING,
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        latest = copyFrames(frames);
      },
    });

    const first = { x: 0, y: 0, width: 100, height: 100 };
    const target1 = { x: 200, y: 40, width: 100, height: 100 };
    const target2 = { x: 320, y: -60, width: 100, height: 100 };
    const target3 = { x: 120, y: 180, width: 100, height: 100 };

    controls.play([{ id: 'card', first, last: target1 }]);
    for (let i = 0; i < 8; i++) clock.step(STEP_MS);

    let ox = integrateSpring(first.x, 0, target1.x, 8 * STEP_S);
    let oy = integrateSpring(first.y, 0, target1.y, 8 * STEP_S);
    let frame = frameById(latest, 'card');
    expect(Math.abs(target1.x + frame.tx - ox.x)).toBeLessThan(0.02);
    expect(Math.abs(target1.y + frame.ty - oy.x)).toBeLessThan(0.02);

    controls.play([{ id: 'card', last: target2 }]);
    for (let i = 0; i < 5; i++) clock.step(STEP_MS);
    ox = integrateSpring(ox.x, ox.v, target2.x, 5 * STEP_S);
    oy = integrateSpring(oy.x, oy.v, target2.y, 5 * STEP_S);
    frame = frameById(latest, 'card');
    expect(Math.abs(target2.x + frame.tx - ox.x)).toBeLessThan(0.03);
    expect(Math.abs(target2.y + frame.ty - oy.x)).toBeLessThan(0.03);

    controls.play([{ id: 'card', last: target3 }]);
    ox = integrateSpring(ox.x, ox.v, target3.x, STEP_S);
    oy = integrateSpring(oy.x, oy.v, target3.y, STEP_S);
    clock.step(STEP_MS);
    frame = frameById(latest, 'card');
    expect(Math.abs(target3.x + frame.tx - ox.x)).toBeLessThan(0.03);
    expect(Math.abs(target3.y + frame.ty - oy.x)).toBeLessThan(0.03);
  });

  it('keeps a corrected child in independent page-space under a moving, scaling parent', () => {
    const clock = makeClock();
    let latest: FrameSnap[] = [];
    const controls = createProjection({
      spring: SPRING,
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        latest = copyFrames(frames);
      },
    });

    const parent0 = { x: 0, y: 0, width: 100, height: 100 };
    const parent1 = { x: 100, y: 0, width: 160, height: 140 };
    const parent2 = { x: 150, y: 80, width: 200, height: 160 };
    const child0 = { x: 20, y: 20, width: 20, height: 20 };
    const child1 = { x: 140, y: 30, width: 20, height: 20 };
    const child2 = { x: 230, y: 160, width: 20, height: 20 };

    controls.play([
      { id: 'parent', first: parent0, last: parent1 },
      { id: 'child', parent: 'parent', first: child0, last: child1 },
    ]);
    for (let i = 0; i < 7; i++) clock.step(STEP_MS);

    const px = integrateSpring(parent0.x, 0, parent1.x, 7 * STEP_S);
    const py = integrateSpring(parent0.y, 0, parent1.y, 7 * STEP_S);
    const cx = integrateSpring(child0.x, 0, child1.x, 7 * STEP_S);
    const cy = integrateSpring(child0.y, 0, child1.y, 7 * STEP_S);

    controls.play([
      { id: 'parent', last: parent2 },
      { id: 'child', parent: 'parent', last: child2 },
    ]);
    const expectedParentX = integrateSpring(px.x, px.v, parent2.x, STEP_S);
    const expectedParentY = integrateSpring(py.x, py.v, parent2.y, STEP_S);
    const expectedChildX = integrateSpring(cx.x, cx.v, child2.x, STEP_S);
    const expectedChildY = integrateSpring(cy.x, cy.v, child2.y, STEP_S);
    clock.step(STEP_MS);

    const parent = frameById(latest, 'parent');
    const child = frameById(latest, 'child');
    const parentPageX = parent2.x + parent.tx;
    const parentPageY = parent2.y + parent.ty;
    const childPageX = parentPageX + parent.kx * (child2.x - parent2.x + child.tx);
    const childPageY = parentPageY + parent.ky * (child2.y - parent2.y + child.ty);

    expect(Math.abs(parentPageX - expectedParentX.x)).toBeLessThan(0.03);
    expect(Math.abs(parentPageY - expectedParentY.x)).toBeLessThan(0.03);
    expect(Math.abs(childPageX - expectedChildX.x)).toBeLessThan(0.03);
    expect(Math.abs(childPageY - expectedChildY.x)).toBeLessThan(0.03);
  });
});
