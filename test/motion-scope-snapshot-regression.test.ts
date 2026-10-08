import { expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { scope, snapshotOptions } from '../src/motion/scope.js';

it('spring проверяется и сохраняется после одного чтения getter', () => {
  let reads = 0;
  const spring = { mass: 1, get stiffness() { return ++reads === 1 ? 170 : -1; }, damping: 26 };
  const result = snapshotOptions({ spring });
  expect(reads).toBe(1); expect(result.spring).toEqual({ mass: 1, stiffness: 170, damping: 26 }); expect(result.spring).not.toBe(spring);
});
it('times и ease сохраняют именно проверенные значения', () => {
  let timeReads = 0, easeReads = 0;
  const times = [0, 1], ease: [number, number, number, number] = [.2, 0, 0, 1];
  Object.defineProperty(times, 1, { get() { return ++timeReads === 1 ? 1 : .5; } });
  Object.defineProperty(ease, 0, { get() { return ++easeReads === 1 ? .2 : 2; } });
  const result = snapshotOptions({ duration: 1000, times, ease });
  expect(timeReads).toBe(1); expect(easeReads).toBe(1); expect(result.times).toEqual([0, 1]); expect(result.ease).toEqual([.2, 0, 0, 1]);
});
it('невалидная физика отклоняется при создании области', () => {
  const dom = new JSDOM('<main></main>'); let reads = 0;
  try {
    expect(() => scope(dom.window.document.querySelector('main')!, { spring: { mass: 1, get stiffness() { reads++; return -1; }, damping: 26 } })).toThrow();
    expect(reads).toBe(1);
  } finally { dom.window.close(); }
});
it('EventTarget получает тот же capture при добавлении и удалении', () => {
  const dom = new JSDOM('<main><button></button></main>');
  const root = dom.window.document.querySelector('main')!, button = root.querySelector('button')!;
  const area = scope(root), listener = vi.fn(); let reads = 0;
  try {
    const off = area.on(button, 'click', listener, { get capture() { return ++reads === 1; } });
    off(); button.dispatchEvent(new dom.window.Event('click'));
    expect(reads).toBe(1); expect(listener).not.toHaveBeenCalled();
  } finally { area.dispose(); dom.window.close(); }
});
it('одинаковая callback-функция в двух областях имеет независимую очистку', () => {
  const dom = new JSDOM('<main><button></button></main>');
  const root = dom.window.document.querySelector('main')!, button = root.querySelector('button')!;
  const first = scope(root), second = scope(root), listener = vi.fn();
  try {
    first.on(button, 'click', listener); second.on(button, 'click', listener); first.dispose();
    button.dispatchEvent(new dom.window.Event('click')); expect(listener).toHaveBeenCalledTimes(1);
    second.dispose(); button.dispatchEvent(new dom.window.Event('click')); expect(listener).toHaveBeenCalledTimes(1);
  } finally { first.dispose(); second.dispose(); dom.window.close(); }
});
it('отказ remove отзывает callback и не пропускает другие элементы', () => {
  const dom = new JSDOM('<main><button></button><button></button></main>');
  const root = dom.window.document.querySelector('main')!, [a, b] = [...root.querySelectorAll('button')];
  const area = scope(root), listener = vi.fn(), error = new Error('remove failed');
  const original = a!.removeEventListener.bind(a), other = vi.spyOn(b!, 'removeEventListener');
  try {
    const off = area.on('button', 'click', listener); a!.removeEventListener = () => { throw error; };
    expect(off).toThrow(error); expect(other).toHaveBeenCalledTimes(1);
    a!.dispatchEvent(new dom.window.Event('click')); b!.dispatchEvent(new dom.window.Event('click'));
    expect(listener).not.toHaveBeenCalled(); expect(off).not.toThrow();
  } finally { a!.removeEventListener = original; area.dispose(); dom.window.close(); }
});
it('ошибки установки и очистки обе доступны вызывающему коду', () => {
  const dom = new JSDOM('<main></main>'), area = scope(dom.window.document.querySelector('main')!);
  const install = new Error('install'), cleanup = new Error('cleanup');
  const target = { addEventListener() { throw install; }, removeEventListener() { throw cleanup; } } as unknown as EventTarget;
  try {
    let caught: unknown; try { area.on(target, 'click', () => {}); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError); expect((caught as AggregateError).errors).toEqual([install, cleanup]);
  } finally { area.dispose(); dom.window.close(); }
});
