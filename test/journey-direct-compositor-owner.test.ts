import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBottomSheet } from '../src/behaviors/index.js';
import {
  createCompositorBottomSheet,
  createCompositorCarousel,
} from '../src/behaviors/compositor/index.js';
import {
  DEFAULT_TOLERANCE,
  tryCompileSpringExecutionArtifactTupleUnchecked,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { pt } from './behaviors-helpers.js';

const SPRING = { mass: 1, stiffness: 100, damping: 10 };

type SurfaceTarget = Parameters<typeof createCompositorBottomSheet>[0]['compositor']['target'];

function noWaapiTarget(): SurfaceTarget {
  return {} as unknown as SurfaceTarget;
}

function frameClock() {
  let nextHandle = 1;
  let queue: Array<(timestamp?: number) => void> = [];
  return {
    requestFrame(callback: (timestamp?: number) => void): number {
      queue.push(callback);
      return nextHandle++;
    },
    step(timestamp: number): void {
      const current = queue;
      queue = [];
      for (const callback of current) callback(timestamp);
    },
    drain(start = 0, limit = 240): void {
      let timestamp = start;
      for (let i = 0; i < limit && queue.length; i++) {
        timestamp += 1000 / 60;
        this.step(timestamp);
      }
    },
    pending(): number {
      return queue.length;
    },
  };
}

function nativeTarget(onCancel?: () => void) {
  let animation: {
    currentTime: number | null;
    cancel(): void;
    finished: Promise<void>;
    resolve(): void;
  } | undefined;
  let calls = 0;
  let cancelCalls = 0;
  const target = {
    animate() {
      calls++;
      let resolve!: () => void;
      const finished = new Promise<void>((done) => { resolve = done; });
      return animation = { currentTime: 0, cancel() { cancelCalls++; onCancel?.(); }, finished, resolve };
    },
  };
  return {
    target,
    get animation() { return animation; },
    get calls() { return calls; },
    get cancelCalls() { return cancelCalls; },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('JOURNEY-01 direct-control compositor owner', () => {
  it('ordinary requestFrame stays ordinary when no package carrier is present', () => {
    let frames = 0;
    const sheet = createBottomSheet({
      snapPoints: [0, 300],
      requestFrame: () => ++frames,
    });
    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 100, 0.05));
    sheet.pointerUp(pt(0, 100, 0.05));
    expect(frames).toBe(1);
    sheet.destroy();
  });

  it('requestFrame stays a pure clock even when hostile properties mimic the internal runner port', () => {
    let frames = 0;
    const requestFrame = (() => ++frames) as ((cb: (timestamp?: number) => void) => number) & {
      _settle?: () => void;
      _invalidate?: () => number;
    };
    requestFrame._settle = () => { throw new Error('requestFrame must never become the runner owner'); };
    requestFrame._invalidate = () => { throw new Error('requestFrame must never become the runner owner'); };
    const sheet = createBottomSheet({ snapPoints: [0, 300], requestFrame });
    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 100, 0.05));
    sheet.pointerUp(pt(0, 100, 0.05));
    expect(frames).toBe(1);
    sheet.destroy();
  });

  it('sheet commits nonzero release velocity natively; pickup samples the same curve without a RAF bridge', async () => {
    const applied: number[] = [];
    const events: string[] = [];
    const native = nativeTarget(() => events.push(`cancel:${applied.at(-1)}`));
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300, 600],
      compositor: {
        target: native.target,
        property: 'translate',
        format: Number,
        apply: (value) => { applied.push(Number(value)); events.push(`apply:${Number(value)}`); },
      },
      requestFrame: () => {
        throw new Error('native settle must not request a main-thread frame');
      },
    });

    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 180, 0.05));
    sheet.pointerUp(pt(0, 180, 0.05));
    expect(native.calls).toBe(1);
    expect(sheet.state.phase).toBe('release');
    expect(sheet.state.velocity).not.toBe(0);

    native.animation!.currentTime = 16;
    const releaseValue = sheet.state.value;
    const stale = native.animation!;
    sheet.pointerDown(pt(0, releaseValue, 0.1));
    expect(sheet.state.phase).toBe('follow');
    expect(applied.at(-1)).not.toBe(releaseValue);
    expect(native.cancelCalls).toBe(1);
    const pickupValue = sheet.state.value;
    const cancelIndex = events.findIndex((event) => event.startsWith('cancel:'));
    expect(cancelIndex).toBeGreaterThan(0);
    expect(events[cancelIndex - 1]).toBe(`apply:${pickupValue}`);
    expect(events[cancelIndex]).toBe(`cancel:${pickupValue}`);
    stale.resolve();
    await Promise.resolve();
    expect(sheet.state.phase).toBe('follow');
    expect(sheet.state.value).toBe(pickupValue);
    sheet.destroy();
  });

  it('preserves release velocity when native local time is still pending at pickup', () => {
    const native = nativeTarget();
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300, 600],
      compositor: {
        target: native.target,
        property: 'translate',
        apply() {},
      },
      requestFrame: () => {
        throw new Error('native settle must not request a main-thread frame');
      },
    });

    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 180, 0.05));
    sheet.pointerUp(pt(0, 180, 0.05));
    const inheritedVelocity = sheet.state.velocity;
    expect(inheritedVelocity).not.toBe(0);
    expect(native.calls).toBe(1);

    native.animation!.currentTime = null;
    const pendingValue = sheet.state.value;
    const pickup = pt(0, pendingValue, 0.1);
    sheet.pointerDown(pickup);
    sheet.pointerUp(pickup);

    expect(native.calls).toBe(2);
    expect(sheet.state.phase).toBe('release');
    expect(sheet.state.value).toBe(pendingValue);
    expect(sheet.state.velocity).toBeCloseTo(inheritedVelocity, 10);
    sheet.destroy();
  });

  it('tier 1 keeps one live owner through pickup, completion and cleanup', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    vi.stubGlobal('navigator', { vendor: 'Google Inc.', userAgent: 'Chrome' });
    __resetDetectionCache();
    const clock = frameClock();
    const native = nativeTarget();
    const applied: number[] = [];
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      spring: SPRING,
      requestFrame: clock.requestFrame,
      compositor: {
        target: native.target,
        property: 'translate',
        format: Number,
        apply: (value) => applied.push(Number(value)),
      },
    });

    sheet.snapTo(1);
    expect(native.calls).toBe(0);
    expect(clock.pending()).toBe(1);
    clock.step(0);
    clock.step(1000 / 60);
    const pickupValue = sheet.state.value;
    const pickupVelocity = sheet.state.velocity;
    expect(pickupValue).toBeGreaterThan(0);
    expect(pickupValue).toBeLessThan(300);
    expect(pickupVelocity).not.toBe(0);

    const pickup = pt(0, pickupValue, 0.05);
    sheet.pointerDown(pickup);
    expect(sheet.state.value).toBe(pickupValue);
    sheet.pointerUp(pickup);
    expect(sheet.state.value).toBe(pickupValue);
    expect(sheet.state.velocity).toBeCloseTo(pickupVelocity, 8);
    const releaseTarget = [0, 300][sheet.state.snapIndex]!;

    clock.drain(1000 / 60);
    expect(sheet.state.phase).toBe('settle');
    expect(sheet.state.value).toBe(releaseTarget);
    expect(sheet.state.velocity).toBe(0);
    const writes = applied.length;
    sheet.destroy();
    clock.drain();
    expect(applied).toHaveLength(writes);
    expect(native.calls).toBe(0);
  });

  it('tier 2 uses the same live handoff and revokes stale work on destroy', () => {
    const clock = frameClock();
    const applied: number[] = [];
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      spring: SPRING,
      requestFrame: clock.requestFrame,
      compositor: {
        target: noWaapiTarget(),
        property: 'translate',
        format: Number,
        apply: (value) => applied.push(Number(value)),
      },
    });

    sheet.snapTo(1);
    clock.step(0);
    clock.step(1000 / 60);
    const pickupValue = sheet.state.value;
    const pickupVelocity = sheet.state.velocity;
    expect(pickupValue).toBeGreaterThan(0);
    expect(pickupVelocity).not.toBe(0);

    const pickup = pt(0, pickupValue, 0.05);
    sheet.pointerDown(pickup);
    sheet.pointerUp(pickup);
    expect(sheet.state.value).toBe(pickupValue);
    expect(sheet.state.velocity).toBeCloseTo(pickupVelocity, 8);

    const writes = applied.length;
    sheet.destroy();
    clock.drain();
    expect(applied).toHaveLength(writes);
  });

  it('tier 4 SSR path completes and cleans up without WAAPI or an injected frame clock', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('requestAnimationFrame', undefined);
    __resetDetectionCache();
    const applied: number[] = [];
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      spring: SPRING,
      compositor: {
        target: noWaapiTarget(),
        property: 'translate',
        format: Number,
        apply: (value) => applied.push(Number(value)),
      },
    });

    sheet.snapTo(1);
    expect(sheet.state.phase).toBe('release');
    await vi.advanceTimersByTimeAsync(34);
    const pickupValue = sheet.state.value;
    const pickupVelocity = sheet.state.velocity;
    expect(pickupValue).toBeGreaterThan(0);
    expect(pickupVelocity).not.toBe(0);

    const pickup = pt(0, pickupValue, 0.05);
    sheet.pointerDown(pickup);
    sheet.pointerUp(pickup);
    expect(sheet.state.value).toBe(pickupValue);
    expect(sheet.state.velocity).toBeCloseTo(pickupVelocity, 8);

    for (let i = 0; i < 240 && sheet.state.phase !== 'settle'; i++) {
      await vi.advanceTimersByTimeAsync(17);
    }
    expect(sheet.state.phase).toBe('settle');
    expect(sheet.state.value).toBe(300);
    expect(sheet.state.velocity).toBe(0);
    const writes = applied.length;
    sheet.destroy();
    await vi.runOnlyPendingTimersAsync();
    expect(applied).toHaveLength(writes);
  });

  it('tier 0 over-cap compile falls back live before ownership changes', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    vi.stubGlobal('navigator', { vendor: 'Google Inc.', userAgent: 'Chrome' });
    __resetDetectionCache();
    const clock = frameClock();
    const native = nativeTarget();
    const applied: number[] = [];
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 0.1],
      spring: SPRING,
      requestFrame: clock.requestFrame,
      compositor: {
        target: native.target,
        property: 'translate',
        format: Number,
        apply: (value) => applied.push(Number(value)),
      },
    });

    const velocity = 0.05 / 0.00005;
    expect(tryCompileSpringExecutionArtifactTupleUnchecked(
      SPRING,
      velocity / 0.05,
      DEFAULT_TOLERANCE,
    )).toBeUndefined();

    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 0.05, 0.00005));
    sheet.pointerUp(pt(0, 0.05, 0.00005));
    expect(sheet.state.velocity).toBeCloseTo(velocity, 8);
    expect(native.calls).toBe(0);
    expect(clock.pending()).toBe(1);

    clock.step(0);
    clock.step(1000 / 60);
    const pickupValue = sheet.state.value;
    const pickupVelocity = sheet.state.velocity;
    expect(pickupValue).toBeGreaterThan(0.05);
    expect(pickupVelocity).not.toBe(0);
    const pickup = pt(0, pickupValue, 0.05);
    sheet.pointerDown(pickup);
    sheet.pointerUp(pickup);
    expect(sheet.state.value).toBe(pickupValue);
    expect(sheet.state.velocity).toBeCloseTo(pickupVelocity, 8);

    const nativeCalls = native.calls;
    const writes = applied.length;
    sheet.destroy();
    clock.drain();
    expect(applied).toHaveLength(writes);
    expect(native.calls).toBe(nativeCalls);
  });

  it('reentrant animate host cannot publish a stale native owner after newer input', () => {
    let sheet!: ReturnType<typeof createCompositorBottomSheet>;
    let calls = 0;
    let cancels = 0;
    let frames = 0;
    const target = {
      animate() {
        calls++;
        const animation = {
          currentTime: 0,
          cancel() { cancels++; },
          finished: new Promise<void>(() => {}),
        };
        sheet.pointerDown(pt(0, 20, 0.01));
        return animation;
      },
    };
    sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      requestFrame: (cb) => { frames++; return setTimeout(() => cb(16), 0) as unknown as number; },
      compositor: { target, property: 'translate', apply() {} },
    });

    sheet.snapTo(1);

    expect(calls).toBe(1);
    expect(cancels).toBe(1);
    expect(frames).toBe(0);
    expect(sheet.state.phase).toBe('follow');
    sheet.destroy();
  });

  it('destroy publishes terminal capability before hostile cancel can reenter', () => {
    let sheet!: ReturnType<typeof createCompositorBottomSheet>;
    let calls = 0;
    let cancels = 0;
    let frames = 0;
    const target = {
      animate() {
        calls++;
        return {
          currentTime: 0,
          cancel() { cancels++; sheet.snapTo(0); },
          finished: new Promise<void>(() => {}),
        };
      },
    };
    sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      requestFrame: (cb) => { frames++; return setTimeout(() => cb(16), 0) as unknown as number; },
      compositor: { target, property: 'translate', apply() {} },
    });
    sheet.snapTo(1);
    expect(calls).toBe(1);

    sheet.destroy();
    sheet.snapTo(1);

    expect(cancels).toBe(1);
    expect(calls).toBe(1);
    expect(frames).toBe(0);
  });

  it('samples reduced-motion once so a changing host cannot split adapter and behavior policy', () => {
    let reads = 0;
    let frames = 0;
    const pager = createCompositorCarousel({
      pageCount: 3,
      pageSize: 200,
      matchMedia: () => ({ matches: ++reads === 1 }),
      requestFrame: () => ++frames,
      compositor: {
        target: { animate() { throw new Error('reduced route reached WAAPI'); } },
        property: 'translate',
        apply() {},
      },
    });
    pager.next();
    expect(reads).toBe(1);
    expect(frames).toBe(0);
    expect(pager.state.value).toBe(200);
    pager.destroy();
  });

  it('pager uses the same native owner while reduced-motion commits no native animation', async () => {
    const native = nativeTarget();
    const pager = createCompositorCarousel({
      pageCount: 3,
      pageSize: 200,
      compositor: {
        target: native.target,
        property: 'translate',
        apply() {},
      },
    });
    pager.next();
    expect(native.calls).toBe(1);
    native.animation!.resolve();
    await Promise.resolve();
    expect(pager.state.phase).toBe('settle');
    expect(pager.state.value).toBe(200);
    expect(native.cancelCalls).toBe(1);
    pager.destroy();

    const reducedNative = nativeTarget();
    const reduced = createCompositorCarousel({
      pageCount: 3,
      pageSize: 200,
      matchMedia: () => ({ matches: true }),
      compositor: {
        target: reducedNative.target,
        property: 'translate',
        apply() {},
      },
    });
    reduced.next();
    expect(reducedNative.calls).toBe(0);
    expect(reduced.state.value).toBe(200);
    reduced.destroy();
  });
});
