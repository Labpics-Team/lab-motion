import {
  isScheduleV1Representable,
  scheduleV1GreatestIterationAtOrBefore,
  scheduleV1IterationBoundary,
  SCHEDULE_V1_INT32_MAX,
  SCHEDULE_V1_ITERATION_OUT_OF_RANGE,
} from './schedule-v1.js';
import { MotionParamError } from '../errors.js';

/**
 * Allocation-free repeat scheduler.
 *
 * The returned scalar keeps ordinary/reverse progress in [0, 1]. Mirror uses
 * [-2, -1], so callers carry progress and the generator-direction bit without
 * allocating a tuple on every frame.
 */

export type RepeatDirection = 0 | 1 | 2;

export function isRepeatCount(value: number): boolean {
  return value === Infinity || (
    Number.isInteger(value) && value >= 0 && value <= SCHEDULE_V1_INT32_MAX
  );
}

/** Active duration: repeatDelay exists only between iterations. */
export function repeatDuration(duration: number, repeat: number, repeatDelay: number): number {
  return repeat === 0
    ? duration
    : repeat * (duration + repeatDelay) + duration;
}

/** End time in the same binary64 operation order used by validation/runtime. */
export function repeatEndTime(
  start: number,
  duration: number,
  repeat: number,
  repeatDelay: number,
): number {
  if (repeat === Infinity) return Infinity;
  return repeat === 0
    ? start + duration
    : repeat * (duration + repeatDelay) + start + duration;
}

/**
 * A valid numeric repeat is not necessarily an executable schedule: binary64
 * can collapse a positive duration, delay, or final iteration at large times.
 */
export function isRepeatScheduleRepresentable(
  start: number,
  duration: number,
  repeat: number,
  repeatDelay: number,
): boolean {
  // A delay after the only iteration is unobservable and canonicalizes away.
  return isScheduleV1Representable(
    start,
    duration,
    repeat === Infinity ? -1 : repeat,
    repeat === 0 ? 0 : repeatDelay,
  );
}

/**
 * Samples a prevalidated repeat schedule. Direction: 0 loop, 1 reverse-time,
 * 2 mirror-generator. Intermediate boundaries are half-open: the exact
 * boundary starts the next iteration; only the finite terminal is closed.
 * This V1/WAAPI law intentionally differs from Motion 12.42.2's previous-end
 * repeat boundary. Infinite schedules fail with LM166 before an iteration
 * index would exceed Number.MAX_SAFE_INTEGER; parity is never guessed.
 */
export function repeatCursor(
  time: number,
  start: number,
  duration: number,
  repeat: number,
  repeatDelay: number,
  direction: RepeatDirection,
): number {
  const terminal = repeatEndTime(start, duration, repeat, repeatDelay);
  if (time === Infinity && repeat === Infinity) throw new MotionParamError('LM166');
  const t = time === Infinity
    ? terminal
    : time > 0
      ? time
      : 0;
  let progress: number;
  let odd = false;

  if (t < start) {
    progress = 0;
  } else if (repeat !== Infinity && t >= terminal) {
    progress = 1;
    odd = direction !== 0 && repeat % 2 === 1;
  } else {
    const cycle = duration + repeatDelay;
    const wireRepeat = repeat === Infinity ? -1 : repeat;
    const iteration = scheduleV1GreatestIterationAtOrBefore(
      start,
      cycle,
      wireRepeat,
      t,
    );
    if (iteration === SCHEDULE_V1_ITERATION_OUT_OF_RANGE) {
      throw new MotionParamError('LM166');
    }
    const iterationStart = scheduleV1IterationBoundary(start, cycle, iteration);
    const motionEnd = repeatDelay === 0 && (repeat === Infinity || iteration < repeat)
      ? scheduleV1IterationBoundary(start, cycle, iteration + 1)
      : iterationStart + duration;
    const local = t - iterationStart;
    const motionSpan = motionEnd - iterationStart;
    odd = direction !== 0 && iteration % 2 === 1;
    progress = duration === 0 || local >= motionSpan
      ? 1
      : Math.min(local / motionSpan, 1 - Number.EPSILON / 2);
  }

  if (!odd) return progress;
  if (direction === 1) return 1 - progress;
  return -1 - progress;
}
