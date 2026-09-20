import type { SpringParams } from '../spring.js';

/** Аргументы одного package-owned settle-перехода поведения. */
export interface BehaviorSettleArgs {
  readonly from: number;
  readonly velocity: number;
  readonly target: number;
  readonly spring: SpringParams;
  readonly onStep: (value: number, velocity: number) => void;
  readonly onDone: () => void;
}

/** Единственный владелец settle/pickup для headless-поведения. */
export interface BehaviorRunner {
  _settle(args: BehaviorSettleArgs): void;
  _invalidate(): number;
}

/** Непубличный capability-key: обычный RequestFrameFn не может имитировать runner по форме. */
export const behaviorRunner: unique symbol = Symbol();

/** Внутреннее расширение options; package exports этот модуль не публикует. */
export interface BehaviorRunnerOptions {
  readonly [behaviorRunner]?: BehaviorRunner;
}
