import { describe, expect, it } from 'vitest';
import {
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  motionProgramIterationBoundaryV1,
  type MotionProgramTrackV1,
} from '../src/internal/motion-program.js';
import { SCHEDULE_V1_MAX_EXACT_ITERATION } from '../src/internal/schedule-v1.js';
import { evaluateMotionProgramScheduleV1 } from '../scripts/motion-program-semantics.js';

const bitsBuffer = new ArrayBuffer(8);
const bitsView = new DataView(bitsBuffer);

function adjacentFloat(value: number, direction: -1 | 1): number {
  bitsView.setFloat64(0, value, false);
  let bits = bitsView.getBigUint64(0, false);
  if (value === 0) return direction < 0 ? -Number.MIN_VALUE : Number.MIN_VALUE;
  bits += (direction > 0) === (value > 0) ? 1n : -1n;
  bitsView.setBigUint64(0, bits, false);
  return bitsView.getFloat64(0, false);
}

function track(
  startMs: number,
  durationMs: number,
  repeat: number,
  direction: MotionProgramTrackV1[4] = MOTION_PROGRAM_DIRECTION_V1.normal,
  repeatDelayMs = 0,
): MotionProgramTrackV1 {
  return [
    0,
    startMs,
    durationMs,
    repeat,
    direction,
    repeatDelayMs,
    MOTION_PROGRAM_COMPOSITE_V1.replace,
    [],
  ];
}

describe('MotionProgram V1 infinite schedule domain', () => {
  it('steps to the adjacent numeric float across both signs and zero', () => {
    expect(adjacentFloat(0, -1)).toBe(-Number.MIN_VALUE);
    expect(adjacentFloat(-0, 1)).toBe(Number.MIN_VALUE);
    expect(adjacentFloat(1, -1)).toBe(0.9999999999999999);
    expect(adjacentFloat(1, 1)).toBe(1.0000000000000002);
    expect(adjacentFloat(-1, -1)).toBe(-1.0000000000000002);
    expect(adjacentFloat(-1, 1)).toBe(-0.9999999999999999);
  });

  it('matches the finite greatest-boundary evaluator throughout the shared domain', () => {
    const cases = [
      [0.1, 1, 3],
      [-0.1, 1, 3],
      [10, 2, 1],
      [-1_000, 3, 0.5],
      [2 ** 60, 1_024, 2_048],
      [-(2 ** 60), 1_024, 2_048],
    ] as const;

    for (const [startMs, durationMs, repeatDelayMs] of cases) {
      const cycleMs = durationMs + repeatDelayMs;
      const infinite = track(
        startMs,
        durationMs,
        -1,
        MOTION_PROGRAM_DIRECTION_V1.alternate,
        repeatDelayMs,
      );
      const finite = track(
        startMs,
        durationMs,
        64,
        MOTION_PROGRAM_DIRECTION_V1.alternate,
        repeatDelayMs,
      );

      for (let iteration = 0; iteration <= 20; iteration++) {
        const boundary = motionProgramIterationBoundaryV1(startMs, cycleMs, iteration);
        for (const timeMs of [
          adjacentFloat(boundary, -1),
          boundary,
          adjacentFloat(boundary, 1),
        ]) {
          if (timeMs < startMs) continue;
          const infiniteSample = evaluateMotionProgramScheduleV1(infinite, timeMs);
          const finiteSample = evaluateMotionProgramScheduleV1(finite, timeMs);
          expect(infiniteSample.state).toBe(finiteSample.state);
          expect(infiniteSample.iteration).toBeNull();
          expect(infiniteSample.iterationParity).toBe(finiteSample.iterationParity);
          expect(infiniteSample.progress).toBe(finiteSample.progress);
          expect(infiniteSample.mirrored).toBe(finiteSample.mirrored);
        }
      }
    }
  });

  it('defines an exclusive horizon at the first non-exact iteration index', () => {
    const infinite = track(0, 1, -1, MOTION_PROGRAM_DIRECTION_V1.alternate);
    const lastBoundary = motionProgramIterationBoundaryV1(
      0,
      1,
      SCHEDULE_V1_MAX_EXACT_ITERATION,
    );
    const horizon = motionProgramIterationBoundaryV1(
      0,
      1,
      SCHEDULE_V1_MAX_EXACT_ITERATION + 1,
    );

    expect(evaluateMotionProgramScheduleV1(infinite, lastBoundary)).toMatchObject({
      iteration: null,
      iterationParity: 1,
      progress: 1,
    });
    expect(() => evaluateMotionProgramScheduleV1(infinite, horizon))
      .toThrowError(/^LMP_BOUNDS$/);
    expect(() => evaluateMotionProgramScheduleV1(infinite, adjacentFloat(horizon, 1)))
      .toThrowError(/^LMP_BOUNDS$/);

    const plateauStart = 13_475_415_410_688;
    const plateauCycle = 0.014899620437063277;
    const plateau = track(plateauStart, plateauCycle, -1);
    const lastExactBoundary = motionProgramIterationBoundaryV1(
      plateauStart,
      plateauCycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION,
    );
    expect(motionProgramIterationBoundaryV1(
      plateauStart,
      plateauCycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION + 1,
    )).toBe(lastExactBoundary);
    expect(() => evaluateMotionProgramScheduleV1(plateau, lastExactBoundary))
      .toThrowError(/^LMP_BOUNDS$/);
  });

  it('fails closed instead of inventing parity after collapsed huge boundaries', () => {
    const infinite = track(
      0,
      0.3,
      -1,
      MOTION_PROGRAM_DIRECTION_V1.alternate,
      0.2,
    );
    const timeMs = 2 ** 53;
    for (const probe of [adjacentFloat(timeMs, -1), timeMs, adjacentFloat(timeMs, 1)]) {
      expect(() => evaluateMotionProgramScheduleV1(infinite, probe))
        .toThrowError(/^LMP_BOUNDS$/);
    }
  });

  it('keeps zero-duration delay cycles directional inside the exact domain', () => {
    const infinite = track(
      -0.1,
      0,
      -1,
      MOTION_PROGRAM_DIRECTION_V1.alternate,
      4,
    );
    const boundary = motionProgramIterationBoundaryV1(-0.1, 4, 3);
    expect(evaluateMotionProgramScheduleV1(infinite, adjacentFloat(boundary, -1)))
      .toMatchObject({ iterationParity: 0, progress: 1 });
    expect(evaluateMotionProgramScheduleV1(infinite, boundary))
      .toMatchObject({ iterationParity: 1, progress: 0 });
    expect(evaluateMotionProgramScheduleV1(infinite, adjacentFloat(boundary, 1)))
      .toMatchObject({ iterationParity: 1, progress: 0 });
  });
});
