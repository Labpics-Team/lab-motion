import {
  isRepeatCount, isRepeatScheduleRepresentable, repeatEndTime, repeatCursor,
  type RepeatDirection,
} from '../internal/repeat-cursor.js';
import { MotionError, number, record } from './model.js';
import { authoredRepetition, type Repetition } from './repeat-contract.js';
import type { MotionOptions } from './types.js';

export interface RepeatOptions {
  readonly type?: 'loop' | 'reverse' | 'mirror';
  readonly delay?: number;
}

/** Дополнительные итерации готовой траектории; результат добавляется к опциям движения. */
export function repeat(count: number = Infinity, options?: RepeatOptions): Pick<MotionOptions, 'repeat'> {
  if (!isRepeatCount(count)) throw new MotionError('repeat: целое число от 0 до 2147483647 либо Infinity');
  const source = options === undefined ? {} : record(options, 'repeat');
  for (const key of Object.keys(source)) if (key !== 'type' && key !== 'delay')
    throw new MotionError('Неизвестная опция повторения ' + key);
  const { type, delay } = source;
  if (type !== undefined && type !== 'loop' && type !== 'reverse' && type !== 'mirror')
    throw new MotionError('repeat type: loop, reverse или mirror');
  const direction: RepeatDirection = type === 'reverse' ? 1 : type === 'mirror' ? 2 : 0;
  const gap = number(delay === undefined ? 0 : delay, 'repeat delay', 0);
  if (count === 0) return {};
  const create: Repetition = (start, span) => {
    if (!isRepeatScheduleRepresentable(start, span, count, gap)) throw new MotionError('Непредставимое расписание повторений');
    return { end: repeatEndTime(start, span, count, gap), count, direction, gap,
      cursor: (time, output) => repeatCursor(time, start, span, count, gap, direction, output) };
  };
  return { repeat: authoredRepetition(create) as unknown as NonNullable<MotionOptions['repeat']> };
}
