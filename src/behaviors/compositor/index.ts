import {
  createBottomSheet as createHeadlessBottomSheet,
  createCarousel as createHeadlessCarousel,
  type BehaviorState,
  type CarouselController,
  type CarouselOptions,
  type SheetController,
  type SheetOptions,
} from '../index.js';
import { handoffToLive } from '../../compositor/handoff.js';
import {
  DEFAULT_TOLERANCE,
  tryCompileSpringExecutionArtifactTupleUnchecked,
  type SpringExecutionArtifactTuple,
} from '../../compositor/curve.js';
import {
  resolveCompositorTierCodeFromInputs,
  type CompositorTierCode,
} from '../../compositor/detect.js';
import { compileSpringRuntimeExecutionTupleUnchecked } from '../../compositor/execution.js';
import {
  animationTimeOrFallback,
  sampleSerializedSpringIntoUnchecked,
  scaleSerializedVelocity,
} from '../../compositor/sample.js';
import { defaultRequestFrame } from '../../internal/request-frame.js';
import type { RequestFrameFn } from '../../motion-value.js';
import {
  behaviorRunnerPort,
  type BehaviorRunnerOptions,
  type BehaviorRunnerPort,
  type BehaviorSettleArgs,
} from '../runner-port.js';
import type { SpringParams } from '../../spring.js';
import type { WaapiAnimatable } from '../../waapi/index.js';

interface NativeAnimation {
  currentTime?: unknown;
  cancel?: () => void;
  finished: PromiseLike<unknown>;
}

interface BehaviorCompositorTarget extends WaapiAnimatable {
  animate(
    keyframes: Record<string, string | number>[],
    timing: object,
  ): NativeAnimation;
}

export interface BehaviorCompositorSurface {
  readonly target: BehaviorCompositorTarget;
  readonly property: string;
  readonly apply: (value: string | number) => void;
  readonly format?: ((value: number) => string | number) | undefined;
}

export interface CompositorBottomSheetOptions extends SheetOptions {
  readonly compositor: BehaviorCompositorSurface;
}

export interface CompositorCarouselOptions extends CarouselOptions {
  readonly compositor: BehaviorCompositorSurface;
}

interface BehaviorCompositorOwner extends BehaviorRunnerPort {
  destroy(): void;
}

type NativeRun = {
  readonly kind: 0;
  readonly args: BehaviorSettleArgs;
  readonly animation: NativeAnimation;
  readonly artifact: SpringExecutionArtifactTuple;
  readonly startedAt: number;
};

type LiveRun = {
  readonly kind: 1;
  readonly args: BehaviorSettleArgs;
  readonly value: ReturnType<typeof handoffToLive>;
  unsubscribe?: (() => void) | undefined;
};

type ActiveRun = NativeRun | LiveRun;

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function createOwner(
  surface: BehaviorCompositorSurface,
  requestFrame: RequestFrameFn | undefined,
  tier: CompositorTierCode,
): BehaviorCompositorOwner {
  let target: BehaviorCompositorTarget | undefined = surface.target;
  let active: ActiveRun | undefined;
  let epoch = 0;
  const format = surface.format ?? Number;
  const schedule = requestFrame ?? defaultRequestFrame;
  const sample = { value: 0, velocity: 0 };

  const finish = (run: ActiveRun): void => {
    if (active !== run) return;
    active = undefined;
    const token = epoch;
    run.args.onStep(run.args.target, 0);
    if (run.kind === 0) run.animation.cancel?.();
    else {
      run.unsubscribe?.();
      run.value.destroy();
    }
    if (token === epoch) run.args.onDone();
  };

  const owner: BehaviorCompositorOwner = {
    _settle(args): void {
      owner._invalidate();
      const host = target;
      if (!host) return;
      if (args.from === args.target || tier === 3) {
        args.onStep(args.target, 0);
        args.onDone();
        return;
      }
      const token = ++epoch;
      const v0 = args.velocity / (args.target - args.from);
      const artifact = tier === 0 && Number.isFinite(v0)
        ? tryCompileSpringExecutionArtifactTupleUnchecked(args.spring, v0, DEFAULT_TOLERANCE)
        : undefined;

      if (artifact) {
        const plan = compileSpringRuntimeExecutionTupleUnchecked(
          args.spring,
          surface.property,
          args.from,
          args.target,
          v0,
          DEFAULT_TOLERANCE,
          'both',
          'replace',
          format,
          artifact,
        );
        const startedAt = defaultNow();
        if (token !== epoch) return;
        let animation: NativeAnimation | undefined;
        try {
          animation = host.animate(plan[0], {
            duration: plan[2],
            easing: plan[1],
            iterations: 1,
            fill: plan[3],
            composite: plan[4],
          });
        } catch {}
        if (token !== epoch) {
          animation?.cancel?.();
          return;
        }
        if (animation) {
          const run: NativeRun = active = {
            kind: 0,
            args,
            animation,
            artifact,
            startedAt,
          };
          args.onStep(args.from, args.velocity);
          if (active === run) animation.finished.then(() => finish(run), () => {});
          return;
        }
      }

      const value = handoffToLive({
        spring: args.spring,
        value: args.from,
        velocity: args.velocity,
        target: args.target,
        requestFrame: schedule,
      });
      const live: LiveRun = active = { kind: 1, args, value };
      live.unsubscribe = value.onChange((next) => {
        if (active !== live) return;
        const velocity = value.velocity;
        args.onStep(next, velocity);
        if (active === live && next === args.target && velocity === 0) finish(live);
      });
    },

    _invalidate(): number {
      const run = active;
      epoch++;
      if (!run) return 0;
      active = undefined;
      let value: number;
      let velocity: number;

      if (run.kind === 0) {
        const currentTime = animationTimeOrFallback(
          run.animation,
          defaultNow() - run.startedAt,
        );
        const point = sampleSerializedSpringIntoUnchecked(
          run.artifact[1],
          run.artifact[2],
          currentTime,
          0,
          sample,
        );
        const progress = point.value;
        const raw = progress === 0
          ? run.args.from
          : progress === 1
            ? run.args.target
            : (1 - progress) * run.args.from + progress * run.args.target;
        value = Number.isFinite(raw) ? raw : run.args.target;
        velocity = currentTime < 0
          ? run.args.velocity
          : scaleSerializedVelocity(
            point.velocity,
            run.args.from,
            run.args.target,
          );
      } else {
        value = run.value.value;
        velocity = run.value.velocity;
      }

      // Successor-state публикуется до cleanup donor: underlying style получает
      // sampled point, пока старый effect ещё маскирует его; cancel затем раскрывает
      // то же значение. Reentrant input не может воскресить уже снятый run.
      run.args.onStep(value, velocity);
      if (run.kind === 0) run.animation.cancel?.();
      else {
        run.unsubscribe?.();
        run.value.destroy();
      }
      return velocity;
    },

    destroy(): void {
      const run = active;
      active = undefined;
      target = undefined;
      epoch++;
      if (run?.kind === 0) run.animation.cancel?.();
      else if (run) {
        run.unsubscribe?.();
        run.value.destroy();
      }
    },
  };
  return owner;
}

function connect<
  T extends BehaviorState<number>,
  C extends {
    readonly state: T;
    subscribe(fn: (state: T) => void): () => void;
    destroy(): void;
  },
>(
  controller: C,
  owner: BehaviorCompositorOwner,
  surface: BehaviorCompositorSurface,
): C {
  const format = surface.format ?? Number;
  surface.apply(format(controller.state.value));
  const unsubscribe = controller.subscribe((state) => {
    surface.apply(format(state.value));
  });
  const destroy = controller.destroy.bind(controller);
  controller.destroy = (() => {
    owner.destroy();
    destroy();
    unsubscribe();
  }) as C['destroy'];
  return controller;
}

function ownerFor(
  options: Pick<SheetOptions, 'matchMedia' | 'requestFrame'>,
  surface: BehaviorCompositorSurface,
): BehaviorCompositorOwner {
  return createOwner(
    surface,
    options.requestFrame,
    resolveCompositorTierCodeFromInputs(surface.target, options.matchMedia, options.requestFrame),
  );
}

/** Follow остаётся живым, а release передаётся существующему compositor-представлению. */
export function createCompositorBottomSheet(
  options: CompositorBottomSheetOptions,
): SheetController {
  const owner = ownerFor(options, options.compositor);
  const headlessOptions: SheetOptions & BehaviorRunnerOptions = {
    ...options,
    [behaviorRunnerPort]: owner,
  };
  const controller = createHeadlessBottomSheet(headlessOptions);
  return connect(controller, owner, options.compositor);
}

/** Pager переиспользует тот же закон владельца и существующий выбор цели carousel. */
export function createCompositorCarousel(
  options: CompositorCarouselOptions,
): CarouselController {
  const owner = ownerFor(options, options.compositor);
  const headlessOptions: CarouselOptions & BehaviorRunnerOptions = {
    ...options,
    [behaviorRunnerPort]: owner,
  };
  const controller = createHeadlessCarousel(headlessOptions);
  return connect(controller, owner, options.compositor);
}
