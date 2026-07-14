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
  delete (Object.prototype as Record<string, unknown>)['transform'];
  delete (Object.prototype as Record<string, unknown>)['opacity'];
  vi.unstubAllGlobals();
  __resetDetectionCache();
  __resetSpringExecutionCache();
});

function deferredElement() {
  const inline = new Map<string, string>();
  let resolve!: () => void;
  const finished = new Promise<void>((ok) => { resolve = ok; });
  const cancel = vi.fn();
  return {
    inline,
    resolve,
    cancel,
    element: {
      style: { setProperty: (name: string, value: string) => inline.set(name, value) },
      animate: () => ({ finished, cancel }),
    },
  };
}

describe('adversarial ownership', () => {
  it('prototype pollution не блокирует natural materialization transform', async () => {
    Object.defineProperty(Object.prototype, 'transform', {
      value: Number.POSITIVE_INFINITY,
      writable: true,
      configurable: true,
    });
    const f = deferredElement();
    const controls = springTo(f.element, { x: [0, 100] });
    f.resolve();
    await controls.finished;

    expect(f.inline.get('transform')).toBe('translateX(100px)');
  });

  it('prototype pollution не блокирует reduced materialization opacity', async () => {
    Object.defineProperty(Object.prototype, 'opacity', {
      value: Number.POSITIVE_INFINITY,
      writable: true,
      configurable: true,
    });
    const f = deferredElement();
    await springTo(f.element, { opacity: [0, 1] }, { reducedMotion: true }).finished;

    expect(f.inline.get('opacity')).toBe('1');
  });

  it('hostile prototype getter не рвёт setup и не оставляет effect без controls', () => {
    Object.defineProperty(Object.prototype, 'transform', {
      get() { throw new Error('prototype getter leaked into ownership'); },
      configurable: true,
    });
    const f = deferredElement();

    expect(() => springTo(f.element, { x: [0, 100] })).not.toThrow();
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it('ошибка finished-getter после animate откатывает начатый effect', () => {
    const f = deferredElement();
    f.element.animate = () => ({
      cancel: f.cancel,
      get finished(): Promise<void> { throw new Error('finished failed'); },
    });

    expect(() => springTo(f.element, { x: [0, 100] })).toThrow('finished failed');
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });
});
