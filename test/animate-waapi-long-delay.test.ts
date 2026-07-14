/** Длинные analytical completion timers full WAAPI не полагаются на host clamp. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/index.js';
import { bindGroup, groupRecord, parseProps } from '../src/animate/channels.js';
import { WaapiUnit } from '../src/animate/waapi-unit.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import type { SetTimerFn } from '../src/compositor/core.js';
import { fakeEl } from './animate-facade-helpers.js';

// HTML/Node timers используют signed 32-bit delay; это platform boundary,
// а не настраиваемый performance-порог.
const HOST_TIMER_MAX_MS = 2 ** 31 - 1;
const SPRING = { mass: 1, stiffness: 170, damping: 26 };

interface TimerJob {
  readonly callback: () => void;
  readonly ms: number;
  cancelled: boolean;
  cancelCalls: number;
}

function controlledTimers(): { readonly jobs: TimerJob[]; readonly setTimer: SetTimerFn } {
  const jobs: TimerJob[] = [];
  return {
    jobs,
    setTimer(callback, ms) {
      const job = { callback, ms, cancelled: false, cancelCalls: 0 };
      jobs.push(job);
      return () => {
        job.cancelled = true;
        job.cancelCalls++;
      };
    },
  };
}

beforeEach(() => {
  __resetDetectionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('animate WAAPI: точный long-delay timer', () => {
  it.each(['throw', 'callback-then-throw'] as const)(
    'async re-arm %s терминализирует owner без unhandled',
    async (failure) => {
      const target = fakeEl({}, true);
      let now = 0;
      let firstWake!: () => void;
      let timerCalls = 0;
      const onComplete = vi.fn();
      const controls = animate(target.el, { opacity: [0, 1] }, {
        spring: SPRING,
        delay: HOST_TIMER_MAX_MS + 25,
        now: () => now,
        setTimer(callback) {
          timerCalls++;
          if (timerCalls === 1) {
            firstWake = callback;
            return () => {};
          }
          if (failure === 'callback-then-throw') callback();
          throw new Error(`re-arm ${failure}`);
        },
        onComplete,
      });
      let settled = false;
      void controls.finished.then(() => { settled = true; });

      now = HOST_TIMER_MAX_MS;
      firstWake();
      await Promise.resolve();
      await Promise.resolve();

      expect(timerCalls).toBe(2);
      expect(target.cancels).toBe(1);
      expect(settled).toBe(true);
      expect(onComplete).not.toHaveBeenCalled();
    },
  );

  it('sync long-delay seam не создаёт microtask starvation', async () => {
    const target = fakeEl({}, true);
    const onComplete = vi.fn();
    let timerCalls = 0;
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: Number.MAX_VALUE,
      now: () => 0,
      setTimer(callback) {
        timerCalls++;
        if (timerCalls <= 2) callback();
        return () => {};
      },
      onComplete,
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(timerCalls).toBe(1);
    expect(target.cancels).toBe(1);
    expect(settled).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([0, Number.MAX_VALUE])(
    'не строит MAX-цепь при wake-clock %s и непредставимом active-tail',
    async (wakeNow) => {
      const target = fakeEl({}, true);
      const timer = controlledTimers();
      const onComplete = vi.fn();
      let now = 0;
      const controls = animate(target.el, { opacity: [0, 1] }, {
        spring: SPRING,
        delay: Number.MAX_VALUE,
        now: () => now,
        setTimer: timer.setTimer,
        onComplete,
      });
      let settled = false;
      void controls.finished.then(() => { settled = true; });

      now = wakeNow;
      timer.jobs[0]!.callback();
      await Promise.resolve();
      await Promise.resolve();

      if (wakeNow === Number.MAX_VALUE) {
        expect(timer.jobs).toHaveLength(2);
        expect(settled).toBe(false);
        timer.jobs[1]!.callback();
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(timer.jobs).toHaveLength(wakeNow === 0 ? 1 : 2);
      expect(target.cancels).toBe(1);
      expect(settled).toBe(true);
      expect(onComplete).not.toHaveBeenCalled();
    },
  );

  it('late Chromium currentTime догоняет конец без лишнего 24.8-day chunk', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const cancel = vi.fn();
    let currentTime = 0;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel,
        get currentTime() { return currentTime; },
      };
    };
    const onComplete = vi.fn();
    const delay = HOST_TIMER_MAX_MS + 25;
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay,
      now: () => 0,
      setTimer: timer.setTimer,
      onComplete,
    });
    const duration = Number(target.animateCalls[0]!.timing['duration']);

    currentTime = delay + duration + 1;
    timer.jobs[0]!.callback();
    await controls.finished;

    expect(timer.jobs).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('не принимает потерянный ULP-tail за natural completion', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const delay = 2 ** 60;
    let currentTime = 0;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel: vi.fn(),
        get currentTime() { return currentTime; },
      };
    };
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay,
      setTimer: timer.setTimer,
      onComplete,
    });
    const duration = Number(target.animateCalls[0]!.timing['duration']);

    currentTime = delay + duration;
    expect(currentTime - delay).toBeLessThan(duration);
    timer.jobs[0]!.callback();
    expect(timer.jobs).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();

    currentTime = delay + 1024;
    timer.jobs[1]!.callback();
    await controls.finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('native finished не обходит проверку потерянного ULP-tail', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const delay = 2 ** 60;
    let currentTime = 0;
    let resolveNative!: () => void;
    const finished = new Promise<void>((resolve) => { resolveNative = resolve; });
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel: vi.fn(),
        get currentTime() { return currentTime; },
        finished,
      } as never;
    };
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay,
      setTimer: timer.setTimer,
      onComplete,
    });
    const duration = Number(target.animateCalls[0]!.timing['duration']);

    currentTime = delay + duration;
    expect(currentTime - delay).toBeLessThan(duration);
    resolveNative();
    await Promise.resolve();
    await Promise.resolve();

    expect(onComplete).not.toHaveBeenCalled();
    expect(timer.jobs).toHaveLength(1);
    currentTime = delay + 1024;
    timer.jobs[0]!.callback();
    await controls.finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('native finished без положительного local-time завершается fail-closed', async () => {
    const target = fakeEl({}, true);
    let resolveNative!: () => void;
    const finished = new Promise<void>((resolve) => { resolveNative = resolve; });
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return { cancel: vi.fn(), currentTime: 0, finished } as never;
    };
    const setTimer = vi.fn(() => { throw new Error('async tail must not arm'); });
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: Number.MAX_VALUE,
      setTimer,
      onComplete,
    });

    resolveNative();
    await Promise.resolve();
    await Promise.resolve();

    expect(setTimer).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('native finished владеет недоступным timer-диапазоном', async () => {
    const target = fakeEl({}, true);
    const cancel = vi.fn();
    let resolveNative!: () => void;
    const finished = new Promise<void>((resolve) => { resolveNative = resolve; });
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return { cancel, currentTime: null, finished } as never;
    };
    const setTimer = vi.fn(() => () => {});
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: Number.MAX_VALUE,
      setTimer,
      onComplete,
    });

    expect(setTimer).not.toHaveBeenCalled();
    resolveNative();
    await controls.finished;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each(['reject', 'resolve-then-reject'] as const)(
    'sync finished thenable %s терминализируется после публикации owner и один раз',
    async (mode) => {
      const target = fakeEl({}, true);
      const record = groupRecord(target.el, 'opacity');
      const cancel = vi.fn();
      const onComplete = vi.fn();
      target.el.animate = (keyframes, timing) => {
        target.animateCalls.push({ keyframes, timing });
        return {
          cancel,
          finished: {
            then(resolve: (value: unknown) => void, reject: (error: Error) => void) {
              if (mode === 'resolve-then-reject') resolve(undefined);
              reject(new Error('native failed'));
            },
          },
        } as never;
      };

      const controls = animate(target.el, { opacity: [0, 1] }, {
        spring: SPRING,
        delay: Number.MAX_VALUE,
        onComplete,
      });
      await controls.finished;

      expect(record._owner).toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(mode === 'resolve-then-reject' ? 1 : 0);
    },
  );

  it('reuse Animation не позволяет stale native finished завершить replay', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const cancel = vi.fn();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<void>(() => {});
    let current = first;
    let calls = 0;
    const shared = {
      cancel,
      currentTime: null,
      get finished() { return current; },
    };
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      current = calls++ === 0 ? first : second;
      return shared as never;
    };
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: Number.MAX_VALUE,
      setTimer: timer.setTimer,
      onComplete,
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    controls.pause();
    controls.play();
    expect(timer.jobs).toHaveLength(1);
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    timer.jobs[0]!.callback();
    await controls.finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('reentrant currentTime не позволяет старому wake затереть replay-token', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const onComplete = vi.fn();
    const delay = HOST_TIMER_MAX_MS + 25;
    let controls!: ReturnType<typeof animate>;
    let reenter = true;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      const end = delay + Number(timing['duration']) + 1;
      return {
        cancel: vi.fn(),
        get currentTime() {
          if (!reenter) return 0;
          reenter = false;
          controls.pause();
          controls.play();
          return end;
        },
      };
    };
    controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay,
      now: () => 0,
      setTimer: timer.setTimer,
      onComplete,
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    timer.jobs[0]!.callback();
    await Promise.resolve();

    expect(timer.jobs).toHaveLength(2);
    expect(timer.jobs[1]!.cancelled).toBe(false);
    expect(settled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    timer.jobs[1]!.callback();
    await controls.finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('natural wake из currentTime getter не переживает pause/replay', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const onComplete = vi.fn();
    let wakeInGetter = true;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel: vi.fn(),
        get currentTime() {
          if (wakeInGetter) {
            wakeInGetter = false;
            timer.jobs[0]!.callback();
          }
          return 0;
        },
      } as never;
    };
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      setTimer: timer.setTimer,
      onComplete,
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    controls.pause();
    controls.play();
    await Promise.resolve();

    expect(timer.jobs).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    timer.jobs[1]!.callback();
    await controls.finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('stale sync-wake microtask не завершает replay с тем же Animation', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    let timerCalls = 0;
    const setTimer: SetTimerFn = (callback, ms) => {
      timerCalls++;
      if (timerCalls === 1) {
        callback();
        return () => {};
      }
      return timer.setTimer(callback, ms);
    };
    const shared = { cancel: vi.fn() };
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return shared;
    };
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: HOST_TIMER_MAX_MS + 25,
      now: () => 0,
      setTimer,
      onComplete,
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    controls.pause();
    controls.play();
    await Promise.resolve();

    expect(timerCalls).toBe(2);
    expect(settled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    timer.jobs[0]!.callback();
    await controls.finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('duck scheduler получает bounded chunk одним stale-safe owner', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: Number.MAX_VALUE,
      now: () => 0,
      setTimer: timer.setTimer,
      onComplete,
    });

    expect(target.animateCalls[0]!.timing['delay']).toBe(Number.MAX_VALUE);
    expect(timer.jobs[0]!.ms).toBe(HOST_TIMER_MAX_MS);

    controls.cancel();
    expect(timer.jobs[0]!.cancelled).toBe(true);
    timer.jobs[0]!.callback();
    expect(timer.jobs).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('составляет хвост из actual clock и завершает ровно один раз', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const onComplete = vi.fn();
    const delay = HOST_TIMER_MAX_MS + 25;
    let now = 0;
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay,
      now: () => now,
      setTimer: timer.setTimer,
      onComplete,
    });
    const duration = Number(target.animateCalls[0]!.timing['duration']);

    expect(timer.jobs.map(({ ms }) => ms)).toEqual([HOST_TIMER_MAX_MS]);
    now = HOST_TIMER_MAX_MS;
    timer.jobs[0]!.callback();
    expect(timer.jobs.map(({ ms }) => ms)).toEqual([
      HOST_TIMER_MAX_MS,
      delay - HOST_TIMER_MAX_MS + duration,
    ]);
    now = delay + duration + 1;
    timer.jobs[1]!.callback();

    await expect(controls.finished).resolves.toBeUndefined();
    expect(timer.jobs).toHaveLength(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('pause/replay не позволяет stale deadline завершить новый effect', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const onComplete = vi.fn();
    let now = 0;
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: HOST_TIMER_MAX_MS + 25,
      now: () => now,
      setTimer: timer.setTimer,
      onComplete,
    });

    expect(timer.jobs[0]!.ms).toBe(HOST_TIMER_MAX_MS);
    now = HOST_TIMER_MAX_MS;
    timer.jobs[0]!.callback();
    expect(timer.jobs).toHaveLength(2);
    controls.pause();
    expect(timer.jobs[1]!.cancelled).toBe(true);
    controls.play();
    expect(timer.jobs).toHaveLength(3);

    await Promise.resolve();
    expect(timer.jobs).toHaveLength(3);
    timer.jobs[1]!.callback();
    expect(timer.jobs).toHaveLength(3);
    expect(onComplete).not.toHaveBeenCalled();
    timer.jobs[2]!.callback();

    await expect(controls.finished).resolves.toBeUndefined();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('delay + duration overflow не передаёт Infinity в timer seam', () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const record = groupRecord(target.el, 'opacity');
    const bound = bindGroup(
      target.el,
      'opacity',
      parseProps({ opacity: [0, 1] }),
      record,
    );
    const onDone = vi.fn();
    const unit = new WaapiUnit({
      _el: target.el,
      _group: 'opacity',
      _record: record,
      _numeric: bound._numeric,
      _residuals: bound._residuals,
      _transform: bound._transform,
      _spring: SPRING,
      _delayMs: Number.MAX_VALUE,
      _now: () => 0,
      _setTimer: timer.setTimer,
      _getBatch: () => { throw new Error('live batch не должен создаваться'); },
      _onDone: onDone,
      _artifact: [
        'linear(0 0%, 1 100%)',
        new Float64Array([0, 0, 100, 1]),
        Number.MAX_VALUE,
      ],
    });

    expect(timer.jobs[0]!.ms).toBe(HOST_TIMER_MAX_MS);
    expect(Number.isFinite(timer.jobs[0]!.ms)).toBe(true);
    unit._rollback();
    expect(timer.jobs[0]!.cancelled).toBe(true);
    expect(onDone).toHaveBeenCalledWith(false);
  });

  it('callback-then-throw не оставляет живую long-delay цепочку', async () => {
    const target = fakeEl({}, true);
    const callbacks: Array<() => void> = [];
    const setTimer: SetTimerFn = (callback) => {
      callbacks.push(callback);
      callback();
      throw new Error('timer failed after callback');
    };

    expect(() => animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: HOST_TIMER_MAX_MS + 25,
      setTimer,
    })).toThrow('timer failed after callback');

    await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    expect(target.cancels).toBe(1);
  });
});
