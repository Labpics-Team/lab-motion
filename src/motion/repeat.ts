import {
  isRepeatCount, isRepeatScheduleRepresentable, repeatEndTime,
  type RepeatDirection, type RepeatSample,
} from '../internal/repeat-cursor.js';
import { MotionError, number } from './model.js';

export interface RepeatOptions {
  readonly count: number;
  readonly direction: RepeatDirection;
  readonly delay: number;
}
export interface RepeatPlan extends RepeatOptions {
  readonly start: number;
  readonly span: number;
  readonly end: number;
  /** Рабочее место синхронного семплера; не удерживает target или Playback. */
  readonly _sample: RepeatSample;
}

export function readRepeat(count: unknown, direction: unknown, delay: unknown): RepeatOptions | undefined {
  const repeats = count === undefined ? 0 : count;
  if (typeof repeats !== 'number' || !isRepeatCount(repeats))
    throw new MotionError('repeat: целое число от 0 до 2147483647 либо Infinity');
  if (direction !== undefined && direction !== 'loop' && direction !== 'reverse' && direction !== 'mirror')
    throw new MotionError('repeatType: loop, reverse или mirror');
  const gap = number(delay === undefined ? 0 : delay, 'repeatDelay', 0);
  return repeats === 0 ? undefined : {
    count: repeats, direction: direction === 'reverse' ? 1 : direction === 'mirror' ? 2 : 0, delay: gap,
  };
}

export function repeatPlan(options: RepeatOptions, start: number, span: number): RepeatPlan {
  if (!isRepeatScheduleRepresentable(start, span, options.count, options.delay))
    throw new MotionError('Непредставимое расписание повторений');
  return { ...options, start, span, end: repeatEndTime(start, span, options.count, options.delay), _sample: { rate: 0 } };
}

/** Оси одной физической поверхности могут разделять только одинаковое время. */
export function sameRepeat(a: RepeatPlan | undefined, b: RepeatPlan | undefined): boolean {
  return a === b || !!a && !!b && a.start === b.start && a.span === b.span &&
    a.count === b.count && a.direction === b.direction && a.delay === b.delay;
}
