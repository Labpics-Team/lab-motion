import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupRecord } from '../src/animate/channels.js';
import { animate, type AnimateControls } from '../src/animate/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };
const NativePromise = Promise;

function poisonPromise(): void {
  vi.stubGlobal('Promise', class {
    constructor() { throw new Error('poisoned Promise constructor'); }
    static resolve(): never { throw new Error('poisoned Promise.resolve'); }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('animate: hostile queueMicrotask', () => {
  it('не оставляет main-owner без controls после поздней подмены Promise', async () => {
    const callbacks: Array<(ts?: number) => void> = [];
    let frameRequests = 0;
    const target = {
      style: { getPropertyValue: () => '0', setProperty() {} },
    };
    let controls: AnimateControls | undefined;
    let failure: unknown;
    poisonPromise();
    try {
      controls = animate(target, { opacity: [0, 1] }, {
        duration: 100,
        requestFrame(callback) {
          callbacks.push(callback);
          return ++frameRequests;
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      vi.unstubAllGlobals();
    }

    controls?.cancel();
    const requestsAfterCancel = frameRequests;
    callbacks.shift()?.(0);

    expect(frameRequests).toBe(requestsAfterCancel);
    expect(groupRecord(target, 'opacity')._owner).toBeUndefined();
    expect(failure).toBeUndefined();
    expect(controls).toBeDefined();
    await controls!.finished;
  });

  it('сохраняет cancel → caller job → finished ordering под hostile globals', async () => {
    const target = {
      style: { getPropertyValue: () => '0', setProperty() {} },
    };
    let controls: AnimateControls | undefined;
    poisonPromise();
    try {
      controls = animate(target, { opacity: [0, 1] }, {
        duration: 100,
        requestFrame: () => 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const events: string[] = [];
    void controls!.finished.then(() => events.push('finished'));
    poisonPromise();
    vi.stubGlobal('queueMicrotask', () => { throw new Error('poisoned queue'); });
    try {
      controls!.cancel();
      void NativePromise.resolve().then(() => events.push('after-cancel'));
    } finally {
      vi.unstubAllGlobals();
    }

    await controls!.finished;
    expect(events).toEqual(['after-cancel', 'finished']);
  });

  it('ассимилирует WAAPI finished после поздней подмены Promise', async () => {
    let resolveHost!: () => void;
    const hostFinished = new NativePromise<void>((resolve) => { resolveHost = resolve; });
    let output = '0';
    let completed = 0;
    const target = {
      style: {
        getPropertyValue: () => output,
        setProperty(_name: string, value: string) { output = value; },
      },
      animate: () => ({
        currentTime: Number.MAX_VALUE,
        finished: hostFinished,
        cancel() {},
      }),
    };
    let controls: AnimateControls | undefined;
    let failure: unknown;
    poisonPromise();
    try {
      controls = animate(target, { opacity: [0, 1] }, {
        spring: SPRING,
        delay: 2 ** 31,
        onComplete: () => { completed++; },
      });
    } catch (error) {
      failure = error;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(failure).toBeUndefined();
    expect(controls).toBeDefined();
    resolveHost();
    await controls!.finished;
    expect(completed).toBe(1);
    expect(groupRecord(target, 'opacity')._owner).toBeUndefined();
  });

  it('не прячет controls и не подвешивает finished', async () => {
    const target = {
      style: { getPropertyValue: () => '0', setProperty() {} },
    };
    let controls: AnimateControls | undefined;
    vi.stubGlobal('queueMicrotask', () => { throw new Error('queue failed'); });

    expect(() => {
      controls = animate(target, { opacity: [0, 1] }, {
        duration: 100,
        requestFrame: () => 1,
      });
      controls.cancel();
    }).not.toThrow();

    await expect(controls!.finished).resolves.toBeUndefined();
  });

  it('ошибка onComplete не прячет controls и не заменяет natural completion', async () => {
    const target = {
      style: { getPropertyValue: () => '0', setProperty() {} },
    };
    let controls: AnimateControls | undefined;
    vi.stubGlobal('queueMicrotask', () => { throw new Error('report queue failed'); });
    vi.stubGlobal('reportError', () => { throw new Error('reporter failed'); });

    expect(() => {
      controls = animate(target, { opacity: [0, 1] }, {
        matchMedia: () => ({ matches: true }),
        onComplete: () => { throw new Error('callback failed'); },
      });
    }).not.toThrow();

    await expect(controls!.finished).resolves.toBeUndefined();
  });

  it('выпускает captured WAAPI wake после late capability throw', async () => {
    let output = '0';
    let timerCallback!: () => void;
    let armed = false;
    let completed = 0;
    const animation = {
      get currentTime(): number {
        if (armed) {
          armed = false;
          timerCallback();
        }
        return 1_000_000;
      },
      cancel() {},
    };
    const first = {
      style: {
        getPropertyValue: () => output,
        setProperty(_name: string, value: string) { output = value; },
      },
      animate: () => animation,
    };
    const late = {
      style: { getPropertyValue: () => '0', setProperty() {} },
    } as { style: typeof first.style; readonly animate?: unknown };
    Object.defineProperty(late, 'animate', {
      get() { throw new Error('late capability failed'); },
    });
    const controls = animate(first, { opacity: [0, 1] }, {
      spring: SPRING,
      setTimer(callback) { timerCallback = callback; return () => {}; },
      onComplete: () => { completed++; },
    });
    vi.stubGlobal('queueMicrotask', () => { throw new Error('queue failed'); });

    armed = true;
    expect(() => animate([first, late], { opacity: 0 }, {
      spring: SPRING,
      setTimer: () => () => {},
    })).toThrow('late capability failed');

    await controls.finished;
    expect(completed).toBe(1);
  });

  it('успешный successor классифицирует captured wake как supersede', async () => {
    let output = '0';
    let timerCallback!: () => void;
    let armed = false;
    let completed = 0;
    const animation = {
      get currentTime(): number {
        if (armed) {
          armed = false;
          timerCallback();
        }
        return 1_000_000;
      },
      cancel() {},
    };
    const target = {
      style: {
        getPropertyValue: () => output,
        setProperty(_name: string, value: string) { output = value; },
      },
      animate: () => animation,
    };
    const first = animate(target, { opacity: [0, 1] }, {
      spring: SPRING,
      setTimer(callback) { timerCallback = callback; return () => {}; },
      onComplete: () => { completed++; },
    });

    armed = true;
    const successor = animate(target, { opacity: 0 }, {
      spring: SPRING,
      setTimer: () => () => {},
    });
    await first.finished;
    expect(completed).toBe(0);
    successor.cancel();
    await successor.finished;
  });
});
