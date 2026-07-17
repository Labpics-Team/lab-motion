import { describe, expect, it } from 'vitest';
import {
  isScheduleV1Representable,
  scheduleV1Binary64Gap,
  scheduleV1GreatestIterationAtOrBefore,
  scheduleV1IterationBoundary,
  SCHEDULE_V1_INT32_MAX,
  SCHEDULE_V1_ITERATION_OUT_OF_RANGE,
  SCHEDULE_V1_MAX_EXACT_ITERATION,
} from '../src/internal/schedule-v1.js';

function greatestBoundaryOracle(
  start: number,
  cycle: number,
  repeat: number,
  time: number,
): number {
  let low = 0;
  let high = repeat;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (scheduleV1IterationBoundary(start, cycle, middle) <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

function adjacentFloat(value: number, direction: -1 | 1): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  view.setBigUint64(0, view.getBigUint64(0, false) + BigInt(direction), false);
  return view.getFloat64(0, false);
}

describe('schedule V1 — portable numeric contract', () => {
  it('rejects values outside the finite int32 wire domain', () => {
    expect(isScheduleV1Representable(0, 1, 0, 0)).toBe(true);
    expect(isScheduleV1Representable(0, 1, SCHEDULE_V1_INT32_MAX, 0)).toBe(true);
    expect(isScheduleV1Representable(0, 1, -1, 0)).toBe(true);

    for (const [start, duration, repeat, repeatDelay] of [
      [NaN, 1, 0, 0],
      [Infinity, 1, 0, 0],
      [-Infinity, 1, 0, 0],
      [0, NaN, 0, 0],
      [0, Infinity, 0, 0],
      [0, -1, 0, 0],
      [0, 1, -2, 0],
      [0, 1, 0.5, 0],
      [0, 1, SCHEDULE_V1_INT32_MAX + 1, 0],
      [0, 1, 0, NaN],
      [0, 1, 0, Infinity],
      [0, 1, 0, -1],
    ] as const) {
      expect(
        isScheduleV1Representable(start, duration, repeat, repeatDelay),
        `${start}/${duration}/${repeat}/${repeatDelay}`,
      ).toBe(false);
    }
  });

  it('guards absolute overflow, collapsed addends and zero infinite cycles', () => {
    expect(isScheduleV1Representable(-Number.MAX_VALUE, Number.MAX_VALUE, 0, 0))
      .toBe(true);
    expect(isScheduleV1Representable(0, 1, 0, 2 ** 60)).toBe(true);
    expect(isScheduleV1Representable(2 ** 60, 1, 0, 0)).toBe(false);
    expect(isScheduleV1Representable(0, 2 ** 60, -1, 1)).toBe(false);
    expect(isScheduleV1Representable(0, 1, -1, 2 ** 60)).toBe(false);
    expect(isScheduleV1Representable(2 ** 60, 0, -1, 1)).toBe(false);
    expect(isScheduleV1Representable(0, 0, -1, 0)).toBe(false);
    expect(isScheduleV1Representable(0, Number.MAX_VALUE / 2, 3, 0)).toBe(false);
    expect(isScheduleV1Representable(2 ** 53 - 1, 1, 1, 0)).toBe(false);
  });

  it('uses the product plus twice absolute gap budget, not a relative-only proxy', () => {
    expect(isScheduleV1Representable(2 ** 60, 300, 1, 300)).toBe(false);
    expect(isScheduleV1Representable(0, 3e-7, SCHEDULE_V1_INT32_MAX, 1))
      .toBe(false);

    // The last iteration is near zero, but the absolute start still owns the
    // 256-unit gap. A min-magnitude or product-only budget would accept this.
    const cycle = 2 ** 29;
    expect(isScheduleV1Representable(
      -(2 ** 60),
      300,
      SCHEDULE_V1_INT32_MAX,
      cycle - 300,
    )).toBe(false);

    expect(isScheduleV1Representable(2 ** 60, 1024, 2, 1024)).toBe(true);
  });

  it('pins the RN64 operation order and adjacent-gap estimator', () => {
    expect(scheduleV1IterationBoundary(0.1, 0.1 + 0.2, 3))
      .toBe(3 * (0.1 + 0.2) + 0.1);
    expect(scheduleV1IterationBoundary(-(2 ** 60), 2 ** 29, SCHEDULE_V1_INT32_MAX))
      .toBe(SCHEDULE_V1_INT32_MAX * (2 ** 29) - 2 ** 60);

    expect(scheduleV1Binary64Gap(0)).toBe(Number.MIN_VALUE);
    expect(scheduleV1Binary64Gap(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(scheduleV1Binary64Gap(1)).toBe(Number.EPSILON);
    expect(scheduleV1Binary64Gap(2)).toBe(2 * Number.EPSILON);
    expect(scheduleV1Binary64Gap(2 ** 60)).toBe(256);
    expect(scheduleV1Binary64Gap(-(2 ** 60))).toBe(256);
  });

  it('matches a bounded greatest-boundary oracle across quotient drift', () => {
    let seed = 0x51ce_affe;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let sample = 0; sample < 5_000; sample++) {
      const exponent = Math.floor(random() * 80) - 40;
      const cycle = 2 ** exponent * (1 + random());
      const start = (random() < 0.5 ? -1 : 1) *
        2 ** (exponent + Math.floor(random() * 21) - 10) * (1 + random());
      const repeat = Math.floor(random() * SCHEDULE_V1_INT32_MAX);
      const iteration = Math.floor(random() * (repeat + 1));
      const boundary = scheduleV1IterationBoundary(start, cycle, iteration);
      if (!Number.isFinite(boundary)) continue;
      for (const time of [boundary, boundary - Math.abs(boundary) * Number.EPSILON]) {
        if (time < start) continue;
        expect(scheduleV1GreatestIterationAtOrBefore(start, cycle, repeat, time))
          .toBe(greatestBoundaryOracle(start, cycle, repeat, time));
      }
    }
  });

  it('uses nondecreasing absolute boundaries through plateaus and cancellation', () => {
    for (const [start, cycle, repeat, time] of [
      [2 ** 60, 64, 32, 2 ** 60],
      [-(2 ** 60), 2 ** 40, 2_000_000, 0],
      [0, 0.3, 5, 6 * 0.3],
      [0.1, 0.1 + 1.8, 1, 2],
    ] as const) {
      expect(scheduleV1GreatestIterationAtOrBefore(start, cycle, repeat, time))
        .toBe(greatestBoundaryOracle(start, cycle, repeat, time));
    }
  });

  it('makes the first non-exact infinite iteration an exclusive horizon', () => {
    const start = 13_475_415_410_688;
    const cycle = 0.014899620437063277;
    const last = scheduleV1IterationBoundary(
      start,
      cycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION,
    );
    const firstUnsafe = scheduleV1IterationBoundary(
      start,
      cycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION + 1,
    );
    expect(firstUnsafe).toBe(last);
    expect(scheduleV1GreatestIterationAtOrBefore(start, cycle, -1, firstUnsafe))
      .toBe(SCHEDULE_V1_ITERATION_OUT_OF_RANGE);

    expect(scheduleV1GreatestIterationAtOrBefore(0, 1, -1, Number.MAX_SAFE_INTEGER))
      .toBe(Number.MAX_SAFE_INTEGER);
    expect(scheduleV1GreatestIterationAtOrBefore(0, 1, -1, 2 ** 53))
      .toBe(SCHEDULE_V1_ITERATION_OUT_OF_RANGE);

    // Absolute cancellation can round the unsafe horizon onto the last safe
    // boundary while the local quotient rounds down to MAX_SAFE_INTEGER.
    // The boundary owns the contract: quotient safety alone must not admit it.
    const collapsedStart = 1;
    const collapsedCycle = 1;
    const collapsedLast = scheduleV1IterationBoundary(
      collapsedStart,
      collapsedCycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION,
    );
    const collapsedHorizon = scheduleV1IterationBoundary(
      collapsedStart,
      collapsedCycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION + 1,
    );
    expect(collapsedHorizon).toBe(collapsedLast);
    expect(Math.floor((collapsedHorizon - collapsedStart) / collapsedCycle))
      .toBe(SCHEDULE_V1_MAX_EXACT_ITERATION);
    expect(scheduleV1GreatestIterationAtOrBefore(
      collapsedStart,
      collapsedCycle,
      -1,
      collapsedHorizon,
    )).toBe(SCHEDULE_V1_ITERATION_OUT_OF_RANGE);

    const cancelledStart = 17217827061897274;
    const cancelledCycle = 1.1714226258918643;
    const cancelledHorizon = scheduleV1IterationBoundary(
      cancelledStart,
      cancelledCycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION + 1,
    );
    expect(Math.floor((cancelledHorizon - cancelledStart) / cancelledCycle))
      .toBe(SCHEDULE_V1_MAX_EXACT_ITERATION - 1);
    expect(scheduleV1GreatestIterationAtOrBefore(
      cancelledStart,
      cancelledCycle,
      -1,
      cancelledHorizon,
    )).toBe(SCHEDULE_V1_ITERATION_OUT_OF_RANGE);

    // The quotient can round up to an unsafe integer one ULP before the
    // horizon. Boundary comparison, not quotient safety, owns the decision.
    const roundedStart = 112_065_955_424;
    const roundedCycle = 59.340130001306534;
    const roundedHorizon = scheduleV1IterationBoundary(
      roundedStart,
      roundedCycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION + 1,
    );
    const beforeHorizon = adjacentFloat(roundedHorizon, -1);
    expect(Number.isSafeInteger(Math.floor(
      (beforeHorizon - roundedStart) / roundedCycle,
    ))).toBe(false);
    expect(scheduleV1GreatestIterationAtOrBefore(
      roundedStart,
      roundedCycle,
      -1,
      beforeHorizon,
    )).toBe(SCHEDULE_V1_MAX_EXACT_ITERATION);
    expect(scheduleV1GreatestIterationAtOrBefore(
      roundedStart,
      roundedCycle,
      -1,
      roundedHorizon,
    )).toBe(SCHEDULE_V1_ITERATION_OUT_OF_RANGE);
  });
});
