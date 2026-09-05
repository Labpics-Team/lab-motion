import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CompositorSpring } from '../src/compositor/index.js';
import {
  createCompositorHandoffLatencyScenario,
  measureCompositorHandoffLatency,
  measureLatency,
} from '../scripts/bench-latency-support.mjs';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };
const NO_EFFECTS = { animations: 0, cancels: 0, frameRequests: 0 } as const;
const SETUP_EFFECTS = { animations: 1, cancels: 0, frameRequests: 0 } as const;
const HANDOFF_EFFECTS = { animations: 0, cancels: 1, frameRequests: 1 } as const;
const EXPECTED_FAKE_LIVE = { value: 3.2, velocity: 200 } as const;
const TEST_DONOR_EASING = 'linear(0 0%, 0.02 10%, 0.04 20%, 1 100%)';
const TEST_DONOR_KEYFRAMES = [{ offset: 0, x: 0 }, { offset: 1, x: 100 }] as const;
const TEST_DONOR_TIMING = { duration: 100, easing: TEST_DONOR_EASING } as const;

type EffectCounts = Readonly<{
  animations: number;
  cancels: number;
  frameRequests: number;
}>;

type FakeCompositorOptions = Readonly<{
  target: {
    animate(
      keyframes: readonly Record<string, string | number>[],
      timing: Readonly<Record<string, unknown>>,
    ): { readonly currentTime?: number | null; cancel(): void };
  };
  now: () => number;
  requestFrame: () => number;
}>;

type FakeControllerBehavior = Readonly<{
  createLive?: () => unknown;
  destroyError?: Error;
  handoffClockReads?: number;
  handoffDonorReads?: number;
  onControllerDestroy?: () => void;
  onLiveDestroy?: () => void;
  startError?: Error;
}>;

function createFakeCompositorSpring(
  setupEffects: EffectCounts,
  handoffEffects: EffectCounts,
  behavior: FakeControllerBehavior = {},
) {
  return class FakeCompositorSpring {
    private readonly animations: Array<{ readonly currentTime?: number | null; cancel(): void }> = [];

    constructor(private readonly options: FakeCompositorOptions) {}

    private apply(effects: EffectCounts) {
      for (let index = 0; index < effects.animations; index++) {
        this.animations.push(this.options.target.animate(
          TEST_DONOR_KEYFRAMES,
          TEST_DONOR_TIMING,
        ));
      }
      const donor = this.animations[0];
      if (effects.cancels > 0 && !donor) {
        throw new Error('fake compositor: cancel без donor animation');
      }
      for (let index = 0; index < effects.cancels; index++) donor!.cancel();
      for (let index = 0; index < effects.frameRequests; index++) this.options.requestFrame();
    }

    start() {
      this.options.now();
      this.apply(setupEffects);
      if (behavior.startError) throw behavior.startError;
    }

    handoffToLive() {
      for (let index = 0; index < (behavior.handoffClockReads ?? 1); index++) this.options.now();
      for (let index = 0; index < (behavior.handoffDonorReads ?? 1); index++) {
        void this.animations[0]?.currentTime;
      }
      this.apply(handoffEffects);
      return behavior.createLive
        ? behavior.createLive()
        : { ...EXPECTED_FAKE_LIVE, destroy: behavior.onLiveDestroy ?? (() => {}) };
    }

    destroy() {
      behavior.onControllerDestroy?.();
      if (behavior.destroyError) throw behavior.destroyError;
    }
  };
}

function measureFakeHandoff(
  setupEffects: EffectCounts,
  handoffEffects: EffectCounts,
  behavior?: FakeControllerBehavior,
) {
  let nowNs = 0n;
  return measureCompositorHandoffLatency({
    CompositorSpring: createFakeCompositorSpring(setupEffects, handoffEffects, behavior),
    spring: SPRING,
    property: 'x',
    from: 0,
    to: 100,
    initialNow: 1_000,
    elapsedMs: 16,
    nowNs: () => ++nowNs,
    warmup: 0,
    iters: 1,
    runs: 1,
  });
}

function createScenario() {
  return createCompositorHandoffLatencyScenario({
    CompositorSpring,
    spring: SPRING,
    property: 'x',
    from: 0,
    to: 100,
    initialNow: 1_000,
    elapsedMs: 16,
  });
}

describe('жизненный цикл latency-стенда handoff', () => {
  it('исполняет CLI-entrypoint с одним op внутри измеряемого окна', () => {
    const phases: string[] = [];
    let nowNs = 0n;
    const result = measureCompositorHandoffLatency({
      CompositorSpring,
      spring: SPRING,
      property: 'x',
      from: 0,
      to: 100,
      initialNow: 1_000,
      elapsedMs: 16,
      nowNs() {
        phases.push('clock');
        nowNs += 100n;
        return nowNs;
      },
      onPhase(phase: string) {
        phases.push(phase);
      },
      warmup: 1,
      iters: 2,
      runs: 1,
    });

    expect(result).toEqual({
      label: 'CompositorSpring.handoffToLive (read+cancel+build)',
      p50: 100,
      p95: 100,
      p99: 100,
    });
    expect(phases).toEqual([
      'setup', 'op', 'verify', 'teardown',
      'setup', 'clock', 'op', 'clock', 'verify', 'teardown',
      'setup', 'clock', 'op', 'clock', 'verify', 'teardown',
    ]);
  });

  it('не принимает эффекты setup за эффекты timed handoff', () => {
    expect(() => measureFakeHandoff(
      { animations: 1, cancels: 1, frameRequests: 1 },
      NO_EFFECTS,
    )).toThrow(/lifecycle/i);
  });

  it('не принимает host-effects без чтения и корректного donor-state', () => {
    expect(() => measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      createLive: () => ({ value: 0, velocity: 0, destroy() {} }),
      handoffDonorReads: 0,
    })).toThrow(/donor|snapshot/i);
  });

  it.each([
    ['неверную конечную позицию', { value: 0, velocity: EXPECTED_FAKE_LIVE.velocity }, {}, /snapshot/i],
    ['неверную конечную скорость', { value: EXPECTED_FAKE_LIVE.value, velocity: 0 }, {}, /snapshot/i],
    ['пропущенное чтение donor clock', EXPECTED_FAKE_LIVE, { handoffClockReads: 0 }, /donor clock/i],
    ['лишнее чтение donor clock', EXPECTED_FAKE_LIVE, { handoffClockReads: 2 }, /donor clock/i],
    ['пропущенное чтение donor animation', EXPECTED_FAKE_LIVE, { handoffDonorReads: 0 }, /donor animation/i],
    ['лишнее чтение donor animation', EXPECTED_FAKE_LIVE, { handoffDonorReads: 2 }, /donor animation/i],
  ] as const)('отвергает %s при правильных host-effects', (_label, state, behavior, error) => {
    expect(() => measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      createLive: () => ({ ...state, destroy() {} }),
      ...behavior,
    })).toThrow(error);
  });

  it.each([
    ['без cancel', { animations: 0, cancels: 0, frameRequests: 1 }],
    ['с лишним cancel', { animations: 0, cancels: 2, frameRequests: 1 }],
    ['без requestFrame', { animations: 0, cancels: 1, frameRequests: 0 }],
    ['с лишним requestFrame', { animations: 0, cancels: 1, frameRequests: 2 }],
    ['с новой animation', { animations: 1, cancels: 1, frameRequests: 1 }],
  ] satisfies ReadonlyArray<readonly [string, EffectCounts]>)(
    'отвергает timed handoff %s и всё равно освобождает live-owner',
    (_label, effects) => {
      let destroys = 0;
      expect(() => measureFakeHandoff(SETUP_EFFECTS, effects, {
        onLiveDestroy: () => destroys++,
      }))
        .toThrow(/handoff: animate=/i);
      expect(destroys).toBe(1);
    },
  );

  it('освобождает каждый свежий live-owner warmup и измерительных samples', () => {
    let destroys = 0;
    let nowNs = 0n;
    measureCompositorHandoffLatency({
      CompositorSpring: createFakeCompositorSpring(
        SETUP_EFFECTS,
        HANDOFF_EFFECTS,
        { onLiveDestroy: () => destroys++ },
      ),
      spring: SPRING,
      property: 'x',
      from: 0,
      to: 100,
      initialNow: 1_000,
      elapsedMs: 16,
      nowNs: () => ++nowNs,
      warmup: 1,
      iters: 2,
      runs: 2,
    });

    expect(destroys).toBe(5);
  });

  it.each([
    ['undefined', () => undefined],
    ['объект без destroy', () => ({ value: 0, velocity: 0 })],
  ] as const)('не маскирует lifecycle-ошибку для live: %s', (_label, createLive) => {
    let controllerDestroys = 0;
    let nowNs = 0n;
    const FakeCompositorSpring = createFakeCompositorSpring(
      SETUP_EFFECTS,
      HANDOFF_EFFECTS,
      {
        createLive,
        onControllerDestroy: () => controllerDestroys++,
      },
    );

    expect(() => measureCompositorHandoffLatency({
      CompositorSpring: FakeCompositorSpring,
      spring: SPRING,
      property: 'x',
      from: 0,
      to: 100,
      initialNow: 1_000,
      elapsedMs: 16,
      nowNs: () => ++nowNs,
      warmup: 0,
      iters: 1,
      runs: 1,
    })).toThrow(/не выполнен полный lifecycle/i);
    expect(controllerDestroys).toBe(1);
  });

  it.each(['первые часы', 'op', 'вторые часы'] as const)(
    'освобождает setup-аргумент, если до finish падает: %s',
    (failurePoint) => {
      const failure = new Error(`failure: ${failurePoint}`);
      const sample = {};
      let clockCalls = 0;
      let caught: unknown;
      let teardownCalls = 0;
      let teardownResult: unknown;
      let teardownSample: unknown;

      try {
        measureLatency('failure', {
          setup: () => sample,
          op() {
            if (failurePoint === 'op') throw failure;
            return 'live';
          },
          nowNs() {
            clockCalls++;
            if (
              (failurePoint === 'первые часы' && clockCalls === 1) ||
              (failurePoint === 'вторые часы' && clockCalls === 2)
            ) {
              throw failure;
            }
            return BigInt(clockCalls);
          },
          teardown(result, arg) {
            teardownCalls++;
            teardownResult = result;
            teardownSample = arg;
          },
          warmup: 0,
          iters: 1,
          runs: 1,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect(teardownCalls).toBe(1);
      expect(teardownSample).toBe(sample);
      expect(teardownResult).toBe(failurePoint === 'вторые часы' ? 'live' : undefined);
    },
  );

  it('освобождает controller, если start бросает после захвата host-effect', () => {
    const startError = new Error('start failed');
    let controllerDestroys = 0;

    expect(() => measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      onControllerDestroy: () => controllerDestroys++,
      startError,
    })).toThrow(startError);
    expect(controllerDestroys).toBe(1);
  });

  it('сохраняет start-ошибку, если cleanup частичного controller тоже падает', () => {
    const startError = new Error('start failed');
    const cleanupError = new Error('destroy failed');
    let caught: unknown;

    try {
      measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
        destroyError: cleanupError,
        startError,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([startError, cleanupError]);
  });

  it('сохраняет границу constructor: не чистит объект, который не был опубликован', () => {
    const constructorError = new Error('constructor failed');
    let destroys = 0;
    let caught: unknown;
    class ThrowingCompositorSpring {
      constructor() {
        throw constructorError;
      }

      destroy() {
        destroys++;
      }
    }

    try {
      measureCompositorHandoffLatency({
        CompositorSpring: ThrowingCompositorSpring,
        spring: SPRING,
        property: 'x',
        from: 0,
        to: 100,
        initialNow: 1_000,
        elapsedMs: 16,
        nowNs: () => 1n,
        warmup: 0,
        iters: 1,
        runs: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(constructorError);
    expect(destroys).toBe(0);
  });

  it('отвергает прежний setup с повторным использованием controller', () => {
    const scenario = createScenario();
    const reusedSample = scenario.setup(0);

    expect(() => measureLatency('handoff', {
      ...scenario,
      setup: () => reusedSample,
      nowNs: (() => {
        let value = 0n;
        return () => ++value;
      })(),
      warmup: 1,
      iters: 1,
      runs: 1,
    })).toThrow(/повторно использован/i);
  });

  it('регистрирует CLI handoff только через проверяемый entrypoint', () => {
    const script = readFileSync('scripts/bench-latency.mjs', 'utf8');
    const start = script.indexOf('// ── D.');
    const end = script.indexOf('// ── E.');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const registration = script.slice(start, end);

    expect([...registration.matchAll(/measureCompositorHandoffLatency\(/g)]).toHaveLength(1);
    expect(registration).not.toMatch(
      /new CompositorSpring|\.handoffToLive\(|\b(?:setup|op|verify|teardown)\s*:/,
    );
  });

  it('отвергает пустые размеры и полностью замороженные часы', () => {
    const constantNow = () => 0n;
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: 0,
      iters: 0,
      runs: 1,
    })).toThrow(/iters/);
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: 0,
      iters: 1,
      runs: 0,
    })).toThrow(/runs/);
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: -1,
      iters: 1,
      runs: 1,
    })).toThrow(/warmup/);
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: 0,
      iters: 2,
      runs: 1,
    })).toThrow(/положительн/i);
  });

  it('сохраняет нулевой sample, если часы различили хотя бы одну операцию', () => {
    const timestamps = [0n, 0n, 0n, 7n];
    let index = 0;
    expect(measureLatency('quantized', {
      op() {},
      nowNs: () => timestamps[index++]!,
      warmup: 0,
      iters: 2,
      runs: 1,
    })).toEqual({ label: 'quantized', p50: 0, p95: 7, p99: 7 });
  });
});
