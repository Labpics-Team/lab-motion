export type MotionScalar = number | string;
export type MotionProperties = Readonly<Record<string, MotionScalar | readonly MotionScalar[]>>;
export type MotionTarget = Element | string | Iterable<Element> | ArrayLike<Element>;
export type MotionEase = 'linear' | 'standard' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
  | readonly [number, number, number, number] | ((progress: number) => number);

export type MotionSpring =
  | { readonly response?: number; readonly bounce?: number; readonly mass?: never; readonly stiffness?: never; readonly damping?: never }
  | { readonly mass: number; readonly stiffness: number; readonly damping: number; readonly response?: never; readonly bounce?: never };

interface MotionCommon {
  /** Миллисекунды до начала движения. */
  readonly delay?: number;
  /** Миллисекунды между элементами в порядке списка. */
  readonly stagger?: number;
  /** Доли общей длительности авторских значений, от 0 до 1. */
  readonly times?: readonly number[];
  /** По умолчанию учитывается системная настройка. always завершает движение сразу. */
  readonly reducedMotion?: 'user' | 'always';
}
declare const repetitionBrand: unique symbol;
interface RepetitionOptions {
  /** Настройки из repeat(); готовый план повторения задаётся вместе с duration/ease. */
  readonly repeat?: { readonly [repetitionBrand]: true };
}
type TransitionOptions = (
  | { readonly spring?: MotionSpring; readonly duration?: never; readonly ease?: never }
  | { readonly duration?: number; readonly ease?: MotionEase; readonly spring?: never }
);
export type MotionOptions = MotionCommon & TransitionOptions & RepetitionOptions;
export type MotionResult = Readonly<{ status: 'finished' | 'stopped' }>;
export type PlaybackState = 'running' | 'paused' | 'finished' | 'stopped' | 'failed';

export interface Playback {
  readonly finished: Promise<MotionResult>;
  readonly state: PlaybackState;
  /** Полная длительность принятого прогона в миллисекундах, включая задержки. */
  readonly duration: number;
  pause(): void;
  play(): void;
  /** Перемотка на миллисекунду исходной шкалы; состояние паузы сохраняется. */
  seek(milliseconds: number): void;
  /** Завершить в текущей позе. */
  stop(): void;
  /** Применить конечные значения и завершить. */
  finish(): void;
}
export interface Disposable { dispose(): void }
export type SequenceStep = readonly [MotionTarget, MotionProperties, (MotionCommon & TransitionOptions & { readonly at?: number | '<' | '>' })?];
export type SequenceOptions = Pick<MotionCommon, 'delay' | 'reducedMotion'> & RepetitionOptions;
