import { describe, expect, it, vi } from 'vitest';
import { MotionValue, type MotionValueOptions } from '../src/index.js';

const SPRING: MotionValueOptions['spring'] = {
  mass: 1,
  stiffness: 200,
  damping: 20,
};

function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  let time = 0;
  const requestFrame = (callback: (ts?: number) => void): number => {
    queue.push(callback);
    return ++handle;
  };
  const drain = (count = 1): void => {
    for (let index = 0; index < count && queue.length > 0; index++) {
      time += 1000 / 60;
      queue.shift()!(time);
    }
  };
  const drainAll = (limit = 3000): void => {
    let frames = 0;
    while (queue.length > 0 && frames++ < limit) drain();
  };
  return { requestFrame, drain, drainAll, pending: () => queue.length };
}

describe('MotionValue: изоляция ошибок слушателей', () => {
  it('откатывает регистрацию, если немедленный onChange-вызов бросил', () => {
    const clock = makeClock();
    const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
    const failure = new Error('initial listener failure');
    const listener = vi.fn(() => { throw failure; });

    expect(() => value.onChange(listener)).toThrow(failure);
    value.setTarget(10);
    expect(() => clock.drainAll()).not.toThrow();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(value.value).toBeCloseTo(10, 5);
  });

  it('не удаляет старую подписку при неуспешной повторной регистрации того же callback', () => {
    const clock = makeClock();
    const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
    const failure = new Error('duplicate registration failure');
    let failNext = false;
    const listener = vi.fn(() => {
      if (!failNext) return;
      failNext = false;
      throw failure;
    });
    const unsubscribe = value.onChange(listener);
    failNext = true;

    expect(() => value.onChange(listener)).toThrow(failure);
    value.setTarget(10);
    expect(() => clock.drainAll()).not.toThrow();
    expect(listener.mock.calls.length).toBeGreaterThan(2);

    unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    value.setTarget(20);
    clock.drainAll();
    expect(listener).toHaveBeenCalledTimes(callsAfterUnsubscribe);
  });

  it('удаляет упавших на кадре слушателей, доставляет кадр остальным и продолжает ран', () => {
    const clock = makeClock();
    const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
    const firstFailure = new Error('first listener failure');
    const secondFailure = new Error('second listener failure');
    let armed = false;
    const first = vi.fn(() => { if (armed) throw firstFailure; });
    const second = vi.fn(() => { if (armed) throw secondFailure; });
    const healthy = vi.fn();
    value.onChange(first);
    value.onChange(second);
    value.onChange(healthy);
    armed = true;

    value.setTarget(100);
    expect(() => clock.drain()).toThrow(firstFailure);

    // Оба дефектных callback удалены, здоровый получил тот же кадр, а живой ран
    // уже перепланирован до выхода первой ошибки наружу.
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(clock.pending()).toBe(1);

    expect(() => clock.drain()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(3);
    expect(() => clock.drainAll()).not.toThrow();
    expect(value.value).toBeCloseTo(100, 5);

    value.setTarget(25);
    expect(() => clock.drainAll()).not.toThrow();
    expect(value.value).toBeCloseTo(25, 5);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('сохраняет listener-ошибку первичной, если перепланирование тоже бросило', () => {
    const queue: Array<(ts?: number) => void> = [];
    const listenerFailure = { source: 'listener' };
    const schedulerFailure = { source: 'scheduler' };
    let requests = 0;
    let time = 0;
    const requestFrame = (callback: (ts?: number) => void): number => {
      requests++;
      if (requests === 2) throw schedulerFailure;
      queue.push(callback);
      return requests;
    };
    const drain = (): void => {
      const callback = queue.shift();
      if (callback) callback(time += 1000 / 60);
    };
    const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame });
    let armed = false;
    value.onChange(() => { if (armed) throw listenerFailure; });
    armed = true;
    value.setTarget(100);

    let thrown: unknown;
    try { drain(); } catch (error) { thrown = error; }
    expect(thrown).toBe(listenerFailure);
    expect(queue).toHaveLength(0);

    // Неудачная выдача кадра делает поколение retryable; следующий target
    // обязан реально обратиться к host и продолжить движение.
    value.setTarget(25);
    while (queue.length > 0) drain();
    expect(requests).toBeGreaterThan(2);
    expect(value.value).toBeCloseTo(25, 5);
  });

  it('выбрасывает scheduler-ошибку, если более ранней listener-ошибки нет', () => {
    const queue: Array<(ts?: number) => void> = [];
    const schedulerFailure = { source: 'scheduler' };
    let requests = 0;
    let time = 0;
    const requestFrame = (callback: (ts?: number) => void): number => {
      requests++;
      if (requests === 2) throw schedulerFailure;
      queue.push(callback);
      return requests;
    };
    const drain = (): void => {
      const callback = queue.shift();
      if (callback) callback(time += 1000 / 60);
    };
    const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame });
    value.setTarget(100);

    let thrown: unknown;
    try { drain(); } catch (error) { thrown = error; }
    expect(thrown).toBe(schedulerFailure);

    value.setTarget(25);
    while (queue.length > 0) drain();
    expect(requests).toBeGreaterThan(2);
    expect(value.value).toBeCloseTo(25, 5);
  });

  it('синхронный scheduler проходит через один trampoline без рекурсии и сохраняет listener-ошибку', () => {
    vi.useFakeTimers();
    try {
      let depth = 0;
      let maxDepth = 0;
      let requests = 0;
      const requestFrame = (callback: (ts?: number) => void): number => {
        requests++;
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        try { callback(requests * 16); } finally { depth--; }
        return 1;
      };
      const listenerFailure = { source: 'sync-listener' };
      const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame });
      let armed = false;
      value.onChange(() => { if (armed) throw listenerFailure; });
      armed = true;
      value.setTarget(100);

      let thrown: unknown;
      try { vi.runOnlyPendingTimers(); } catch (error) { thrown = error; }
      expect(thrown).toBe(listenerFailure);
      expect(requests).toBe(1);
      expect(maxDepth).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      vi.runAllTimers();
      expect(value.value).toBeCloseTo(100, 5);
      expect(requests).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('реентрантный stop гасит trampoline синхронного scheduler', () => {
    vi.useFakeTimers();
    try {
      let depth = 0;
      let maxDepth = 0;
      let requests = 0;
      const requestFrame = (callback: (ts?: number) => void): number => {
        requests++;
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        try { callback(requests * 16); } finally { depth--; }
        return 1;
      };
      const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame });
      let armed = false;
      value.onChange(() => {
        if (!armed) return;
        armed = false;
        value.stop();
      });
      armed = true;
      value.setTarget(100);
      vi.runOnlyPendingTimers();

      expect(requests).toBe(1);
      expect(maxDepth).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handle=0 подавляет поздний host-callback после единственного fallback-тика', () => {
    vi.useFakeTimers();
    try {
      let retained: ((ts?: number) => void) | undefined;
      const requestFrame = (callback: (ts?: number) => void): number => {
        retained = callback;
        return 0;
      };
      const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame });
      let emissions = 0;
      value.onChange(() => { emissions++; });
      value.setTarget(100);
      vi.runOnlyPendingTimers();
      const beforeLateHost = emissions;
      const timersBeforeLateHost = vi.getTimerCount();

      retained?.(16);
      expect(emissions).toBe(beforeLateHost);
      expect(vi.getTimerCount()).toBe(timersBeforeLateHost);

      vi.runAllTimers();
      expect(value.value).toBeCloseTo(100, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['stop', 'snap', 'destroy'] as const)(
    'сохраняет реентрантный %s из onChange без лишнего кадра',
    (operation) => {
      const clock = makeClock();
      const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
      let armed = false;
      value.onChange(() => {
        if (!armed) return;
        armed = false;
        if (operation === 'stop') value.stop();
        else if (operation === 'snap') value.snapTo(42);
        else value.destroy();
      });
      armed = true;

      value.setTarget(100);
      expect(() => clock.drain()).not.toThrow();
      expect(clock.pending()).toBe(0);
      if (operation === 'snap') expect(value.value).toBe(42);
    },
  );
});
