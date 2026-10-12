import type { RepeatDirection, RepeatSample } from '../internal/repeat-cursor.js';
import { MotionError } from './model.js';

/** Расписание не содержит target, Playback или состояние платформы. */
export interface RepeatClock {
  readonly end: number;
  readonly count: number;
  readonly direction: RepeatDirection;
  readonly gap: number;
  cursor(time: number, output: RepeatSample): number;
}
export type Repetition = (start: number, span: number) => RepeatClock;
export interface RepeatPlan {
  readonly start: number;
  readonly span: number;
  readonly clock: RepeatClock;
  readonly _sample: RepeatSample;
}

export function repetition(input: unknown): Repetition | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'function' || (input as unknown as Record<symbol, unknown>)[Symbol.for('@labpics/motion/repeat.v1')] !== true) throw new MotionError('Параметры повторения создаются через repeat()');
  return input as Repetition;
}

/** Маркер переносим между ESM/CJS-копиями; состояние прогона остаётся локальным. */
export function authoredRepetition(create: Repetition): Repetition {
  Object.defineProperty(create, Symbol.for('@labpics/motion/repeat.v1'), { value: true });
  return Object.freeze(create);
}
