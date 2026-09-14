import { describe, expect, it } from 'vitest';
import { createProjection } from '../src/projection/index.js';

const SPRING = { mass: 1, stiffness: 200, damping: 24 } as const;
const STEP_S = 1 / 60;
const STEP_MS = STEP_S * 1000;

function makeClock(): {
  readonly requestFrame: (cb: (ts?: number) => void) => number;
  step(ms: number): void;
} {
  const queue: Array<(ts?: number) => void> = [];
  let now = 0;
  return {
    requestFrame(cb): number {
      queue.push(cb);
      return queue.length;
    },
    step(ms): void {
      now += ms;
      const cb = queue.shift();
      if (cb === undefined) throw new Error('projection vector witness: no frame queued');
      cb(now);
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
    expect(Math.abs(controls.velocity)).toBeGreaterThan(0.1); // horizontal flight is genuinely live

    // first omitted => analytical pickup of the current visual box.
    controls.play([{ id: 'card', last: retargeted }]);
    const boundaryY = retargeted.y + yTransforms[yTransforms.length - 1]!;
    expect(boundaryY).toBeCloseTo(0, 10); // C0: old y was stationary at zero

    // Before retarget the y channel had zero range and therefore exactly vy=0.
    // A target change may create acceleration, but not an instantaneous y impulse.
    const oracle = integrateSpring(0, 0, retargeted.y, STEP_S);
    clock.step(STEP_MS);
    const actualY = retargeted.y + yTransforms[yTransforms.length - 1]!;

    expect(Number.isFinite(actualY)).toBe(true);
    expect(Math.abs(actualY - oracle.x)).toBeLessThan(0.02);
  });
});
