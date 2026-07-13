/** Транзакционная смена владельца в лёгком animate/mini. */

import { describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/mini/index.js';
import { MotionParamError } from '../src/errors.js';
import type { FrameLoop } from '../src/frame/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

async function expectPending(promise: Promise<void>): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe('animate/mini — transactional replacement', () => {
  it('ошибка requestFrame successor оставляет старый tween живым', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(f.el, { x: 100 }, {
      duration: 1_000,
      requestFrame: clock.requestFrame,
    });
    clock.step(16);
    clock.step(16);
    const before = f.writes.length;

    expect(() => animate(f.el, { x: 200 }, {
      duration: 1_000,
      requestFrame: () => {
        // Враждебный successor дренит уже поставленный кадр старого owner.
        // Пока record зарезервирован, этот кадр обязан остаться без записи.
        clock.step(16);
        throw new Error('scheduler failed');
      },
    })).toThrow('scheduler failed');

    expect(f.writes).toHaveLength(before);
    await expectPending(first.finished);
    clock.step(16);
    expect(f.writes.length).toBeGreaterThan(before);
    clock.drain(16);
    await first.finished;
  });

  it('scheduler reentry получает LM157 до nested-подписки', () => {
    const f = fakeEl();
    const oldClock = makeClock();
    const first = animate(f.el, { x: 100 }, {
      duration: 1_000,
      requestFrame: oldClock.requestFrame,
    });
    let nestedSubscriptions = 0;
    let code: string | undefined;

    const next = animate(f.el, { x: 200 }, {
      duration: 1_000,
      requestFrame: () => {
        try {
          animate(f.el, { x: 999 }, {
            duration: 1_000,
            requestFrame: () => { nestedSubscriptions++; return 1; },
          });
        } catch (error) {
          code = (error as MotionParamError).code;
        }
        return 1;
      },
    });

    expect(code).toBe('LM157');
    expect(nestedSubscriptions).toBe(0);
    next.cancel();
    void first.finished;
  });

  it('непойманный scheduler reentry откатывает outer successor', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(f.el, { x: 100 }, {
      duration: 1_000,
      requestFrame: clock.requestFrame,
    });
    clock.step(16);
    const before = f.writes.length;

    let error: unknown;
    try {
      animate(f.el, { x: 200 }, {
        duration: 1_000,
        requestFrame: () => {
          animate(f.el, { x: 999 }, {
            duration: 1_000,
            requestFrame: () => 1,
          });
          return 1;
        },
      });
    } catch (cause) {
      error = cause;
    }

    expect((error as MotionParamError).code).toBe('LM157');
    await expectPending(first.finished);
    clock.step(16);
    expect(f.writes.length).toBeGreaterThan(before);
    first.cancel();
  });

  it('ошибка render-подписки откатывает successor и выпускает старого владельца', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(f.el, { x: 100 }, {
      duration: 1_000,
      requestFrame: clock.requestFrame,
    });
    clock.step(16);
    const before = f.writes.length;
    let updateOffs = 0;
    const frame: FrameLoop = {
      read: () => () => {},
      update: () => () => { updateOffs++; },
      render: () => { throw new Error('render subscription failed'); },
      cancelAll: () => {},
    };

    expect(() => animate(f.el, { x: 200 }, { duration: 1_000, frame }))
      .toThrow('render subscription failed');
    expect(updateOffs).toBe(1);

    await expectPending(first.finished);
    clock.step(16);
    expect(f.writes.length).toBeGreaterThan(before);
    first.cancel();
  });

  it('ошибка reduced-writer не теряет старого владельца и не завершает его Promise', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(f.el, { x: 100 }, {
      duration: 1_000,
      requestFrame: clock.requestFrame,
    });
    clock.step(16);
    const originalWrite = f.el.style.setProperty;
    f.el.style.setProperty = () => { throw new Error('snap failed'); };

    expect(() => animate(f.el, { x: 200 }, {
      duration: 1_000,
      matchMedia: () => ({ matches: true }),
    })).toThrow('snap failed');

    f.el.style.setProperty = originalWrite;
    await expectPending(first.finished);
    const before = f.writes.length;
    clock.step(16);
    expect(f.writes.length).toBeGreaterThan(before);
    first.cancel();
  });

  it('ошибка второго дубликата сохраняет локального owner первого', () => {
    const f = fakeEl();
    const offEvents: string[] = [];
    let updates = 0;
    let renders = 0;
    const frame: FrameLoop = {
      read: () => () => {},
      update: () => {
        const id = ++updates;
        return () => { offEvents.push(`u${id}`); };
      },
      render: () => {
        const id = ++renders;
        if (id === 2) throw new Error('second duplicate failed');
        return () => { offEvents.push(`r${id}`); };
      },
      cancelAll: () => {},
    };

    expect(() => animate([f.el, f.el], { x: 100 }, { duration: 1_000, frame }))
      .toThrow('second duplicate failed');
    expect(offEvents).toEqual(['u2']);

    const next = animate(f.el, { x: 200 }, {
      duration: 1_000,
      requestFrame: () => 1,
    });
    expect(offEvents).toEqual(['u2', 'u1', 'r1']);
    next.cancel();
  });

  it('reduced onComplete может ретаргетить одну цель, не ломая sibling', () => {
    const a = fakeEl();
    const b = fakeEl();
    const complete = vi.fn(() => {
      animate(a.el, { x: 300 }, {
        duration: 100,
        matchMedia: () => ({ matches: true }),
      });
    });

    animate([a.el, b.el], { x: 100 }, {
      duration: 100,
      matchMedia: () => ({ matches: true }),
      onComplete: complete,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(a.writes.at(-1)?.value).toBe('translateX(300px)');
    expect(b.writes.at(-1)?.value).toBe('translateX(100px)');
  });

  it('derived stagger overflow падает LM139 до подписок и записей', () => {
    const targets = [fakeEl(), fakeEl(), fakeEl()];
    let subscriptions = 0;
    const onComplete = vi.fn();
    const frame: FrameLoop = {
      read: () => { subscriptions++; return () => {}; },
      update: () => { subscriptions++; return () => {}; },
      render: () => { subscriptions++; return () => {}; },
      cancelAll: () => {},
    };

    let error: unknown;
    try {
      animate(targets.map((target) => target.el), { x: 100 }, {
        duration: 100,
        stagger: Number.MAX_VALUE,
        frame,
        onComplete,
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe('LM139');
    expect(subscriptions).toBe(0);
    expect(targets.flatMap((target) => target.writes)).toEqual([]);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
