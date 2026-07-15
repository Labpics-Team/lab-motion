/**
 * Длинные delay на WAAPI-first юните (compositor-unit): bounded-таймер
 * завершения с int32-клампом и добором остатка по инжектированным часам.
 *
 * Пере-пиновка R3c-1: старый WaapiUnit читал native finished/currentTime и
 * строил verify-цепочки — новый юнит НИКОГДА не читает host-время (снимок
 * аналитический из IR), поэтому единственный контракт длинного delay —
 * дисциплина плеч setTimer: ни одно плечо не превышает signed int32
 * (граница HTML-таймеров, не настраиваемый порог), остаток добирается
 * повторными плечами, завершение — ровно один раз по фактическим часам.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import type { SetTimerFn } from '../src/compositor/core.js';
import { fakeEl } from './animate-facade-helpers.js';

// HTML/Node timers используют signed 32-bit delay; это platform boundary.
const HOST_TIMER_MAX_MS = 2 ** 31 - 1;
const SPRING = { mass: 1, stiffness: 170, damping: 26 };

interface TimerJob {
  readonly callback: () => void;
  readonly ms: number;
  cancelled: boolean;
}

function controlledTimers(): { readonly jobs: TimerJob[]; readonly setTimer: SetTimerFn } {
  const jobs: TimerJob[] = [];
  return {
    jobs,
    setTimer(callback, ms) {
      const job = { callback, ms, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
  };
}

/** Физический старт юнита — один queueMicrotask на вызов (lazy-commit R2). */
async function flushCommit(): Promise<void> {
  await Promise.resolve();
}

beforeEach(() => {
  __resetDetectionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('animate WAAPI-юнит: bounded long-delay таймер', () => {
  it('int32-кламп: плечо ≤ 2^31−1, добор остатка, завершение ровно один раз', async () => {
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
    await flushCommit();

    // Host получает ПОЛНЫЙ delay (кривая едет у браузера), таймер — кламп.
    expect(target.animateCalls[0]!.timing['delay']).toBe(delay);
    const duration = Number(target.animateCalls[0]!.timing['duration']);
    expect(timer.jobs.map(({ ms }) => ms)).toEqual([HOST_TIMER_MAX_MS]);

    now = HOST_TIMER_MAX_MS;
    timer.jobs[0]!.callback();
    // Позиция ещё до дедлайна: то же плечо добирает остаток по actual clock.
    expect(timer.jobs.map(({ ms }) => ms)).toEqual([
      HOST_TIMER_MAX_MS,
      delay + duration - HOST_TIMER_MAX_MS,
    ]);
    expect(onComplete).not.toHaveBeenCalled();

    now = delay + duration + 1;
    timer.jobs[1]!.callback();
    expect(timer.jobs).toHaveLength(2); // цепочка закончена, лишних плеч нет
    expect(onComplete).toHaveBeenCalledTimes(1);
    // Финальная поза — из плана (SSOT), host-effect снят.
    expect(target.writes.at(-1)).toEqual({ prop: 'opacity', value: '1' });
    expect(target.cancels).toBe(1);
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('delay = MAX_VALUE: Infinity не течёт в timer seam, wake по MAX завершает без цепи', async () => {
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
    await flushCommit();

    // delay + duration абсорбируется в MAX_VALUE — плечо всё равно конечно.
    expect(target.animateCalls[0]!.timing['delay']).toBe(Number.MAX_VALUE);
    expect(timer.jobs.map(({ ms }) => ms)).toEqual([HOST_TIMER_MAX_MS]);
    expect(Number.isFinite(timer.jobs[0]!.ms)).toBe(true);

    // Преждевременный wake (часы не двигались) переармирует bounded-плечо.
    timer.jobs[0]!.callback();
    expect(timer.jobs.map(({ ms }) => ms)).toEqual([HOST_TIMER_MAX_MS, HOST_TIMER_MAX_MS]);
    expect(onComplete).not.toHaveBeenCalled();

    // Wake на фактических MAX-часах: позиция достигла абсорбированного
    // дедлайна — завершение сразу, БЕЗ 24.8-дневной цепочки MAX-плеч.
    now = Number.MAX_VALUE;
    timer.jobs[1]!.callback();
    expect(timer.jobs).toHaveLength(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('cancel снимает плечо; stale wake отменённого плеча мёртв', async () => {
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
    await flushCommit();

    controls.cancel();
    expect(timer.jobs[0]!.cancelled).toBe(true);
    // Host мог всё равно исполнить отменённое плечо — оно инертно.
    timer.jobs[0]!.callback();
    expect(timer.jobs).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('pause/play: stale плечо не завершает replay, новый дедлайн — один раз', async () => {
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
    await flushCommit();
    const duration = Number(target.animateCalls[0]!.timing['duration']);

    controls.pause();
    expect(timer.jobs[0]!.cancelled).toBe(true);
    controls.play();
    // Re-эмиссия effect с виртуальной позиции + новое bounded-плечо.
    expect(target.animateCalls).toHaveLength(2);
    expect(timer.jobs).toHaveLength(2);
    expect(timer.jobs[1]!.cancelled).toBe(false);

    timer.jobs[0]!.callback(); // stale wake отменённого плеча
    expect(timer.jobs).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();

    now = HOST_TIMER_MAX_MS + 25 + duration + 1;
    timer.jobs[1]!.callback();
    expect(onComplete).toHaveBeenCalledTimes(1);
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it.each(['throw', 'callback-then-throw'] as const)(
    'hostile re-arm %s терминализирует юнит fail-closed без unhandled',
    async (failure) => {
      const target = fakeEl({}, true);
      const onComplete = vi.fn();
      let timerCalls = 0;
      let firstWake!: () => void;
      let now = 0;
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
      await flushCommit();
      let settled = false;
      void controls.finished.then(() => {
        settled = true;
      });

      now = HOST_TIMER_MAX_MS;
      // Fail-closed дисциплина host-старта распространяется на переармирование:
      // бросок шва снимает host-effect и терминализирует юнит; wake-вызыватель
      // хоста исключение не видит. Синхронный ре-wake из hostile setTimer
      // (callback-then-throw) гасится транзакционным замком — цепь плеч
      // не рекурсирует (ровно два обращения к шву).
      expect(() => firstWake()).not.toThrow();
      expect(timerCalls).toBe(2);
      expect(target.cancels).toBe(1);
      expect(onComplete).not.toHaveBeenCalled();

      await Promise.resolve();
      await Promise.resolve();
      // Прерывание — не натуральный финал: aggregate резолвится без onComplete.
      expect(settled).toBe(true);
      expect(onComplete).not.toHaveBeenCalled();
    },
  );
});
