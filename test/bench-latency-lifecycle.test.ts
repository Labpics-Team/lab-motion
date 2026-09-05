import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CompositorSpring,
  type CompositorSpringOptions,
} from '../src/compositor/index.js';
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
const TEST_DONOR_TIMING = {
  duration: 100,
  easing: TEST_DONOR_EASING,
  iterations: 1,
  fill: 'both',
  composite: 'replace',
} as const;
const TEST_EXPLICIT_KEYFRAMES = [
  { offset: 0, x: 0, easing: 'linear' },
  { offset: 0.1, x: 2, easing: 'linear' },
  { offset: 0.2, x: 4, easing: 'linear' },
  { offset: 1, x: 100, easing: 'linear' },
] as const;
const TEST_EXPLICIT_TIMING = { ...TEST_DONOR_TIMING, easing: 'linear' } as const;

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
  donorPlan?: Readonly<{
    keyframes: readonly Record<string, string | number>[];
    timing: Readonly<Record<string, unknown>>;
  }>;
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
        const plan = behavior.donorPlan ?? {
          keyframes: TEST_DONOR_KEYFRAMES,
          timing: TEST_DONOR_TIMING,
        };
        this.animations.push(this.options.target.animate(
          plan.keyframes,
          plan.timing,
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

type DonorPlanMutation = (
  keyframes: Record<string, string | number>[],
  timing: object,
) => readonly [keyframes: Record<string, string | number>[], timing: object];

function createPlanMutatingCompositorSpring(mutate: DonorPlanMutation) {
  return class PlanMutatingCompositorSpring extends CompositorSpring {
    constructor(options: CompositorSpringOptions) {
      const target = options.target!;
      super({
        ...options,
        target: {
          animate(keyframes, timing) {
            const [mutatedKeyframes, mutatedTiming] = mutate(keyframes, timing);
            return target.animate(mutatedKeyframes, mutatedTiming);
          },
        },
      });
    }
  };
}

function measureRealHandoff(Implementation: typeof CompositorSpring) {
  let nowNs = 0n;
  return measureCompositorHandoffLatency({
    CompositorSpring: Implementation,
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

  it('принимает explicit-linear donor с полным набором линейных stops', () => {
    expect(measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      donorPlan: {
        keyframes: TEST_EXPLICIT_KEYFRAMES,
        timing: TEST_EXPLICIT_TIMING,
      },
    })).toEqual({
      label: 'CompositorSpring.handoffToLive (read+cancel+build)',
      p50: 1,
      p95: 1,
      p99: 1,
    });
  });

  it('принимает два неявно размещённых endpoint keyframes для CSS linear()', () => {
    expect(measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      donorPlan: {
        keyframes: [{ x: 0 }, { x: 100 }],
        timing: TEST_DONOR_TIMING,
      },
    })).toEqual({
      label: 'CompositorSpring.handoffToLive (read+cancel+build)',
      p50: 1,
      p95: 1,
      p99: 1,
    });
  });

  it('отвергает нелинейный segment easing explicit-linear donor', () => {
    expect(() => measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      donorPlan: {
        keyframes: TEST_EXPLICIT_KEYFRAMES.map((frame, index) => (
          index === 1 ? { ...frame, easing: 'steps(1)' } : frame
        )),
        timing: TEST_EXPLICIT_TIMING,
      },
    })).toThrow(/donor/i);
  });

  it.each([
    ['keyframe easing', (keyframes, timing) => [
      keyframes.map((frame) => ({ ...frame, easing: 'steps(1)' })),
      timing,
    ]],
    ['keyframe composite', (keyframes, timing) => [
      keyframes.map((frame) => ({ ...frame, composite: 'add' })),
      timing,
    ]],
    ['timing direction', (keyframes, timing) => [
      keyframes,
      { ...timing, direction: 'reverse' },
    ]],
    ['timing iterations', (keyframes, timing) => [
      keyframes,
      { ...timing, iterations: 2 },
    ]],
    ['timing iterationStart', (keyframes, timing) => [
      keyframes,
      { ...timing, iterationStart: 0.5 },
    ]],
    ['timing endDelay', (keyframes, timing) => [
      keyframes,
      { ...timing, endDelay: 100 },
    ]],
    ['timing composite', (keyframes, timing) => [
      keyframes,
      { ...timing, composite: 'add' },
    ]],
    ['timing fill', (keyframes, timing) => [
      keyframes,
      { ...timing, fill: 'none' },
    ]],
    ['timing timeline', (keyframes, timing) => [
      keyframes,
      { ...timing, timeline: {} },
    ]],
    ['лишний CSS keyframe', (keyframes, timing) => [
      [keyframes[0]!, { ...keyframes[0]!, offset: 0.5 }, keyframes.at(-1)!],
      timing,
    ]],
    ['неполный CSS offset range', (keyframes, timing) => [
      keyframes.map((frame, index) => (
        index === keyframes.length - 1 ? { ...frame, offset: 0.75 } : frame
      )),
      timing,
    ]],
  ] satisfies ReadonlyArray<readonly [string, DonorPlanMutation]>)(
    'отвергает modifier-counterfeit: %s',
    (_label, mutate) => {
      expect(() => measureRealHandoff(createPlanMutatingCompositorSpring(mutate)))
        .toThrow(/donor/i);
    },
  );

  it('отвергает finite explicit stops с бесконечной производной oracle', () => {
    expect(() => measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      createLive: () => ({ value: 0, velocity: 187.28074645403436, destroy() {} }),
      donorPlan: {
        keyframes: [
          { offset: 0, x: 0 },
          { offset: 0.16, x: 0 },
          { offset: 0.16000000000000003, x: Number.MAX_VALUE },
          { offset: 1, x: 100 },
        ],
        timing: TEST_EXPLICIT_TIMING,
      },
    })).toThrow(/donor/i);
  });

  it('отвергает унаследованный WebIDL timing modifier', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'timeline');

    expect(() => {
      try {
        Object.defineProperty(Object.prototype, 'timeline', {
          configurable: true,
          value: null,
        });
        measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS);
      } finally {
        if (previous) Object.defineProperty(Object.prototype, 'timeline', previous);
        else Reflect.deleteProperty(Object.prototype, 'timeline');
      }
    }).toThrow(/donor/i);
  });

  it.each([
    ['NBSP вместо CSS whitespace', TEST_DONOR_EASING.replaceAll(' ', '\u00a0'), EXPECTED_FAKE_LIVE],
    ['hex-числа', 'linear(0x0 0x0%,0x1 0x64%)', { value: 16, velocity: 1_000 }],
  ] as const)('отвергает неэмитируемый linear(): %s', (_label, easing, live) => {
    expect(() => measureFakeHandoff(SETUP_EFFECTS, HANDOFF_EFFECTS, {
      createLive: () => ({ ...live, destroy() {} }),
      donorPlan: {
        keyframes: TEST_DONOR_KEYFRAMES,
        timing: { ...TEST_DONOR_TIMING, easing },
      },
    })).toThrow(/donor/i);
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

  it('вызывает teardown, даже если teardown-observer бросает', () => {
    const phaseError = new Error('teardown observer failed');
    let caught: unknown;
    let teardownCalls = 0;
    let nowNs = 0n;

    try {
      measureLatency('observer failure', {
        op: () => 'live',
        nowNs: () => ++nowNs,
        onPhase(phase: string) {
          if (phase === 'teardown') throw phaseError;
        },
        teardown() {
          teardownCalls++;
        },
        warmup: 0,
        iters: 1,
        runs: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(phaseError);
    expect(teardownCalls).toBe(1);
  });

  it('сохраняет observer-ошибку первой, если teardown тоже падает', () => {
    const phaseError = new Error('teardown observer failed');
    const teardownError = new Error('teardown failed');
    let caught: unknown;
    let nowNs = 0n;

    try {
      measureLatency('double cleanup failure', {
        op: () => 'live',
        nowNs: () => ++nowNs,
        onPhase(phase: string) {
          if (phase === 'teardown') throw phaseError;
        },
        teardown() {
          throw teardownError;
        },
        warmup: 0,
        iters: 1,
        runs: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([phaseError, teardownError]);
  });

  it('сохраняет op-ошибку при отказе teardown-observer и всё равно чистит', () => {
    const opError = new Error('op failed');
    const phaseError = new Error('teardown observer failed');
    let caught: unknown;
    let teardownCalls = 0;

    try {
      measureLatency('op and observer failure', {
        op() {
          throw opError;
        },
        onPhase(phase: string) {
          if (phase === 'teardown') throw phaseError;
        },
        teardown() {
          teardownCalls++;
        },
        warmup: 1,
        iters: 1,
        runs: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([opError, phaseError]);
    expect(teardownCalls).toBe(1);
  });

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
