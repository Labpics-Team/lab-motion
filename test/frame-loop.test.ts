/**
 * test/frame-loop.test.ts — единый frame-шедулер (subpath ./frame, S21).
 * Классы: А (фазовый порядок, жизненный цикл подписок) + В (мутации во время
 * тика, handle=0 fallback, детерминизм) + Д (mutation-хуки в шапке).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый поведенческий блок своим ассертом.
 * Mutation-proof: перепутать порядок фаз → «read→update→render в одном кадре»
 * RED; потерять once-семантику → «once вызывается ровно один раз» RED;
 * терять подписку из тика → «add во время тика исполняется со следующего
 * кадра» RED; сломать останов пустого цикла → «пустой цикл не планирует» RED.
 *
 * Зачем субпуть (D11): сейчас каждый MotionValue/drive планирует СВОЙ rAF —
 * N значений = N колбэков на кадр. Единый тикер = один rAF, батч всех
 * значений, фазы против layout-thrash (канон Motion frame / gsap.ticker).
 * Миграция ядра на шедулер — отдельный differential-этап после мержа.
 */

import { describe, expect, it, vi } from 'vitest';
import * as frameModule from '../src/frame/index.js';
import { createFrameLoop } from '../src/frame/index.js';

function makeVirtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handle = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    /** Продвинуть РОВНО один кадр (все колбэки, запланированные к нему). */
    step(dtMs = 1000 / 60): number {
      clock += dtMs;
      const batch = queue.splice(0, queue.length);
      for (const cb of batch) cb(clock);
      return batch.length;
    },
    get pending(): number {
      return queue.length;
    },
  };
}

describe('frame: фазовый порядок', () => {
  it('read → update → render строго в одном кадре, независимо от порядка подписки', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.render(() => calls.push('render'));
    loop.read(() => calls.push('read'));
    loop.update(() => calls.push('update'));
    vc.step();
    expect(calls).toEqual(['read', 'update', 'render']);
  });

  it('несколько подписчиков одной фазы исполняются в порядке подписки', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: number[] = [];
    loop.update(() => calls.push(1));
    loop.update(() => calls.push(2));
    loop.update(() => calls.push(3));
    vc.step();
    expect(calls).toEqual([1, 2, 3]);
  });
});

describe('frame: жизненный цикл подписки', () => {
  it('подписка повторяется каждый кадр до отписки; отписка идемпотентна', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    const off = loop.update(() => {
      n++;
    });
    vc.step();
    vc.step();
    vc.step();
    expect(n).toBe(3);
    off();
    off(); // повторная отписка — no-op
    vc.step();
    expect(n).toBe(3);
  });

  it('once: вызывается ровно один раз и самоотписывается', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    loop.update(
      () => {
        n++;
      },
      { once: true },
    );
    vc.step();
    vc.step();
    expect(n).toBe(1);
  });

  it('колбэк получает timestamp кадра (или undefined — фикс-шаг у потребителя)', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const seen: Array<number | undefined> = [];
    loop.update((ts) => {
      seen.push(ts);
    });
    vc.step();
    vc.step();
    expect(seen).toHaveLength(2);
    expect(seen[1]! - (seen[0] as number)).toBeCloseTo(1000 / 60, 6);
  });
});

describe('frame: ОДИН rAF на кадр — суть шедулера', () => {
  it('нативный requestAnimationFrame сохраняет global receiver', () => {
    let receiver: unknown;
    let hijacked = 0;
    const requestAnimationFrame = function (
      this: unknown,
      _cb: (ts?: number) => void,
    ): number {
      receiver = this;
      return 1;
    };
    Object.defineProperty(requestAnimationFrame, 'call', {
      value: (): number => ++hijacked,
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    try {
      const loop = createFrameLoop();
      const off = loop.update(() => {});
      expect(receiver).toBe(globalThis);
      expect(hijacked).toBe(0);
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('инжектированный requestFrame остаётся receiver-free', () => {
    let receiver: unknown = globalThis;
    let invoked = 0;
    let hijacked = 0;
    const requestFrame = function (this: unknown): number {
      receiver = this;
      invoked++;
      return 1;
    };
    Object.defineProperty(requestFrame, 'call', {
      value: (): number => ++hijacked,
    });
    const loop = createFrameLoop({
      requestFrame,
    });
    const off = loop.update(() => {});
    expect(receiver).toBeUndefined();
    expect(invoked).toBe(1);
    expect(hijacked).toBe(0);
    off();
  });

  it('N подписчиков — ровно один запланированный колбэк на кадр', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    loop.read(() => {});
    loop.update(() => {});
    loop.update(() => {});
    loop.render(() => {});
    expect(vc.pending).toBe(1); // не 4
    const fired = vc.step();
    expect(fired).toBe(1);
    expect(vc.pending).toBe(1); // перепланирован снова один
  });

  it('пустой цикл не планирует кадры; после отписки последнего — останавливается', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    expect(vc.pending).toBe(0); // ленивый старт
    const off = loop.update(() => {});
    expect(vc.pending).toBe(1);
    off();
    vc.step(); // кадр без подписчиков
    expect(vc.pending).toBe(0); // не перепланировался
  });
});

describe('frame: мутации во время тика (класс гонок)', () => {
  it('add во время тика: новый подписчик исполняется со СЛЕДУЮЩЕГО кадра', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.update(() => {
      calls.push('a');
      if (calls.filter((c) => c === 'a').length === 1) {
        loop.update(() => calls.push('b'));
      }
    });
    vc.step();
    expect(calls).toEqual(['a']); // b не в этом кадре
    vc.step();
    expect(calls).toEqual(['a', 'a', 'b']);
  });

  it('remove самого себя и соседа во время тика — без пропусков и дублей', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    let offB: () => void = () => {};
    loop.update(() => {
      calls.push('a');
      offB(); // сосед удаляется прямо в тике
    });
    offB = loop.update(() => calls.push('b'));
    loop.update(() => calls.push('c'));
    vc.step();
    // 'b' удалён в момент исполнения 'a' — в этом кадре не вызывается
    expect(calls).toEqual(['a', 'c']);
    vc.step();
    expect(calls).toEqual(['a', 'c', 'a', 'c']);
  });

  it('исключение одного подписчика не срывает остальных и не убивает цикл', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.update(() => {
      throw new Error('плохой подписчик');
    });
    loop.update(() => calls.push('ok'));
    expect(() => vc.step()).not.toThrow();
    expect(calls).toEqual(['ok']);
    vc.step();
    expect(calls).toEqual(['ok', 'ok']);
  });
});

describe('frame: fallback handle=0 (non-draining клок)', () => {
  it('handle=0 → setTimeout-фоллбек продолжает кадры (луп не дедлочится)', async () => {
    let calls = 0;
    const loop = createFrameLoop({ requestFrame: () => 0 });
    loop.update(() => {
      calls++;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeGreaterThan(0);
    loop.cancelAll();
  });
});

describe('frame: гонка позднего дрейна (класс Finding 3 — двойной цикл)', () => {
  it('handle=0 клок, дренированный ПОЗЖЕ, гасится identity — двойного тика нет', async () => {
    const captured: Array<(ts?: number) => void> = [];
    const loop = createFrameLoop({
      requestFrame: (cb) => {
        captured.push(cb); // клок сохраняет колбэк, но сообщает 0 (non-draining)
        return 0;
      },
    });
    let n = 0;
    loop.update(() => {
      n++;
    });
    await new Promise((r) => setTimeout(r, 40)); // fallback-путь накрутил кадры
    const before = n;
    expect(before).toBeGreaterThan(0);
    for (const cb of captured) cb(999); // поздний дрейн «мёртвого» пути
    expect(n).toBe(before); // callback-владелец погасил stale-доставку
    loop.cancelAll();
  });
});

describe('frame: lifecycle-классы (ноты QA-ревью)', () => {
  it('бросок requestFrame откатывает подписку и не отравляет следующий старт', () => {
    const queue: Array<(ts?: number) => void> = [];
    let first = true;
    const loop = createFrameLoop({
      requestFrame: (cb) => {
        if (first) {
          first = false;
          throw new Error('host scheduler failed');
        }
        queue.push(cb);
        return 1;
      },
    });
    let calls = 0;
    expect(() => loop.update(() => calls++)).toThrow('host scheduler failed');
    expect(() => loop.update(() => calls++, { once: true })).not.toThrow();
    queue.shift()?.(0);
    expect(calls).toBe(1);
  });

  it('контракт-пин: клок-нарушитель, зовущий колбэк дважды, не ломает состояние', () => {
    vi.useFakeTimers();
    try {
      // Оба вызова схлопываются в один tracked trampoline: ни один host не
      // вправе вклинить frame-фазы внутрь транзакции подписки.
      let n = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          cb(1);
          cb(1); // нарушение контракта клока
          return 1;
        },
      });
      expect(() => loop.update(() => n++, { once: true })).not.toThrow();
      expect({ n, timers: vi.getTimerCount() }).toEqual({ n: 0, timers: 1 });
      vi.runOnlyPendingTimers();
      expect({ n, timers: vi.getTimerCount() }).toEqual({ n: 1, timers: 0 });
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('синхронный клок не рекурсирует и переходит на асинхронные кадры', () => {
    vi.useFakeTimers();
    try {
      let hostCalls = 0;
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          cb(hostCalls);
          cb(hostCalls); // повтор того же кадра среды уже устарел
          expect(ticks).toBe(0);
          return 1;
        },
      });

      const off = loop.update(() => ticks++);
      expect({ hostCalls, ticks, timers: vi.getTimerCount() }).toEqual({
        hostCalls: 1, ticks: 0, timers: 1,
      });
      vi.advanceTimersToNextTimer();
      expect({ hostCalls, ticks, timers: vi.getTimerCount() }).toEqual({
        hostCalls: 1, ticks: 1, timers: 1,
      });
      vi.advanceTimersToNextTimer();
      expect(ticks).toBe(2);
      off();
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('синхронный host при resubscribe не вклинивает nested tick в текущую фазу', () => {
    vi.useFakeTimers();
    try {
      const queue: Array<(ts?: number) => void> = [];
      const events: string[] = [];
      let hostCalls = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          if (hostCalls === 1) queue.push(cb);
          else cb(hostCalls);
          return hostCalls;
        },
      });

      loop.read(() => {
        events.push('read:start');
        loop.read(() => events.push('late-read'), { once: true });
        events.push('read:end');
      }, { once: true });
      loop.read(() => events.push('read:sibling'), { once: true });
      loop.update(() => events.push('update'), { once: true });
      loop.render(() => events.push('render'), { once: true });

      expect(() => queue.shift()?.(1)).not.toThrow();
      expect(events).toEqual(['read:start', 'read:end', 'read:sibling', 'update', 'render']);
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(events).toEqual([
        'read:start', 'read:end', 'read:sibling', 'update', 'render', 'late-read',
      ]);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('синхронный callback с handle=0 не оставляет второй stale-таймер', () => {
    vi.useFakeTimers();
    try {
      let hostCalls = 0;
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          cb(hostCalls);
          return 0;
        },
      });

      loop.update(() => ticks++);

      expect(hostCalls).toBe(1);
      expect(ticks).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(ticks).toBe(1);
      // Повторяющемуся циклу нужен ровно один следующий fallback-кадр.
      expect(vi.getTimerCount()).toBe(1);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('однократный синхронный callback с handle=0 не ставит уже ненужный таймер', () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          cb(1);
          return 0;
        },
      });

      loop.update(() => ticks++, { once: true });

      expect(ticks).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(ticks).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('бросок host после синхронного fire транзакционно откатывает callback', () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          cb(1);
          throw new Error('host threw after delivery');
        },
      });

      expect(() => {
        loop.update(() => ticks++);
      }).toThrow('host threw after delivery');
      expect(ticks).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('реентрантная подписка не теряется при откате внешней host-заявки', () => {
    vi.useFakeTimers();
    try {
      let outer = 0;
      let inner = 0;
      let loop!: ReturnType<typeof createFrameLoop>;
      loop = createFrameLoop({
        requestFrame: (cb) => {
          loop.update(() => inner++, { once: true });
          cb(1);
          throw new Error('outer reservation failed');
        },
      });

      expect(() => loop.update(() => outer++)).toThrow('outer reservation failed');
      expect({ outer, inner }).toEqual({ outer: 0, inner: 0 });
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect({ outer, inner }).toEqual({ outer: 0, inner: 1 });
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rollback реентрантной подписки не меняет зафиксированный список текущего кадра', () => {
    vi.useFakeTimers();
    try {
      const queue: Array<(ts?: number) => void> = [];
      let hostCalls = 0;
      const calls: string[] = [];
      let innerThrew = false;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          if (hostCalls === 2) throw new Error('next reservation failed');
          queue.push(cb);
          return hostCalls;
        },
      });

      loop.update(() => {
        calls.push('a');
        try {
          loop.update(() => calls.push('c'), { once: true });
        } catch {
          innerThrew = true;
        }
      }, { once: true });
      loop.update(() => calls.push('b'), { once: true });

      expect(() => queue.shift()?.(1)).not.toThrow();
      expect({ hostCalls, innerThrew, calls, timers: vi.getTimerCount() }).toEqual({
        hostCalls: 2,
        innerThrew: false,
        calls: ['a', 'b'],
        timers: 1,
      });
      vi.runOnlyPendingTimers();
      expect(calls).toEqual(['a', 'b', 'c']);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('бросок async reschedule демотирует host и не вырывается из кадра', () => {
    vi.useFakeTimers();
    try {
      const queue: Array<(ts?: number) => void> = [];
      let hostCalls = 0;
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          if (hostCalls === 2) throw new Error('async reschedule failed');
          queue.push(cb);
          return hostCalls;
        },
      });

      const off = loop.update(() => ticks++);
      expect(() => queue.shift()?.(1)).not.toThrow();
      expect({ hostCalls, ticks, timers: vi.getTimerCount() }).toEqual({
        hostCalls: 2,
        ticks: 1,
        timers: 1,
      });
      vi.runOnlyPendingTimers();
      expect(ticks).toBe(2);
      off();
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('off вне tick освобождает pending custom-host entry и разрешает новый старт', () => {
    const queue: Array<(ts?: number) => void> = [];
    let hostCalls = 0;
    let ticks = 0;
    const loop = createFrameLoop({
      requestFrame: (cb) => {
        hostCalls++;
        queue.push(cb);
        return hostCalls;
      },
    });

    const off = loop.update(() => ticks++);
    off();
    loop.update(() => ticks++, { once: true });
    expect(hostCalls).toBe(2);
    queue[0]?.(1);
    expect(ticks).toBe(0);
    queue[1]?.(2);
    expect(ticks).toBe(1);
    loop.cancelAll();
  });

  it('off реентрантного handle=0 не сдвигает текущий кадр и снимает пустой fallback', () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const loop = createFrameLoop({ requestFrame: () => 0 });
      loop.update(() => {
        calls.push('a');
        const off = loop.update(() => calls.push('c'), { once: true });
        off();
      }, { once: true });
      loop.update(() => calls.push('b'), { once: true });

      expect(() => vi.runOnlyPendingTimers()).not.toThrow();
      expect(calls).toEqual(['a', 'b']);
      expect(vi.getTimerCount()).toBe(0);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('пустой terminal делает уже выданный custom-frame stale и не блокирует новый reserve', () => {
    const queue: Array<(ts?: number) => void> = [];
    const calls: string[] = [];
    let hostCalls = 0;
    const loop = createFrameLoop({
      requestFrame: (cb) => {
        hostCalls++;
        queue.push(cb);
        return hostCalls;
      },
    });
    loop.update(() => {
      calls.push('a');
      const off = loop.update(() => calls.push('ghost'), { once: true });
      off();
    }, { once: true });

    queue.shift()?.(1);
    loop.update(() => calls.push('fresh'), { once: true });
    expect(hostCalls).toBe(2);
    expect(calls).toEqual(['a']);
    queue.shift()?.(2);
    expect(calls).toEqual(['a', 'fresh']);
    loop.cancelAll();
  });

  it('cancelAll внутри host-заявки гасит и stale-таймер, и его демоцию', () => {
    vi.useFakeTimers();
    try {
      let hostCalls = 0;
      let first = true;
      let loop!: ReturnType<typeof createFrameLoop>;
      loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          if (first) {
            first = false;
            loop.cancelAll();
            return 0;
          }
          cb(2);
          return hostCalls;
        },
      });

      loop.update(() => {});
      expect(hostCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      let fresh = 0;
      loop.update(() => fresh++, { once: true });
      expect(hostCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
      expect(fresh).toBe(0);
      vi.runOnlyPendingTimers();
      expect(fresh).toBe(1);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelAll завершает все teardown до запуска синхронно пересозданного цикла', () => {
    vi.useFakeTimers();
    try {
      const queue: Array<(ts?: number) => void> = [];
      const events: string[] = [];
      let hostCalls = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          if (hostCalls === 1) queue.push(cb);
          else cb(hostCalls);
          return hostCalls;
        },
      });

      loop.update(() => {}, {
        onTeardown: () => {
          events.push('t1:start');
          loop.update(() => events.push('fresh'), { once: true });
          events.push('t1:end');
        },
      });
      loop.update(() => {}, { onTeardown: () => events.push('t2') });

      loop.cancelAll();
      expect({ hostCalls, events, timers: vi.getTimerCount() }).toEqual({
        hostCalls: 2,
        events: ['t1:start', 't1:end', 't2'],
        timers: 1,
      });
      vi.runOnlyPendingTimers();
      expect(events).toEqual(['t1:start', 't1:end', 't2', 'fresh']);
      queue.shift()?.(1);
      expect(events).toEqual(['t1:start', 't1:end', 't2', 'fresh']);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelAll физически снимает выданный handle=0 fallback', () => {
    vi.useFakeTimers();
    try {
      let host!: (ts?: number) => void;
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          host = cb;
          return 0;
        },
      });

      loop.update(() => ticks++);
      expect(vi.getTimerCount()).toBe(1);
      loop.cancelAll();
      expect(vi.getTimerCount()).toBe(0);
      host(1);
      expect(ticks).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('поздний host callback, выигравший у fallback, снимает его таймер', () => {
    vi.useFakeTimers();
    try {
      let host!: (ts?: number) => void;
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          host = cb;
          return 0;
        },
      });

      loop.update(() => ticks++, { once: true });
      expect(vi.getTimerCount()).toBe(1);
      host(1);
      expect(ticks).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('старый host callback не снимает fallback нового владельца', () => {
    vi.useFakeTimers();
    try {
      let stale!: (ts?: number) => void;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          stale = cb;
          return 0;
        },
      });
      loop.update(() => {});
      loop.cancelAll();

      let fresh = 0;
      loop.update(() => fresh++, { once: true });
      expect(vi.getTimerCount()).toBe(1);
      stale(1);
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(fresh).toBe(1);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('отписка последнего владельца физически снимает fallback', () => {
    vi.useFakeTimers();
    try {
      let host!: (ts?: number) => void;
      let ticks = 0;
      const loop = createFrameLoop({
        requestFrame: (cb) => {
          host = cb;
          return 0;
        },
      });
      const offA = loop.update(() => ticks++);
      const offB = loop.update(() => ticks++);
      expect(vi.getTimerCount()).toBe(1);

      offA();
      expect(vi.getTimerCount()).toBe(1);
      offB();
      expect(vi.getTimerCount()).toBe(0);
      host(1);
      expect(ticks).toBe(0);
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('старый синхронный callback после cancelAll не демотирует новый цикл', () => {
    const queued: Array<(ts?: number) => void> = [];
    let first = true;
    let hostCalls = 0;
    let loop!: ReturnType<typeof createFrameLoop>;
    loop = createFrameLoop({
      requestFrame: (cb) => {
        hostCalls++;
        if (first) {
          first = false;
          loop.cancelAll();
          cb(1);
        } else {
          queued.push(cb);
        }
        return hostCalls;
      },
    });

    let stale = 0;
    loop.update(() => stale++);
    expect(stale).toBe(0);

    let fresh = 0;
    loop.update(() => fresh++, { once: true });
    expect(hostCalls).toBe(2);
    queued.shift()!(2);
    expect(fresh).toBe(1);
    loop.cancelAll();
  });

  it('бросок stale host после cancelAll не демотирует fresh reservation', () => {
    vi.useFakeTimers();
    try {
      const queued: Array<(ts?: number) => void> = [];
      let hostCalls = 0;
      let fresh = 0;
      let loop!: ReturnType<typeof createFrameLoop>;
      loop = createFrameLoop({
        requestFrame: (cb) => {
          hostCalls++;
          if (hostCalls === 1) {
            loop.cancelAll();
            throw new Error('stale host failed');
          }
          queued.push(cb);
          return hostCalls;
        },
      });

      expect(() => loop.update(() => {}, {
        onTeardown: () => { loop.update(() => fresh++); },
      })).toThrow('stale host failed');
      expect({ hostCalls, queued: queued.length, timers: vi.getTimerCount() }).toEqual({
        hostCalls: 2, queued: 1, timers: 0,
      });

      queued.shift()!(1);
      expect(fresh).toBe(1);
      // Ресурс fire#2 уже принадлежит новому циклу: ошибка fire#1 не вправе
      // подменять его clock и уводить следующий кадр в fallback.
      expect({ hostCalls, queued: queued.length, timers: vi.getTimerCount() }).toEqual({
        hostCalls: 3, queued: 1, timers: 0,
      });
      loop.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelAll ВНУТРИ тика: соседи этого кадра не вызываются, цикл встаёт', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.update(() => {
      calls.push('a');
      loop.cancelAll();
    });
    loop.update(() => calls.push('b'));
    vc.step();
    expect(calls).toEqual(['a']);
    expect(vc.pending).toBe(0);
  });

  it('cancelAll в read-фазе гасит update/render без OOB по старым границам', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.read(() => {
      calls.push('read');
      loop.cancelAll();
    });
    loop.update(() => calls.push('update'));
    loop.render(() => calls.push('render'));

    expect(() => vc.step()).not.toThrow();
    expect(calls).toEqual(['read']);
    expect(vc.pending).toBe(0);
  });

  it('resubscribe из cancelAll-callback ждёт следующего кадра', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.read(() => {
      calls.push('old');
      loop.cancelAll();
      loop.render(() => calls.push('new'), { once: true });
    });
    loop.update(() => calls.push('stale'));

    vc.step();
    expect(calls).toEqual(['old']);
    expect(vc.pending).toBe(1);
    vc.step();
    expect(calls).toEqual(['old', 'new']);
    expect(vc.pending).toBe(0);
  });

  it('resubscribe после cancelAll: цикл возобновляется', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    loop.update(() => {});
    loop.cancelAll();
    vc.step();
    expect(vc.pending).toBe(0);
    let n = 0;
    loop.update(() => {
      n++;
    });
    vc.step();
    expect(n).toBe(1);
  });

  it('исключение в read-фазе не срывает update/render ТОГО ЖЕ кадра', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.read(() => {
      throw new Error('плохой read');
    });
    loop.update(() => calls.push('u'));
    loop.render(() => calls.push('r'));
    vc.step();
    expect(calls).toEqual(['u', 'r']);
  });

  it('once, отписанный ДО первого кадра, не вызывается', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    const off = loop.update(
      () => {
        n++;
      },
      { once: true },
    );
    off();
    vc.step();
    expect(n).toBe(0);
  });

  it('два независимых createFrameLoop не мешают друг другу', () => {
    const vcA = makeVirtualClock();
    const vcB = makeVirtualClock();
    const a = createFrameLoop({ requestFrame: vcA.requestFrame });
    const b = createFrameLoop({ requestFrame: vcB.requestFrame });
    let nA = 0;
    let nB = 0;
    a.update(() => {
      nA++;
    });
    b.update(() => {
      nB++;
    });
    vcA.step();
    vcA.step();
    expect(nA).toBe(2);
    expect(nB).toBe(0);
  });
});

describe('frame: cancelAll и синглтон', () => {
  it('cancelAll снимает все подписки всех фаз', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    loop.read(() => n++);
    loop.update(() => n++);
    loop.render(() => n++);
    loop.cancelAll();
    vc.step();
    expect(n).toBe(0);
  });

  it('детерминизм: две одинаковые последовательности дают идентичные журналы', () => {
    const run = (): string[] => {
      const vc = makeVirtualClock();
      const loop = createFrameLoop({ requestFrame: vc.requestFrame });
      const calls: string[] = [];
      loop.render(() => calls.push('r1'));
      const off = loop.update(() => calls.push('u1'));
      loop.read(() => calls.push('d1'));
      vc.step();
      off();
      loop.update(() => calls.push('u2'), { once: true });
      vc.step();
      vc.step();
      return calls;
    };
    expect(run()).toEqual(run());
  });
});

// Пин набора runtime-экспортов живёт ТОЛЬКО в frame-api-surface-pin.test.ts
// (один источник истины: два пина одного контракта = coupled-дубль).
describe('frame SSR-safety', () => {
  it('SSR: import + фабрика в node не бросают; дефолтный синглтон ленив', () => {
    expect(() => {
      const loop = createFrameLoop({ requestFrame: () => 1 });
      loop.cancelAll();
      void frameModule.frame; // сам доступ к синглтону не должен трогать rAF
    }).not.toThrow();
  });
});
