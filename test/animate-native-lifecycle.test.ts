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

describe('animate/native: natural lifecycle', () => {
  it('fulfilled фиксирует точную цель и снимает effects в обратном порядке', async () => {
    const events: string[] = [];
    const a = deferredElement(events, 'a');
    const b = deferredElement(events, 'b');
    const controls = springTo([a, b], { x: [0, 100], opacity: [0, 1] });

    a.resolve();
    b.resolve();
    await controls.finished;

    expect(events).toEqual([
      'b:write:transform:translateX(100px)',
      'b:write:opacity:1',
      'b:cancel',
      'a:write:transform:translateX(100px)',
      'a:write:opacity:1',
      'a:cancel',
    ]);
    controls.cancel();
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledTimes(1);
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

  it('rejection одной цели отменяет все effects без финальной записи', async () => {
    const events: string[] = [];
    const a = deferredElement(events, 'a');
    const b = deferredElement(events, 'b');
    const controls = springTo([a, b], { opacity: [0, 1] });

    a.resolve();
    b.reject(new Error('host failed'));
    await controls.finished;

    expect(events).toEqual(['b:cancel', 'a:cancel']);
    controls.cancel();
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledTimes(1);
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
    expect(events.some((event) => event.includes(':write:'))).toBe(false);
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
