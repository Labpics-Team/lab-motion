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
  it('Number.MAX_VALUE планирует только representable host-chunks и stale-safe cancel', async () => {
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
    timer.jobs[0]!.callback();
    timer.jobs[0]!.callback();
    await Promise.resolve();
    expect(timer.jobs).toHaveLength(2);
    expect(timer.jobs[1]!.ms).toBe(HOST_TIMER_MAX_MS);
    expect(onComplete).not.toHaveBeenCalled();

    controls.cancel();
    expect(timer.jobs[1]!.cancelled).toBe(true);
    timer.jobs[0]!.callback();
    timer.jobs[1]!.callback();
    expect(timer.jobs).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('составляет точный хвост после первого host-chunk и завершает один раз', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const onComplete = vi.fn();
    const delay = HOST_TIMER_MAX_MS + 25;
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay,
      setTimer: timer.setTimer,
      onComplete,
    });
    const duration = Number(target.animateCalls[0]!.timing['duration']);

    expect(timer.jobs.map(({ ms }) => ms)).toEqual([HOST_TIMER_MAX_MS]);
    timer.jobs[0]!.callback();
    await Promise.resolve();
    expect(timer.jobs.map(({ ms }) => ms)).toEqual([
      HOST_TIMER_MAX_MS,
      delay - HOST_TIMER_MAX_MS + duration,
    ]);
    timer.jobs[1]!.callback();

    await expect(controls.finished).resolves.toBeUndefined();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('pause/replay не позволяет stale chunk поднять старую цепочку', async () => {
    const target = fakeEl({}, true);
    const timer = controlledTimers();
    const onComplete = vi.fn();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: SPRING,
      delay: HOST_TIMER_MAX_MS + 25,
      now: () => 0,
      setTimer: timer.setTimer,
      onComplete,
    });

    expect(timer.jobs[0]!.ms).toBe(HOST_TIMER_MAX_MS);
    timer.jobs[0]!.callback();
    controls.pause();
    expect(timer.jobs[0]!.cancelled).toBe(true);
    controls.play();
    expect(timer.jobs).toHaveLength(2);

    await Promise.resolve();
    expect(timer.jobs).toHaveLength(2);
    timer.jobs[0]!.callback();
    expect(timer.jobs).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    timer.jobs[1]!.callback();

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
