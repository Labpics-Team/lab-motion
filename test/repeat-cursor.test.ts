import { describe, expect, it } from 'vitest';
import {
  isRepeatCount,
  isRepeatScheduleRepresentable,
  repeatCursor,
  repeatDuration,
  repeatEndTime,
} from '../src/internal/repeat-cursor.js';
import { sampleKeyframesUnchecked } from '../src/internal/sample-keyframes.js';

const LOOP = 0;
const REVERSE = 1;
const MIRROR = 2;

function adjacentFloat(value: number, direction: -1 | 1): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  if (value === 0) return direction < 0 ? -Number.MIN_VALUE : Number.MIN_VALUE;
  bits += (direction > 0) === (value > 0) ? 1n : -1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function oracle(
  time: number,
  duration: number,
  repeat: number,
  repeatDelay: number,
  direction: 0 | 1 | 2,
): readonly [progress: number, mirrored: boolean] {
  const t = Number.isNaN(time) || time < 0 || time === -Infinity
    ? 0
    : time === Infinity
      ? Number.MAX_VALUE
      : time;
  const total = repeat === Infinity
    ? Infinity
    : duration * (repeat + 1) + repeatDelay * repeat;
  let iteration: number;
  let progress: number;
  if (total !== Infinity && t >= total) {
    iteration = repeat;
    progress = 1;
  } else {
    const cycle = duration + repeatDelay;
    iteration = Math.floor(t / cycle);
    let boundary = iteration * cycle;
    const local = t - boundary;
    progress = duration === 0 || local >= duration ? 1 : local / duration;
  }
  if ((iteration & 1) === 0 || direction === LOOP) return [progress, false];
  return direction === REVERSE ? [1 - progress, false] : [progress, true];
}

function read(
  time: number,
  duration: number,
  repeat: number,
  repeatDelay: number,
  direction: 0 | 1 | 2,
): readonly [progress: number, mirrored: boolean] {
  const cursor = repeatCursor(time, 0, duration, repeat, repeatDelay, direction);
  return [cursor < 0 ? -1 - cursor : cursor, cursor < 0];
}

describe('internal repeat cursor — exact boundaries', () => {
  it('an exact intermediate boundary starts the next iteration', () => {
    const boundary = 1.5;
    const before = adjacentFloat(boundary, -1);
    const after = adjacentFloat(boundary, 1);

    expect(read(before, 1, 2, 0.5, LOOP)[0]).toBe(1);
    expect(read(boundary, 1, 2, 0.5, LOOP)).toEqual([0, false]);
    expect(read(after, 1, 2, 0.5, LOOP)[0]).toBeGreaterThan(0);

    expect(read(boundary, 1, 2, 0.5, REVERSE)).toEqual([1, false]);
    expect(read(boundary, 1, 2, 0.5, MIRROR)).toEqual([0, true]);
    expect(read(after, 1, 2, 0.5, MIRROR)[1]).toBe(true);
  });

  it('repeatDelay holds the directional end and terminal never restarts', () => {
    expect(read(1, 1, 2, 0.5, LOOP)).toEqual([1, false]);
    expect(read(1.25, 1, 2, 0.5, LOOP)).toEqual([1, false]);
    expect(read(4, 1, 2, 0.5, LOOP)).toEqual([1, false]);

    expect(read(2.5, 1, 2, 0.5, REVERSE)).toEqual([0, false]);
    expect(read(2.5, 1, 2, 0.5, MIRROR)).toEqual([1, true]);
  });

  it('zero-duration iterations are finite endpoint holds', () => {
    expect(read(0, 0, 2, 1, LOOP)).toEqual([1, false]);
    expect(read(1, 0, 2, 1, REVERSE)).toEqual([0, false]);
    expect(read(1, 0, 2, 1, MIRROR)).toEqual([1, true]);
    expect(read(2, 0, 2, 1, MIRROR)).toEqual([1, false]);
    expect(read(0, 0, 1, 0, MIRROR)).toEqual([1, true]);
  });

  it('keeps exact ownership across many dyadic iteration boundaries', () => {
    for (const iteration of [1, 2, 3, 17, 1024, 65_535]) {
      const boundary = iteration * 1.5;
      const currentOdd = iteration % 2 === 1;
      expect(read(boundary, 1, Infinity, 0.5, LOOP)).toEqual([0, false]);
      expect(read(boundary, 1, Infinity, 0.5, REVERSE)).toEqual([
        currentOdd ? 1 : 0,
        false,
      ]);
      expect(read(boundary, 1, Infinity, 0.5, MIRROR)).toEqual([0, currentOdd]);
    }
  });

  it('fails closed when the iteration quotient exceeds exact integers', () => {
    const cycle = 0.25;
    const boundary = (Number.MAX_SAFE_INTEGER + 1) * cycle;
    expect(Number.isSafeInteger(boundary / cycle)).toBe(false);
    for (const direction of [LOOP, REVERSE, MIRROR] as const) {
      expect(() => read(boundary, cycle, Infinity, 0, direction))
        .toThrowError(/^LM166$/);
    }

    // Cancellation can make the unsafe absolute boundary look like a safe
    // local quotient. The portable iteration horizon still owns the result.
    const start = 17217827061897274;
    const cancelledCycle = 1.1714226258918643;
    const cancelledBoundary = (Number.MAX_SAFE_INTEGER + 1) * cancelledCycle + start;
    expect(Math.floor((cancelledBoundary - start) / cancelledCycle))
      .toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(() => repeatCursor(
      cancelledBoundary,
      start,
      cancelledCycle,
      Infinity,
      0,
      MIRROR,
    )).toThrowError(/^LM166$/);
  });

  it('corrects rounded quotients at non-dyadic boundaries and adjacent f64s', () => {
    const duration = 0.011033099297893681;
    const repeatDelay = 0.1715438950554995;
    const cycle = duration + repeatDelay;
    const boundary = cycle * 11;

    expect(Math.floor(boundary / cycle)).toBe(10); // hostile proof for naïve floor
    expect(read(adjacentFloat(boundary, -1), duration, 20, repeatDelay, LOOP)).toEqual([1, false]);
    expect(read(boundary, duration, 20, repeatDelay, LOOP)).toEqual([0, false]);
    expect(read(boundary, duration, 20, repeatDelay, REVERSE)).toEqual([1, false]);
    expect(read(boundary, duration, 20, repeatDelay, MIRROR)).toEqual([0, true]);
    expect(read(adjacentFloat(boundary, 1), duration, 20, repeatDelay, LOOP)[0]).toBeGreaterThan(0);
  });

  it('intentionally starts the exact boundary where Motion 12.42.2 holds the previous end', () => {
    // Motion's quotient keeps the previous endpoint through +1 ULP. V1 and
    // native WAAPI instead make the stored boundary the next iteration start.
    const duration = 379.102574955;
    const repeatDelay = 147.760447036;
    const cycle = duration + repeatDelay;
    const boundary = 3 * cycle;
    const plusOneUlp = adjacentFloat(boundary, 1);
    const plusTwoUlp = adjacentFloat(plusOneUlp, 1);

    expect(boundary).toBe(1580.5890659729998);
    expect(plusOneUlp).toBe(1580.5890659730001);
    expect(read(boundary, duration, Infinity, repeatDelay, LOOP)).toEqual([0, false]);
    expect(read(plusOneUlp, duration, Infinity, repeatDelay, LOOP)[0]).toBeGreaterThan(0);
    expect(read(plusTwoUlp, duration, Infinity, repeatDelay, LOOP)[0]).toBeGreaterThan(
      read(plusOneUlp, duration, Infinity, repeatDelay, LOOP)[0],
    );
  });

  it('corrects a rounded-up quotient immediately before a boundary', () => {
    const cycle = 6.491769549903529;
    const boundary = cycle * 5_070_732;
    const before = adjacentFloat(boundary, -1);
    expect(Math.floor(before / cycle) * cycle).toBeGreaterThan(before);
    expect(read(before, cycle, Infinity, 0, LOOP)[0]).toBeGreaterThan(0.999_999);
    expect(read(before, cycle, Infinity, 0, REVERSE)[0]).toBeLessThan(0.000_001);
    expect(read(before, cycle, Infinity, 0, MIRROR)[1]).toBe(true);
  });

  it('does not guess phase or parity at an unsafe quotient', () => {
    const time = 3_000_000_000_000_001;
    const duration = 0.3;
    expect(Number.isSafeInteger(Math.floor(time / duration))).toBe(false);
    for (const direction of [LOOP, REVERSE, MIRROR] as const) {
      expect(() => read(time, duration, Infinity, 0, direction))
        .toThrowError(/^LM166$/);
    }
  });
});

describe('internal repeat cursor — validation and totality', () => {
  it('accepts only portable non-negative int32 values or Infinity', () => {
    for (const valid of [0, 1, 0x7fff_ffff, Infinity]) {
      expect(isRepeatCount(valid)).toBe(true);
    }
    for (const invalid of [-1, 0.5, NaN, -Infinity, 0x8000_0000]) {
      expect(isRepeatCount(invalid)).toBe(false);
    }
  });

  it('computes active duration without a trailing repeatDelay', () => {
    expect(repeatDuration(2, 3, 0.5)).toBe(9.5);
    expect(repeatDuration(2, 0, 99)).toBe(2);
    expect(repeatDuration(Number.MAX_VALUE, 0, Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(repeatDuration(2, Infinity, 0.5)).toBe(Infinity);
    const duration = 0.0020060180541624875;
    const repeatDelay = 0.017154389505549948;
    expect(repeatDuration(duration, 1, repeatDelay)).toBe(
      1 * (duration + repeatDelay) + duration,
    );
  });

  it('separates numeric repeat validity from binary64 schedule representability', () => {
    expect(isRepeatScheduleRepresentable(0, 1, 3, 0.5)).toBe(true);
    expect(isRepeatScheduleRepresentable(0, 1, Infinity, 0.5)).toBe(true);
    // repeatDelay is unobservable without a repeat and must not reject a run.
    expect(isRepeatScheduleRepresentable(0, 1, 0, Number.MAX_VALUE)).toBe(true);

    expect(isRepeatScheduleRepresentable(Number.MAX_VALUE, 1, 0, 0)).toBe(false);
    expect(isRepeatScheduleRepresentable(0, Number.MAX_VALUE, 1, Number.MAX_VALUE)).toBe(false);
    expect(isRepeatScheduleRepresentable(
      0,
      1,
      Number.MAX_SAFE_INTEGER - 1,
      1,
    )).toBe(false);
  });

  it('uses one operation order for the validated and published terminal', () => {
    expect(repeatEndTime(0.25, 2, 3, 0.5)).toBe(9.75);
    expect(repeatEndTime(0.25, 2, 0, Number.MAX_VALUE)).toBe(2.25);
    expect(repeatEndTime(0.25, 2, Infinity, 0.5)).toBe(Infinity);
  });

  it('all supported hostile samples decode to a finite unit progress', () => {
    for (const t of [NaN, -Infinity, -Number.MAX_VALUE, -0, 0]) {
      for (const direction of [LOOP, REVERSE, MIRROR] as const) {
        const cursor = repeatCursor(t, 0, 0.25, Infinity, 0.125, direction);
        const progress = cursor < 0 ? -1 - cursor : cursor;
        expect(Number.isFinite(cursor)).toBe(true);
        expect(Number.isFinite(progress)).toBe(true);
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fails closed for non-finite or post-horizon infinite samples', () => {
    for (const time of [Infinity, Number.MAX_VALUE]) {
      for (const direction of [LOOP, REVERSE, MIRROR] as const) {
        expect(() => read(time, 0.3, Infinity, 0.2, direction))
          .toThrowError(/^LM166$/);
      }
    }
  });
});

describe('internal repeat cursor — differential property oracle', () => {
  it('pins every canonical finite boundary to the exact next start', () => {
    let seed = 0x51ce_b00c;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let i = 0; i < 5_000; i++) {
      const duration = 1e-6 + random() * 8;
      const repeatDelay = random() < 0.5 ? 0 : random() * 3;
      const cycle = duration + repeatDelay;
      const iteration = 1 + Math.floor(random() * 1_000_000);
      const boundary = iteration * cycle;
      const currentOdd = iteration % 2 === 1;
      expect(read(boundary, duration, Infinity, repeatDelay, LOOP)).toEqual([0, false]);
      expect(read(boundary, duration, Infinity, repeatDelay, REVERSE)).toEqual([
        currentOdd ? 1 : 0,
        false,
      ]);
      expect(read(boundary, duration, Infinity, repeatDelay, MIRROR)).toEqual([
        0,
        currentOdd,
      ]);
    }
  });

  it('matches an independent iteration-index oracle on 20k deterministic cases', () => {
    let seed = 0x5eed_c0de;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let i = 0; i < 20_000; i++) {
      const duration = 0.01 + random() * 8;
      const repeatDelay = random() * 3;
      const repeat = Math.floor(random() * 20);
      const direction = Math.floor(random() * 3) as 0 | 1 | 2;
      const total = repeatDuration(duration, repeat, repeatDelay);
      const time = (random() * 1.4 - 0.2) * total;
      const expected = oracle(time, duration, repeat, repeatDelay, direction);
      const actual = read(time, duration, repeat, repeatDelay, direction);
      expect(actual[1]).toBe(expected[1]);
      expect(actual[0]).toBeCloseTo(expected[0], 12);
    }
  });
});

describe('internal keyframe sampler — mirrored generator', () => {
  it('swaps endpoints and preserves the authored easing direction', () => {
    const values = [0, 100, 20];
    const times = [0, 0.5, 1];
    const easings = [(t: number): number => t * t, (t: number): number => t];
    expect(sampleKeyframesUnchecked(values, times, easings, 0, true)).toBe(20);
    expect(sampleKeyframesUnchecked(values, times, easings, 0.25, true)).toBe(40);
    expect(sampleKeyframesUnchecked(values, times, easings, 1, true)).toBe(0);
  });

  it('binary-searches long tracks in both generator directions', () => {
    const values = Array.from({ length: 12 }, (_, i) => i * i);
    const times = Array.from({ length: 12 }, (_, i) => i / 11);
    const easings = Array.from({ length: 11 }, () => (t: number): number => t);
    expect(sampleKeyframesUnchecked(values, times, easings, 7.5 / 11)).toBeCloseTo(56.5, 13);
    expect(sampleKeyframesUnchecked(values, times, easings, 7.5 / 11, true)).toBeCloseTo(12.5, 13);

    const zeroEasings = Array.from({ length: 11 }, () => (): number => 0);
    // At an authored boundary, the right segment owns the sample even when
    // hostile easings don't map 0/1 to their conventional endpoints.
    expect(sampleKeyframesUnchecked(values, times, zeroEasings, 6 / 11)).toBe(36);
    expect(sampleKeyframesUnchecked(values, times, zeroEasings, 6 / 11, true)).toBe(25);
  });

  it('chooses the right side of duplicate times without sampling a zero-width segment', () => {
    const identity = (t: number): number => t;
    expect(sampleKeyframesUnchecked(
      [0, 10, 20, 30],
      [0, 0.5, 0.5, 1],
      [identity, identity, identity],
      0.5,
      true,
    )).toBe(10);
  });
});
