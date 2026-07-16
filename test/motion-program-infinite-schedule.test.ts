import { describe, expect, it } from 'vitest';
import {
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  motionProgramIterationBoundaryV1,
  type MotionProgramTrackV1,
} from '../src/internal/motion-program.js';
import {
  motionProgramInfiniteBoundaryAtOrBeforeV1,
  motionProgramInfiniteBoundaryV1,
} from '../scripts/motion-program-dyadic.js';
import { evaluateMotionProgramScheduleV1 } from '../scripts/motion-program-semantics.js';

const bitsBuffer = new ArrayBuffer(8);
const bitsView = new DataView(bitsBuffer);

function adjacentFloat(value: number, direction: -1 | 1): number {
  if (!Number.isFinite(value)) throw new Error('expected finite binary64');
  if (value === 0) return direction > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  bitsView.setFloat64(0, value, false);
  let bits = bitsView.getBigUint64(0, false);
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

describe('MotionProgram V1 infinite binary64 schedule', () => {
  it('ограничивает arbitrary BigInt точной границей неизбежного inner overflow', () => {
    // (2^1024 - 2^970) / 2^-1074: ниже ещё существует конечный результат,
    // на границе первая RN64 операция уже обязана вернуть +Infinity.
    const guaranteedOverflowIteration = ((1n << 54n) - 1n) << 2044n;
    const lastFiniteIteration = guaranteedOverflowIteration - 1n;

    expect(motionProgramInfiniteBoundaryV1(
      0,
      Number.MIN_VALUE,
      lastFiniteIteration,
    )).toBe(Number.MAX_VALUE);
    expect(motionProgramInfiniteBoundaryV1(
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      lastFiniteIteration,
    )).toBe(0);
    for (const startMs of [0, -Number.MAX_VALUE]) {
      expect(motionProgramInfiniteBoundaryV1(
        startMs,
        Number.MIN_VALUE,
        guaranteedOverflowIteration,
      )).toBe(Number.POSITIVE_INFINITY);
    }
    expect(motionProgramInfiniteBoundaryV1(
      0,
      Number.MIN_VALUE,
      1n << 1_000_000n,
    )).toBe(Number.POSITIVE_INFINITY);
  });

  it('сохраняет exact parity за safe quotient и выбирает последний collapsed boundary', () => {
    const startMs = 0.1;
    const durationMs = 2 ** -54;
    const infinite = track(
      startMs,
      durationMs,
      -1,
      MOTION_PROGRAM_DIRECTION_V1.alternate,
    );
    const probes = [
      [adjacentFloat(1, -1), 16_212_958_658_533_785n, 1],
      [1, 16_212_958_658_533_786n, 0],
      [adjacentFloat(1, 1), 16_212_958_658_533_790n, 0],
    ] as const;

    for (const [timeMs, expectedIteration, expectedParity] of probes) {
      const boundary = motionProgramInfiniteBoundaryAtOrBeforeV1(
        startMs,
        durationMs,
        timeMs,
      );
      expect(boundary).toEqual({ iteration: expectedIteration, boundaryMs: timeMs });
      expect(motionProgramInfiniteBoundaryV1(startMs, durationMs, expectedIteration + 1n))
        .toBe(adjacentFloat(timeMs, 1));

      const sample = evaluateMotionProgramScheduleV1(infinite, timeMs);
      expect(sample).toMatchObject({
        state: 'motion',
        iteration: null,
        iterationParity: expectedParity,
        progress: expectedParity,
        mirrored: false,
      });
    }
  });

  it('дифференциально совпадает с finite absolute-boundary oracle в safe диапазоне', () => {
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
        const exactBoundary = motionProgramIterationBoundaryV1(startMs, cycleMs, iteration);
        const probes = iteration === 0
          ? [exactBoundary, adjacentFloat(exactBoundary, 1)]
          : [
              adjacentFloat(exactBoundary, -1),
              exactBoundary,
              adjacentFloat(exactBoundary, 1),
            ];
        for (const timeMs of probes) {
          if (timeMs < startMs) continue;
          let bruteIteration = 0;
          for (let candidate = 1; candidate <= 64; candidate++) {
            if (motionProgramIterationBoundaryV1(startMs, cycleMs, candidate) <= timeMs) {
              bruteIteration = candidate;
            } else {
              break;
            }
          }
          const exact = motionProgramInfiniteBoundaryAtOrBeforeV1(startMs, cycleMs, timeMs);
          expect(exact.iteration, `${startMs}/${cycleMs} @ ${timeMs}`)
            .toBe(BigInt(bruteIteration));
          expect(exact.boundaryMs).toBe(
            motionProgramIterationBoundaryV1(startMs, cycleMs, bruteIteration),
          );

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

  it('сохраняет boundary sandwich на случайных масштабах и краях f64', () => {
    let state = 0x6d2b79f5;
    const random = (): number => {
      state = Math.imul(state ^ (state >>> 15), state | 1);
      state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
      return ((state ^ (state >>> 14)) >>> 0) / 2 ** 32;
    };

    for (let sample = 0; sample < 512; sample++) {
      const exponent = Math.floor(random() * 1_000) - 500;
      const cycleMs = 2 ** exponent * (1 + random());
      const startScale = 2 ** (exponent + Math.floor(random() * 17) - 8);
      const startMs = (random() < 0.5 ? -1 : 1) * startScale * (1 + random());
      if (!Number.isFinite(startMs + cycleMs) || !(startMs + cycleMs > startMs)) continue;
      const seedIteration = BigInt(1 + Math.floor(random() * 1_000_000));
      const boundaryMs = motionProgramIterationBoundaryV1(
        startMs,
        cycleMs,
        Number(seedIteration),
      );
      expect(motionProgramInfiniteBoundaryV1(startMs, cycleMs, seedIteration))
        .toBe(boundaryMs);

      for (const timeMs of [
        adjacentFloat(boundaryMs, -1),
        boundaryMs,
        adjacentFloat(boundaryMs, 1),
      ]) {
        if (!Number.isFinite(timeMs) || timeMs < startMs) continue;
        const exact = motionProgramInfiniteBoundaryAtOrBeforeV1(startMs, cycleMs, timeMs);
        expect(exact.boundaryMs, `${startMs}/${cycleMs} @ ${timeMs}`)
          .toBeLessThanOrEqual(timeMs);
        expect(motionProgramInfiniteBoundaryV1(startMs, cycleMs, exact.iteration + 1n))
          .toBeGreaterThan(timeMs);
      }
    }

    for (const [startMs, cycleMs, timeMs] of [
      [0, Number.MIN_VALUE, Number.MAX_VALUE],
      [-0.1, Number.MIN_VALUE, Number.MAX_VALUE],
      [-Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    ] as const) {
      const exact = motionProgramInfiniteBoundaryAtOrBeforeV1(startMs, cycleMs, timeMs);
      expect(exact.boundaryMs).toBeLessThanOrEqual(timeMs);
      expect(motionProgramInfiniteBoundaryV1(startMs, cycleMs, exact.iteration + 1n))
        .toBeGreaterThan(timeMs);
    }
  });

  it('оставляет zero-duration в delay и не изобретает terminal у infinite', () => {
    const infinite = track(
      -0.1,
      0,
      -1,
      MOTION_PROGRAM_DIRECTION_V1.alternate,
      4,
    );
    const boundary = motionProgramInfiniteBoundaryV1(-0.1, 4, 3n);
    expect(evaluateMotionProgramScheduleV1(infinite, adjacentFloat(boundary, -1)))
      .toMatchObject({ state: 'repeatDelay', iteration: null, iterationParity: 0, progress: 1 });
    expect(evaluateMotionProgramScheduleV1(infinite, boundary))
      .toMatchObject({ state: 'repeatDelay', iteration: null, iterationParity: 1, progress: 0 });
    expect(evaluateMotionProgramScheduleV1(infinite, adjacentFloat(boundary, 1)))
      .toMatchObject({ state: 'repeatDelay', iteration: null, iterationParity: 1, progress: 0 });
  });
});
