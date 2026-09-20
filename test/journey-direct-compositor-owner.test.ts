import { describe, expect, it } from 'vitest';
import { createBottomSheet } from '../src/behaviors/index.js';
import {
  createCompositorBottomSheet,
  createCompositorCarousel,
} from '../src/behaviors/compositor/index.js';
import { pt } from './behaviors-helpers.js';

function nativeTarget(onCancel?: () => void) {
  let animation: {
    currentTime: number;
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

  it('an ordinary requestFrame with a coincidental _settle property is not treated as the private carrier', () => {
    let frames = 0;
    const requestFrame = (() => ++frames) as ((cb: (timestamp?: number) => void) => number) & { _settle?: () => void };
    requestFrame._settle = () => { throw new Error('must not be used as a carrier without _invalidate'); };
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
