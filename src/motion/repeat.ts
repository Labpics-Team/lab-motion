import {
  isRepeatCount, isRepeatScheduleRepresentable, repeatEndTime, repeatCursor,
  type RepeatDirection,
} from '../internal/repeat-cursor.js';
import { MotionError, number, record } from './model.js';
import type { Program } from './program.js';
import { authoredRepetition, type Repetition } from './repeat-contract.js';
import type { MotionOptions } from './types.js';

export interface RepeatOptions {
  readonly type?: 'loop' | 'reverse' | 'mirror';
  readonly delay?: number;
}

/** Готовит исполнение повторов вне обычного графа animate/scope. */
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

  const create: Repetition = (input, sampleProgram, position, length) => {
    const first = input._segments[0]!;
    const start = position ?? first.at;
    const span = length ?? input.duration - start;
    if (input._segments.some(segment => segment.timing.spring))
      throw new MotionError('Повтор авторской траектории использует duration/ease');
    if (!isRepeatScheduleRepresentable(start, span, count, gap))
      throw new MotionError('Непредставимое расписание повторений');

    const end = repeatEndTime(start, span, count, gap);
    const odd = count !== Infinity && count % 2 === 1 && direction !== 0;
    const final = odd ? first.from : input.final;
    const instant = span === 0;
    // Native alternate сохраняет наблюдаемое значение на границе; разрывный loop остаётся JS.
    const connected = direction !== 0 || first.from.every((value, index) => value === first.to[index]);
    const native = !instant && count !== Infinity && gap === 0 && connected &&
      input._segments.length === 1 && first.end === start + span && first.at === start &&
      input._nativeEase !== undefined && (direction !== 2 || input._nativeEase === 'linear');

    const mirror = direction !== 2 ? undefined : {
      ...input,
      _segments: input._segments.map((temporal, index, segments) => {
        const spatial = segments[segments.length - 1 - index]!;
        return { ...temporal, from: spatial.to, to: spatial.from };
      }),
      final: first.from,
    };
    const cursorState = { rate: 0 };
    return {
      ...input, final, duration: end, _identity: undefined,
      _nativeEase: native ? input._nativeEase : undefined,
      _nativeTiming: native ? { iterations: count + 1, direction: direction === 0 ? 'normal' as const : 'alternate' as const } : undefined,
      _sample(time: number, value: number[], velocity: number[]) {
        if (time === Infinity) throw new MotionError('Непредставимый горизонт бесконечного повтора');
        if (time < start) {
          for (let i = 0; i < first.from.length; i++) { value[i] = first.from[i]!; velocity[i] = 0; }
          return;
        }
        if (count !== Infinity && time >= end) {
          for (let i = 0; i < final.length; i++) { value[i] = final[i]!; velocity[i] = 0; }
          return;
        }
        const cursor = repeatCursor(time, start, span, count, gap, direction, cursorState);
        const mirrored = cursor < 0;
        const progress = mirrored ? -1 - cursor : cursor;
        sampleProgram(mirrored ? mirror! : input, start + progress * span, value, velocity);
        if (cursorState.rate !== 1) {
          for (let i = 0; i < velocity.length; i++) velocity[i] *= cursorState.rate;
        }
      },
    };
  };
  return { repeat: authoredRepetition(create) as unknown as NonNullable<MotionOptions['repeat']> };
}
