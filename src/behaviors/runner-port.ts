import type { SpringParams } from '../spring.js';
import type { MatchMediaLike } from '../internal/media-query.js';
import type { RequestFrameFn } from '../motion-value.js';

/** Внутрипакетный порт единственного владельца доводки поведения. */
export interface BehaviorSettleArgs {
  readonly from: number;
  readonly velocity: number;
  readonly target: number;
  readonly spring: SpringParams;
  /** true, пока опубликованное состояние всё ещё владеет продолжением. */
  readonly onStep: (value: number, velocity: number) => boolean;
  readonly onDone: () => void;
}

/** Внутрипакетный шов: не является частью публичного RequestFrameFn. */
export interface BehaviorRunnerPort {
  _settle(args: BehaviorSettleArgs): void;
  _invalidate(): number;
}

/** Исполнитель выбирается при сборке entry; фабрика вызывается после валидации поведения. */
export type BehaviorRunnerFactory = (options: {
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: MatchMediaLike | undefined;
}) => BehaviorRunnerPort;
