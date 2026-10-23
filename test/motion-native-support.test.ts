import { afterEach, expect, it, vi } from 'vitest';
import { animate } from '../src/motion/index.js';
import { frame } from '../src/frame/index.js';
import { harness } from './fixtures/motion-runtime.js';

afterEach(() => { frame.cancelAll(); vi.unstubAllGlobals(); });

const linear = { duration: 1000, ease: 'linear' } as const;

it('группа native-целей разбирает общую CSS-кривую один раз и полностью завершается', async () => {
  const css = { supports: vi.fn(function(this: unknown, property: string, easing: string) {
    expect(this).toBe(css);
    expect(property).toBe('animation-timing-function');
    expect(easing).toBe('linear');
    return true;
  }) };
  vi.stubGlobal('CSS', css);
  const items = Array.from({ length: 24 }, () => harness(true));
  const run = animate(items.map(item => item.element), { x: [0, 100], opacity: [0, 1] }, linear);
  try {
    expect(css.supports).toHaveBeenCalledTimes(1);
    expect(items.every(item => item.effects.length === 2)).toBe(true);
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    for (const item of items) {
      expect(item.x()).toBe(100);
      expect(item.values.get('opacity')).toBe('1');
      expect(item.effects.every(effect => effect.cancelled)).toBe(true);
    }
  } finally { run.stop(); }
});

it('результат принадлежит точным CSS receiver, функции и easing', () => {
  const check = vi.fn(function(this: { supported: boolean }) { return this.supported; });
  const css = { supported: true, supports: check };
  const launch = (ease: 'linear' | 'ease-in' = 'linear') => {
    const h = harness(true);
    const run = animate(h.element, { x: [0, 100] }, { duration: 1000, ease });
    try { run.finish(); expect(h.x()).toBe(100); return h.effects.length; }
    finally { run.stop(); }
  };
  vi.stubGlobal('CSS', css);
  expect(launch()).toBe(1);
  expect(launch('ease-in')).toBe(1);
  expect(check).toHaveBeenCalledTimes(2);
  const replacement = { supported: false, supports: check };
  vi.stubGlobal('CSS', replacement);
  expect(launch('ease-in')).toBe(0);
  expect(check).toHaveBeenCalledTimes(3);
  replacement.supports = vi.fn(function(this: { supported: boolean }) { return true; });
  expect(launch('ease-in')).toBe(1);
  expect(replacement.supports).toHaveBeenCalledTimes(1);
  vi.stubGlobal('CSS', undefined);
  expect(launch('ease-in')).toBe(0);
});

it('отказ CSS-проверки не становится кэшированным ответом для следующего запуска', () => {
  const failure = new Error('CSS unavailable');
  const supports = vi.fn().mockImplementationOnce(() => { throw failure; }).mockReturnValue(true);
  vi.stubGlobal('CSS', { supports });
  const h = harness(true);
  expect(() => animate(h.element, { x: [0, 100] }, linear)).toThrow(failure);
  const recovered = animate(h.element, { x: [0, 100] }, linear);
  try {
    expect(supports).toHaveBeenCalledTimes(2);
    expect(h.effects).toHaveLength(1);
    recovered.finish(); expect(h.x()).toBe(100);
  } finally { recovered.stop(); }
});

it('инжектированный RuntimeHost сохраняет динамическое решение на каждом запуске', () => {
  const h = harness(true);
  let supported = true;
  h.host.supports = vi.fn(() => supported);
  const first = h.runtime.animate(h.element, { x: [0, 100] }, linear);
  first.finish();
  supported = false;
  const second = h.runtime.animate(h.element, { x: [0, 100] }, linear);
  try {
    expect(h.host.supports).toHaveBeenCalledTimes(2);
    expect(h.effects).toHaveLength(1);
    second.seek(500); expect(h.x()).toBe(50);
    second.finish(); expect(h.x()).toBe(100);
  } finally { second.stop(); }
});
