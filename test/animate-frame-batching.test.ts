/**
 * Production-пины full ./animate: полный read-plan до коммита и один общий
 * frame-loop для любого числа main-thread групп. Метрики здесь структурные:
 * они не зависят от скорости CI-машины и прямо доказывают отсутствие layout-
 * thrash и N независимых rAF-циклов.
 */

import { describe, expect, it, vi } from 'vitest';
import { animate as animateBase } from '../src/animate/index.js';
import type { AnimatableElement } from '../src/animate/index.js';
import { frame as defaultFrame } from '../src/frame/index.js';
import { fakeEl, makeClock, withLiveEngine } from './animate-facade-helpers.js';

// Харнесс R3b: rAF-пути исполняет композируемый live-движок (см. helpers).
const animate = withLiveEngine(animateBase as never);

interface LoggedElement {
  readonly el: AnimatableElement & {
    animate?: (
      keyframes: Record<string, string | number>[],
      timing: Record<string, unknown>,
    ) => { cancel(): void };
  };
}

function loggedElement(
  id: string,
  events: string[],
  options: {
    readonly waapi?: boolean;
    readonly throwOnWrite?: boolean;
    readonly throwOnAnimate?: boolean;
  } = {},
): LoggedElement {
  const values = new Map<string, string>([['opacity', '1']]);
  const el: LoggedElement['el'] = {
    style: {
      getPropertyValue(name: string): string {
        events.push(`read:${id}:${name}`);
        return values.get(name) ?? '';
      },
      setProperty(name: string, value: string): void {
        events.push(`write:${id}:${name}`);
        if (options.throwOnWrite === true) throw new Error('write failed');
        values.set(name, value);
      },
    },
  };
  if (options.waapi === true) {
    el.animate = (keyframes, timing) => {
      const property =
        Object.keys(keyframes[0] ?? {}).find((key) => key !== 'offset') ?? 'unknown';
      events.push(`animate:${id}:${property}:${String(timing['delay'] ?? 0)}`);
      if (options.throwOnAnimate === true) throw new Error('animate failed');
      return {
        cancel() {
          events.push(`cancel:${id}`);
        },
      };
    };
  }
  return { el };
}

describe('animate: двухфазный read-plan → commit', () => {
  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('читает ВСЕ WAAPI-цели до первого Element.animate', () => {
    const events: string[] = [];
    const els = ['a', 'b', 'c'].map((id) => loggedElement(id, events, { waapi: true }));

    animate(
      els.map((x) => x.el),
      { opacity: 0 },
      { spring: { mass: 1, stiffness: 170, damping: 26 } },
    );

    const lastRead = events.reduce((last, e, i) => (e.startsWith('read:') ? i : last), -1);
    const firstCommit = events.findIndex((e) => e.startsWith('animate:'));
    expect(lastRead).toBeGreaterThanOrEqual(0);
    expect(firstCommit).toBeGreaterThan(lastRead);
  });

  it('читает ВСЕ reduced-цели до первой записи и сохраняет target-major/stagger', () => {
    const events: string[] = [];
    const els = ['a', 'b', 'c'].map((id) => loggedElement(id, events));

    animate(
      els.map((x) => x.el),
      { opacity: 0 },
      {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        stagger: 40,
        matchMedia: () => ({ matches: true }),
      },
    );

    const lastRead = events.reduce((last, e, i) => (e.startsWith('read:') ? i : last), -1);
    const firstWrite = events.findIndex((e) => e.startsWith('write:'));
    expect(firstWrite).toBeGreaterThan(lastRead);
    expect(events.filter((e) => e.startsWith('write:'))).toEqual([
      'write:a:opacity',
      'write:b:opacity',
      'write:c:opacity',
    ]);
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('коммитит compositor-группы target-major с исходным stagger', () => {
    const events: string[] = [];
    const els = ['a', 'b'].map((id) => loggedElement(id, events, { waapi: true }));

    animate(
      els.map((x) => x.el),
      { x: 100, opacity: [1, 0] },
      {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        stagger: 40,
      },
    );

    expect(events.filter((e) => e.startsWith('animate:'))).toEqual([
      'animate:a:transform:0',
      'animate:a:opacity:0',
      'animate:b:transform:40',
      'animate:b:opacity:40',
    ]);
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('не supersede-ит живого владельца, пока не завершены чтения поздних целей', () => {
    const events: string[] = [];
    const a = loggedElement('a', events, { waapi: true });
    const b = loggedElement('b', events, { waapi: true });
    const c = loggedElement('c', events, { waapi: true });
    const spring = { mass: 1, stiffness: 170, damping: 26 };
    animate(a.el, { opacity: 0.5 }, { spring });
    events.length = 0;

    animate([a.el, b.el, c.el], { opacity: 0 }, { spring });

    const lastRead = events.reduce((last, e, i) => (e.startsWith('read:') ? i : last), -1);
    const firstSupersede = events.findIndex((e) => e.startsWith('cancel:'));
    expect(firstSupersede).toBeGreaterThan(lastRead);
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('дубликат цели supersede-ит owner, созданный предыдущей записью commit', () => {
    const events: string[] = [];
    const a = loggedElement('a', events, { waapi: true });

    animate(
      [a.el, a.el],
      { opacity: [1, 0] },
      { spring: { mass: 1, stiffness: 170, damping: 26 } },
    );

    expect(events.filter((e) => /^(?:animate|cancel):/.test(e))).toEqual([
      'animate:a:opacity:0',
      'animate:a:opacity:0',
      'cancel:a',
    ]);
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('бросок позднего Element.animate отменяет ранее созданные юниты', () => {
    const events: string[] = [];
    const first = loggedElement('a', events, { waapi: true });
    const broken = loggedElement('b', events, { waapi: true, throwOnAnimate: true });

    expect(() =>
      animate(
        [first.el, broken.el],
        { opacity: [1, 0] },
        {
          spring: { mass: 1, stiffness: 170, damping: 26 },
          setTimer: () => () => {},
        },
      ),
    ).toThrow('animate failed');
    expect(events.filter((e) => /^(?:animate|cancel):/.test(e))).toEqual([
      'animate:a:opacity:0',
      'animate:b:opacity:0',
      'cancel:a',
    ]);
  });
});

describe('animate: общий main-thread FrameLoop', () => {
  for (const count of [1, 100, 1000]) {
    // @todo-R3c: main-lane: общий FrameLoop мёртвого rAF-фасада; батч live — R3c
    it.skip(`N=${count}: один native rAF на старт и один на следующий кадр`, () => {
      const targets = Array.from({ length: count }, () => fakeEl().el);
      const clock = makeClock();
      let requests = 0;
      const requestFrame = (cb: (ts?: number) => void): number => {
        requests++;
        return clock.requestFrame(cb);
      };

      const controls = animate(
        targets,
        { x: [0, 100] },
        { duration: 1000, ease: (t) => t, requestFrame },
      );
      expect(requests).toBe(1);
      clock.step(16);
      expect(requests).toBe(2);
      controls.cancel();
      clock.step(16); // уже выданный кадр инертен и не создаёт idle-loop
      expect(requests).toBe(2);
    });
  }

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('1000 default animate делят ровно update+render внутри defaultFrame', () => {
    vi.useFakeTimers();
    const update = vi.spyOn(defaultFrame, 'update');
    const render = vi.spyOn(defaultFrame, 'render');
    try {
      const controls = Array.from({ length: 1000 }, () =>
        animate(fakeEl().el, { x: [0, 100] }, { duration: 1000, ease: (t) => t }),
      );
      expect(update).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledTimes(1);
      controls.forEach((control) => control.cancel());
      vi.runOnlyPendingTimers();
    } finally {
      update.mockRestore();
      render.mockRestore();
      vi.useRealTimers();
    }
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('100 целей × 3 группы всё равно используют один native rAF', () => {
    const targets = Array.from({ length: 100 }, () => fakeEl({ width: '0px' }).el);
    const clock = makeClock();
    let requests = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      requests++;
      return clock.requestFrame(cb);
    };

    const controls = animate(
      targets,
      { x: [0, 100], opacity: [1, 0], width: ['0px', '100px'] },
      { duration: 1000, ease: (t) => t, requestFrame },
    );
    expect(requests).toBe(1);
    clock.step(16);
    expect(requests).toBe(2);
    controls.cancel();
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('считает ВСЕ юниты в update до первой DOM-записи render', () => {
    const events: string[] = [];
    const targets = ['a', 'b', 'c'].map((id) => loggedElement(id, events).el);
    const clock = makeClock();

    animate(targets, { opacity: [1, 0] }, {
      duration: 1000,
      ease: (t) => {
        events.push('compute');
        return t;
      },
      requestFrame: clock.requestFrame,
    });
    events.length = 0;
    clock.step(16);

    expect(events.slice(0, 3)).toEqual(['compute', 'compute', 'compute']);
    expect(events.slice(3)).toEqual([
      'write:a:opacity',
      'write:b:opacity',
      'write:c:opacity',
    ]);
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('pause/cancel/settle не держат idle-loop; play создаёт ровно один цикл', async () => {
    const clock = makeClock();
    let requests = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      requests++;
      return clock.requestFrame(cb);
    };
    const controls = animate(
      [fakeEl().el, fakeEl().el, fakeEl().el],
      { x: [0, 100] },
      { duration: 32, ease: (t) => t, requestFrame },
    );

    expect(requests).toBe(1);
    controls.pause();
    clock.step(16); // погасить уже выданный native callback
    expect(requests).toBe(1);
    controls.play();
    expect(requests).toBe(2);
    clock.drain(16);
    await controls.finished;
    const settledRequests = requests;
    clock.step(16);
    expect(requests).toBe(settledRequests);
  });

  it('ретаргет оставляет один живой цикл и не перепланирует старый', () => {
    const f = fakeEl();
    const clock = makeClock();
    let requests = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      requests++;
      return clock.requestFrame(cb);
    };

    animate(f.el, { x: 100 }, { duration: 1000, ease: (t) => t, requestFrame });
    clock.step(16);
    animate(f.el, { x: 200 }, { duration: 1000, ease: (t) => t, requestFrame });
    const afterRetarget = requests;
    clock.step(16); // старый callback инертен; новый цикл планирует один следующий
    expect(requests - afterRetarget).toBe(1);
    clock.step(16);
    expect(requests - afterRetarget).toBe(2);
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('ошибка пользовательского ease завершает unit fail-closed без вечных кадров', async () => {
    const f = fakeEl();
    const clock = makeClock();
    let requests = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      requests++;
      return clock.requestFrame(cb);
    };
    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: () => {
        throw new Error('host callback failed');
      },
      requestFrame,
    });

    expect(() => clock.step(16)).not.toThrow();
    await controls.finished;
    const stoppedAt = requests;
    clock.step(16);
    expect(requests).toBe(stoppedAt);
    expect(f.writes).toHaveLength(0);
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('handle=0 создаёт один fallback-таймер для 100 юнитов, не 100', async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const controls = animate(
        Array.from({ length: 100 }, () => fakeEl().el),
        { x: [0, 100] },
        {
          duration: 32,
          ease: (t) => t,
          requestFrame: () => {
            requests++;
            return 0;
          },
        },
      );

      expect(requests).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.runAllTimersAsync();
      await controls.finished;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('default frame cancelAll терминализирует pool и следующий animate возобновляет кадры', async () => {
    const queue: Array<(ts?: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (ts?: number) => void) => {
      queue.push(cb);
      return queue.length;
    });
    defaultFrame.cancelAll();
    try {
      const firstTarget = fakeEl();
      const first = animate(firstTarget.el, { x: [0, 100] }, { duration: 1000 });
      expect(queue).toHaveLength(1);

      defaultFrame.cancelAll();
      await first.finished;

      const nextTarget = fakeEl();
      const next = animate(nextTarget.el, { x: [0, 100] }, { duration: 1000 });
      while (queue.length > 0 && nextTarget.writes.length === 0) queue.shift()!(0);
      expect(nextTarget.writes.length).toBeGreaterThan(0);
      next.cancel();
      await next.finished;
    } finally {
      defaultFrame.cancelAll();
      vi.unstubAllGlobals();
    }
  });

  // @todo-R3c: main-lane: фазовая дисциплина SurfaceBatch rAF-фасада умерла с маршрутизацией; двухфазный план нового ядра закреплён R3a-сьютом
  it.skip('cancelAll между update/render сохраняет видимый, а не скрытый computed state', async () => {
    const queue: Array<(ts?: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (ts?: number) => void) => {
      queue.push(cb);
      return queue.length;
    });
    defaultFrame.cancelAll();
    try {
      const target = fakeEl();
      const first = animate(target.el, { x: [0, 100] }, { duration: 1000, ease: (t) => t });
      queue.shift()!(0);
      expect(target.writes.at(-1)).toEqual({ prop: 'transform', value: 'none' });

      defaultFrame.update(() => defaultFrame.cancelAll(), { once: true });
      queue.shift()!(16);
      await first.finished;
      expect(target.writes.at(-1)).toEqual({ prop: 'transform', value: 'none' });

      const next = animate(target.el, { x: 100 }, { duration: 1000, ease: (t) => t });
      queue.shift()!(32);
      expect(target.writes.at(-1)).toEqual({ prop: 'transform', value: 'none' });
      next.cancel();
      await next.finished;
    } finally {
      defaultFrame.cancelAll();
      vi.unstubAllGlobals();
    }
  });
});
