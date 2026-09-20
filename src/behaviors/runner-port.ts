import type { SpringParams } from '../spring.js';

/** Внутрипакетный порт единственного владельца доводки поведения. */
export interface BehaviorSettleArgs {
  readonly from: number;
  readonly velocity: number;
  readonly target: number;
  readonly spring: SpringParams;
  readonly onStep: (value: number, velocity: number) => void;
  readonly onDone: () => void;
}

/** Внутрипакетный шов: не является частью публичного RequestFrameFn. */
export interface BehaviorRunnerPort {
  _settle(args: BehaviorSettleArgs): void;
  _invalidate(): number;
}

/** Непубличный ключ опций, исключающий коллизию с пользовательскими полями. */
export const behaviorRunnerPort: unique symbol = Symbol();

export interface BehaviorRunnerOptions {
  readonly [behaviorRunnerPort]?: BehaviorRunnerPort | undefined;
}
