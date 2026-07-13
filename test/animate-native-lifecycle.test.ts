/** Естественная материализация и rollback узкого native WAAPI-пути. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { springTo } from '../src/animate/native/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { __resetSpringExecutionCache } from '../src/compositor/execution.js';

beforeEach(() => {
  __resetDetectionCache();
  __resetSpringExecutionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
  __resetSpringExecutionCache();
});

function deferredElement(events: string[], name: string, hostileStyle = false) {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const finished = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const cancel = vi.fn(() => events.push(`${name}:cancel`));
  return {
    resolve,
    reject,
    cancel,
    style: {
      setProperty(prop: string, value: string) {
        events.push(`${name}:write:${prop}:${value}`);
        if (hostileStyle) throw new Error('style failed');
      },
    },
    animate: () => ({ finished, cancel }),
  };
}

function overlappingElement() {
  const inline = new Map<string, string>();
  const effects: Array<{
    readonly finished: Promise<void>;
    readonly cancel: ReturnType<typeof vi.fn>;
    resolve(): void;
    reject(reason?: unknown): void;
  }> = [];
  const element = {
    style: { setProperty: (name: string, value: string) => inline.set(name, value) },
    animate(): { finished: Promise<void>; cancel(): void } {
      let resolve!: () => void;
      let reject!: (reason?: unknown) => void;
      const effect = {
        finished: new Promise<void>((ok, fail) => {
          resolve = ok;
          reject = fail;
        }),
        resolve: () => resolve(),
        reject: (reason?: unknown) => reject(reason),
        cancel: vi.fn(),
      };
      effects.push(effect);
      return effect;
    },
  };
  return { inline, effects, element };
}

describe('animate/native: natural lifecycle', () => {
  it('поздний finish вытесненного springTo не перезаписывает цель нового owner', async () => {
    const { inline, effects, element } = overlappingElement();

    const older = springTo(
      element,
      { x: [0, 100] },
      { spring: { mass: 1, stiffness: 50, damping: 1 } },
    );
    const newer = springTo(element, { x: [0, 200] });

    effects[1]!.resolve();
    await newer.finished;
    expect(inline.get('transform')).toBe('translateX(200px)');

    effects[0]!.resolve();
    await older.finished;
    expect(inline.get('transform')).toBe('translateX(200px)');
  });

  it('владение transform и opacity независимо', async () => {
    const { inline, effects, element } = overlappingElement();
    const transform = springTo(element, { x: [0, 100] });
    const opacity = springTo(element, { opacity: [0, 1] });

    effects[1]!.resolve();
    await opacity.finished;
    effects[0]!.resolve();
    await transform.finished;

    expect(inline).toEqual(new Map([
      ['opacity', '1'],
      ['transform', 'translateX(100px)'],
    ]));
  });

  it('detached cancel старого control не снимает ownership нового', async () => {
    const { inline, effects, element } = overlappingElement();
    const older = springTo(element, { x: [0, 100] });
    const newer = springTo(element, { x: [0, 200] });

    older.cancel();
    expect(effects[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(effects[1]!.cancel).not.toHaveBeenCalled();
    effects[1]!.resolve();
    await newer.finished;

    expect(inline.get('transform')).toBe('translateX(200px)');
  });

  it.each(['cancel', 'reject'] as const)(
    'терминал %s нового owner не возвращает право stale-final старому',
    async (terminal) => {
      const { inline, effects, element } = overlappingElement();
      const older = springTo(element, { x: [0, 100] });
      const newer = springTo(element, { x: [0, 200] });

      if (terminal === 'cancel') newer.cancel();
      else effects[1]!.reject(new Error('host failed'));
      await newer.finished;
      effects[0]!.resolve();
      await older.finished;

      expect(inline.has('transform')).toBe(false);
      expect(effects[0]!.cancel).toHaveBeenCalledTimes(1);
      expect(effects[1]!.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('вытеснение одной цели не меняет ownership соседней', async () => {
    const a = overlappingElement();
    const b = overlappingElement();
    const older = springTo([a.element, b.element], { x: [0, 100] });
    const newer = springTo(a.element, { x: [0, 200] });

    a.effects[1]!.resolve();
    await newer.finished;
    a.effects[0]!.resolve();
    b.effects[0]!.resolve();
    await older.finished;

    expect(a.inline.get('transform')).toBe('translateX(200px)');
    expect(b.inline.get('transform')).toBe('translateX(100px)');
  });

  it('неудачный host setup не отбирает ownership у живого прогона', async () => {
    const { inline, effects, element } = overlappingElement();
    const older = springTo(element, { x: [0, 100] });
    element.animate = () => { throw new Error('host setup failed'); };

    expect(() => springTo(element, { x: [0, 200] })).toThrow('host setup failed');
    effects[0]!.resolve();
    await older.finished;

    expect(inline.get('transform')).toBe('translateX(100px)');
  });

  it('реентрантный host setup не даёт старому вызову вытеснить новый', async () => {
    const { inline, effects, element } = overlappingElement();
    const hostAnimate = element.animate.bind(element);
    let newer!: ReturnType<typeof springTo>;
    let first = true;
    element.animate = () => {
      if (first) {
        first = false;
        newer = springTo(element, { x: [0, 200] });
      }
      return hostAnimate();
    };

    const older = springTo(element, { x: [0, 100] });
    effects[0]!.resolve();
    await newer.finished;
    effects[1]!.resolve();
    await older.finished;

    expect(inline.get('transform')).toBe('translateX(200px)');
  });

  it('reduced-motion снап вытесняет pending owner без stale-final', async () => {
    const { inline, effects, element } = overlappingElement();
    const older = springTo(element, { x: [0, 100] });

    await springTo(element, { x: [0, 200] }, { reducedMotion: true }).finished;
    expect(inline.get('transform')).toBe('translateX(200px)');
    effects[0]!.resolve();
    await older.finished;

    expect(inline.get('transform')).toBe('translateX(200px)');
  });

  it('reduced-motion reentry не перезаписывает канал нового поколения', () => {
    const inline = new Map<string, string>();
    let reentered = false;
    const element = {
      style: {
        setProperty(name: string, value: string) {
          inline.set(name, value);
          if (name === 'transform' && !reentered) {
            reentered = true;
            springTo(element, { opacity: [0, 0.5] }, { reducedMotion: true });
          }
        },
      },
      animate: vi.fn(),
    };

    springTo(element, { x: [0, 100], opacity: [0, 1] }, { reducedMotion: true });

    expect(inline).toEqual(new Map([
      ['transform', 'translateX(100px)'],
      ['opacity', '0.5'],
    ]));
    expect(element.animate).not.toHaveBeenCalled();
  });

  it('ошибка reduced-motion host не возвращает stale-owner', async () => {
    const { inline, effects, element } = overlappingElement();
    const older = springTo(element, { x: [0, 100] });
    element.style.setProperty = () => { throw new Error('style failed'); };

    expect(() => springTo(element, { x: [0, 200] }, { reducedMotion: true }))
      .toThrow('style failed');
    element.style.setProperty = (name, value) => inline.set(name, value);
    effects[0]!.resolve();
    await older.finished;

    expect(inline.has('transform')).toBe(false);
  });

  it('каждый fulfilled lane сразу фиксирует точную цель и снимает свой effect', async () => {
    const events: string[] = [];
    const a = deferredElement(events, 'a');
    const b = deferredElement(events, 'b');
    const controls = springTo([a, b], { x: [0, 100], opacity: [0, 1] });

    a.resolve();
    b.resolve();
    await controls.finished;

    expect(events).toEqual([
      'a:write:transform:translateX(100px)',
      'a:cancel',
      'a:write:opacity:1',
      'a:cancel',
      'b:write:transform:translateX(100px)',
      'b:cancel',
      'b:write:opacity:1',
      'b:cancel',
    ]);
    controls.cancel();
    expect(a.cancel).toHaveBeenCalledTimes(2);
    expect(b.cancel).toHaveBeenCalledTimes(2);
  });

  it('не доверяет изменённому host-ом single-target keyframe при финализации', async () => {
    const events: string[] = [];
    const el = deferredElement(events, 'a');
    el.animate = (keyframes: Record<string, string | number>[]) => {
      keyframes.at(-1)!['transform'] = 'translateX(-999px)';
      return { finished: Promise.resolve(), cancel: el.cancel };
    };

    await springTo(el, { x: [0, 100] }).finished;

    expect(events[0]).toBe('a:write:transform:translateX(100px)');
  });

  it('user cancel не дорисовывает финал после AbortError', async () => {
    const events: string[] = [];
    const el = deferredElement(events, 'a');
    const controls = springTo(el, { x: [0, 100] });

    controls.cancel();
    el.reject(new Error('AbortError'));
    await controls.finished;

    expect(events).toEqual(['a:cancel']);
  });

  it('user cancel завершает controls.finished даже при вечном host finished', async () => {
    const cancel = vi.fn();
    const el = {
      style: { setProperty: vi.fn() },
      animate: () => ({ cancel, finished: new Promise<void>(() => {}) }),
    };
    const controls = springTo(el, { opacity: [0, 1] });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    controls.cancel();
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(el.style.setProperty).not.toHaveBeenCalled();
  });

  it('finished control освобождает слоты завершённых effects', async () => {
    const events: string[] = [];
    const el = deferredElement(events, 'a');
    const controls = springTo(el, { opacity: [0, 1] });
    el.resolve();
    await controls.finished;
    const originalPop = Array.prototype.pop;
    let pops = 0;
    Array.prototype.pop = function <T>(this: T[]): T | undefined {
      pops++;
      return originalPop.call(this) as T | undefined;
    };
    try {
      controls.cancel();
    } finally {
      Array.prototype.pop = originalPop;
    }

    expect(pops).toBe(0);
  });

  it('частичная materialization уплотняет тысячу слотов до живого effect', async () => {
    const cancels = new Uint16Array(1000);
    const elements = Array.from({ length: cancels.length }, (_, index) => ({
      style: {
        setProperty() {
          if (index === cancels.length - 1) throw new Error('style failed');
        },
      },
      animate: () => ({
        finished: Promise.resolve(),
        cancel: () => { cancels[index]++; },
      }),
    }));
    const controls = springTo(elements, { opacity: [0, 1] });
    await controls.finished;
    const originalPop = Array.prototype.pop;
    let pops = 0;
    Array.prototype.pop = function <T>(this: T[]): T | undefined {
      pops++;
      return originalPop.call(this) as T | undefined;
    };
    try {
      controls.cancel();
    } finally {
      Array.prototype.pop = originalPop;
    }

    expect(pops).toBe(1);
    expect(cancels.at(-1)).toBe(1);
    expect(cancels.slice(0, -1).every((count) => count === 1)).toBe(true);
  });

  it('rejection одной цели сохраняет уже завершённый lane и отменяет остальные', async () => {
    const events: string[] = [];
    const a = deferredElement(events, 'a');
    const b = deferredElement(events, 'b');
    const controls = springTo([a, b], { opacity: [0, 1] });

    a.resolve();
    b.reject(new Error('host failed'));
    await controls.finished;

    expect(events).toEqual(['a:write:opacity:1', 'a:cancel', 'b:cancel']);
    controls.cancel();
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejection откатывает прогон, не ожидая вечный соседний эффект', async () => {
    const events: string[] = [];
    const pending = deferredElement(events, 'pending');
    const failed = deferredElement(events, 'failed');
    const controls = springTo([pending, failed], { opacity: [0, 1] });

    failed.reject(new Error('host failed'));
    await controls.finished;

    expect(failed.cancel).toHaveBeenCalledTimes(1);
    expect(pending.cancel).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.includes(':write:'))).toBe(false);
  });

  it('rejection изолирует бросающий cancel и очищает остальные effects', async () => {
    const events: string[] = [];
    const a = deferredElement(events, 'a');
    const b = deferredElement(events, 'b');
    b.cancel.mockImplementation(() => { throw new Error('cancel failed'); });
    const controls = springTo([a, b], { opacity: [0, 1] });

    a.resolve();
    b.reject(new Error('host failed'));
    await expect(controls.finished).resolves.toBeUndefined();

    expect(b.cancel).toHaveBeenCalledTimes(1);
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(events).toContain('a:write:opacity:1');
  });

  it('style failure сохраняет effect цели и не блокирует остальные', async () => {
    const events: string[] = [];
    const good = deferredElement(events, 'good');
    const hostile = deferredElement(events, 'hostile', true);
    const controls = springTo([good, hostile], { x: [0, 100] });

    good.resolve();
    hostile.resolve();
    await controls.finished;

    expect(hostile.cancel).not.toHaveBeenCalled();
    expect(good.cancel).toHaveBeenCalledTimes(1);
    expect(events).toContain('good:write:transform:translateX(100px)');

    controls.cancel();
    expect(hostile.cancel).toHaveBeenCalledTimes(1);
    expect(good.cancel).toHaveBeenCalledTimes(1);
  });

  it('reentrant displacement перед style throw не завершает вечный sibling', async () => {
    const events: string[] = [];
    const displaced = deferredElement(events, 'displaced');
    const pending = deferredElement(events, 'pending');
    let reentered = false;
    let inline = '';
    displaced.style.setProperty = (prop, value) => {
      events.push(`displaced:write:${prop}:${value}`);
      if (!reentered) {
        reentered = true;
        springTo(displaced, { opacity: [0, 0.5] }, { reducedMotion: true });
        inline = value;
        throw new Error('style failed after displacement');
      }
      inline = value;
    };
    const controls = springTo([displaced, pending], { opacity: [0, 1] });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    displaced.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(inline).toBe('0.5');
    expect(displaced.cancel).toHaveBeenCalledTimes(1);
    expect(pending.cancel).not.toHaveBeenCalled();

    controls.cancel();
    await controls.finished;
    controls.cancel();
    expect(displaced.cancel).toHaveBeenCalledTimes(1);
    expect(pending.cancel).toHaveBeenCalledTimes(1);
  });

  it('бросающий cancel не блокирует фиксацию соседней цели', async () => {
    const events: string[] = [];
    const a = deferredElement(events, 'a');
    const b = deferredElement(events, 'b');
    b.cancel.mockImplementation(() => { throw new Error('cancel failed'); });
    const controls = springTo([a, b], { opacity: [0, 1] });

    a.resolve();
    b.resolve();
    await expect(controls.finished).resolves.toBeUndefined();

    expect(b.cancel).toHaveBeenCalledTimes(1);
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(events).toContain('a:write:opacity:1');
  });

  it('pop до host callback делает natural cancel реентрантно безопасным', async () => {
    const events: string[] = [];
    const a = deferredElement(events, 'a');
    const b = deferredElement(events, 'b');
    let controls!: ReturnType<typeof springTo>;
    let reentered = false;
    b.style.setProperty = (prop, value) => {
      events.push(`b:write:${prop}:${value}`);
      if (!reentered) {
        reentered = true;
        controls.cancel();
      }
    };
    controls = springTo([a, b], { opacity: [0, 1] });

    a.resolve();
    b.resolve();
    await controls.finished;

    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === 'a:cancel')).toHaveLength(1);
  });
});
