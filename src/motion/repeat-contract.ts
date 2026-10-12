import type { Program } from './program.js';
import { MotionError } from './model.js';

/** Изолированная возможность изменяет только готовую числовую траекторию. */
export type SampleProgram = (program: Program, time: number, value: number[], velocity: number[]) => void;
export type Repetition = (program: Program, sample: SampleProgram, start?: number, span?: number) => Program;
const marker = Symbol.for('@labpics/motion/repeat.v1');

export function repetition(input: unknown): Repetition | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'function' || (input as unknown as Record<symbol, unknown>)[marker] !== true)
    throw new MotionError('Параметры повторения создаются через repeat()');
  return input as Repetition;
}

export function authoredRepetition(create: Repetition): Repetition {
  Object.defineProperty(create, marker, { value: true });
  return Object.freeze(create);
}
