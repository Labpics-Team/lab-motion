import { describe, expect, it, vi } from 'vitest';
import { MotionValue } from '../src/index.js';

const SPRING = { mass: 1, stiffness: 200, damping: 20 };

function makeClock(syncSuccessor = false) {
  const queue: Array<(timestamp?: number) => void> = [];
  const delivered = new Set<number>();
  let requests = 0;
  return {
    requestFrame(callback: (timestamp?: number) => void): number {
      const handle = ++requests;
      const once = (timestamp?: number): void => {
        expect(delivered.has(handle)).toBe(false);
        delivered.add(handle);
        callback(timestamp);
      };
      if (syncSuccessor && handle === 2) once();
      else queue.push(once);
      return handle;
    },
    next(): void {
      expect(queue.length).toBeGreaterThan(0);
      queue.shift()!();
    },
    drain(): void {
      let frames = 0;
      while (queue.length > 0) {
        expect(++frames).toBeLessThan(1000);
        this.next();
      }
    },
    pending: () => queue.length,
    requests: () => requests,
  };
}

describe('MotionValue: guard принадлежит текущему запуску', () => {
  it.each([[false, 0], [true, 0], [false, 5e-11], [true, 5e-11]] as const)(
    'возврат к достигнутой цели отзывает ожидающий кадр (clamp=%s, v0=%s)', (clamp, initialVelocity) => {
    const clock = makeClock();
    const value = new MotionValue({
      initial: 0, initialVelocity, spring: SPRING,
      clamp, requestFrame: clock.requestFrame,
    });
    const emissions: number[] = [];
    value.onChange(current => emissions.push(current));
    value.setTarget(100);
    value.setTarget(0);

    expect([value.value, value.velocity]).toEqual([0, 0]);
    expect(emissions).toEqual([0]);
    clock.next();
    expect([value.value, value.velocity]).toEqual([0, 0]);
    expect(emissions).toEqual([0]);
    expect(clock.pending()).toBe(0);

    value.setTarget(100);
    clock.next();
    expect(value.value).toBeGreaterThan(0);
    clock.drain();
    expect([value.value, value.velocity]).toEqual([100, 0]);
    value.destroy();
  });

  it.each([100, -50])('цель %s из getter сохраняет только согласованный кадр и живой цикл', (target) => {
    const clock = makeClock();
    let armed = false;
    const value: MotionValue = new MotionValue({
      initial: 0, clamp: false, requestFrame: clock.requestFrame,
      spring: {
        get mass() {
          if (armed) { armed = false; value.setTarget(target); }
          return 1;
        },
        stiffness: 200, damping: 20,
      },
    });
    const emissions: number[] = [];
    value.onChange(current => emissions.push(current));
    value.setTarget(100);
    clock.next();
    const before = [value.value, value.velocity];
    const emitted = emissions.length;
    armed = true;
    clock.next();

    if (target === 100) {
      // Повтор цели не меняет траекторию и не должен съедать здоровый кадр.
      expect(value.value).toBeGreaterThan(before[0]!);
      expect(emissions).toHaveLength(emitted + 1);
    } else {
      expect([value.value, value.velocity]).toEqual(before);
      expect(emissions).toHaveLength(emitted);
    }
    expect(clock.pending()).toBe(1);
    clock.drain();
    expect([value.value, value.velocity]).toEqual([target, 0]);
    expect(clock.pending()).toBe(0);
    value.destroy();
  });

  it.each(['getter', 'listener'] as const)(
    'сохраняет one-shot кадр преемника из %s после возврата requestFrame',
    (site) => {
      vi.useFakeTimers();
      const clock = makeClock();
      let value: MotionValue | undefined;
      let control: MotionValue | undefined;
      let armed = false;
      let origin: [number, number] | undefined;
      const handoff = (): void => {
        if (!armed) return;
        armed = false;
        origin = [value!.value, value!.velocity];
        value!.stop();
        value!.setTarget(2);
        // requestFrame уже вернулся; callback всё ещё вызывается на стеке старого tick.
        clock.next();
      };
      const params = {
        get mass() { if (site === 'getter') handoff(); return 1; },
        stiffness: 200,
        damping: 20,
      };
      try {
        value = new MotionValue({ initial: 0, spring: params, requestFrame: clock.requestFrame });
        value.onChange(() => { if (site === 'listener') handoff(); });
        value.setTarget(1);
        armed = true;
        clock.next();

        expect(origin).toBeDefined();
        expect(clock.pending()).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        const requests = clock.requests();
        value.setTarget(2);
        expect(clock.requests()).toBe(requests);

        // Отдельный запуск из того же snapshot проверяет sample после shared-scratch reentry.
        const referenceClock = makeClock();
        control = new MotionValue({
          initial: origin![0], initialVelocity: origin![1], spring: SPRING,
          requestFrame: referenceClock.requestFrame,
        });
        control.setTarget(2);
        referenceClock.next();
        expect([value.value, value.velocity]).toEqual([control.value, control.velocity]);
        control.destroy();
        referenceClock.drain();

        clock.drain();
        expect(value.value).toBe(2);
        expect(value.velocity).toBe(0);
        expect(clock.pending()).toBe(0);
      } finally {
        control?.destroy();
        value?.destroy();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(['getter', 'listener'] as const)(
    'сохраняет trampoline, если преемник из %s вызван внутри requestFrame',
    (site) => {
      vi.useFakeTimers();
      const clock = makeClock(true);
      let value: MotionValue | undefined;
      let armed = false;
      const handoff = (): void => {
        if (!armed) return;
        armed = false;
        value!.stop();
        value!.setTarget(2);
      };
      try {
        value = new MotionValue({
          initial: 0,
          spring: {
            get mass() { if (site === 'getter') handoff(); return 1; },
            stiffness: 200, damping: 20,
          },
          requestFrame: clock.requestFrame,
        });
        value.onChange(() => { if (site === 'listener') handoff(); });
        value.setTarget(1);
        armed = true;
        clock.next();
        expect(clock.pending()).toBe(0);
        expect(vi.getTimerCount()).toBe(1);
        vi.runAllTimers();
        expect(value.value).toBe(2);
        expect(clock.requests()).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        value?.destroy();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('final emit начинает преемника через тот же fresh-start owner', () => {
    const clock = makeClock();
    const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
    let restarted = false;
    let firstSuccessorValue = 0;
    value.onChange(current => {
      if (restarted || current !== 1 || value.velocity !== 0) return;
      restarted = true;
      value.setTarget(2);
      clock.next();
      firstSuccessorValue = value.value;
      expect(clock.pending()).toBe(1);
    });
    value.setTarget(1);
    clock.drain();
    expect(restarted).toBe(true);
    expect(firstSuccessorValue).toBeGreaterThan(1);
    expect(value.value).toBe(2);
    value.destroy();
  });

  it('тот же активный run сохраняет защиту от вложенной доставки callback', () => {
    const queue: Array<() => void> = [];
    let executing: (() => void) | undefined;
    let armed = false;
    const value = new MotionValue({
      initial: 0,
      spring: {
        get mass() {
          if (armed) { armed = false; executing!(); }
          return 1;
        },
        stiffness: 200, damping: 20,
      },
      requestFrame(callback) { queue.push(callback); return 1; },
    });
    let emissions = 0;
    value.onChange(() => emissions++);
    value.setTarget(1);
    executing = queue.shift()!;
    armed = true;
    // Защитный сосед: этот host намеренно повторяет тот же callback внутри getter.
    executing();
    expect(emissions).toBe(2);
    expect(queue).toHaveLength(1);
    value.destroy();
    queue.shift()!();
    expect(queue).toHaveLength(0);
  });
});
