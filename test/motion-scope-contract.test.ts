import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { scope } from '../src/motion/scope.js';
import { value } from '../src/motion/value.js';
import { frame } from '../src/frame/index.js';

const dom = new JSDOM('<main><button class="a"></button><section><button class="b"></button></section></main>');
const document = dom.window.document;
afterEach(() => { frame.cancelAll(); vi.unstubAllGlobals(); document.querySelector('main')!.removeAttribute('style'); });
function clocks() {
  let time = 0, id = 0; const jobs = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { jobs.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => jobs.delete(key));
  vi.stubGlobal('performance', { now: () => time });
  return { step(at: number) { time = at; const batch = [...jobs.values()]; jobs.clear(); batch.forEach(cb => cb(at)); }, jobs };
}

it('одна область очищает анимации, значения, подписки и дочерние области', async () => {
  const clock = clocks(); const root = document.querySelector('main')!;
  const area = scope(root, { duration: 1000, ease: 'linear' });
  const child = area.scope(root.querySelector('section')!);
  let clicks = 0;
  const off = area.on('.a', 'click', () => { clicks++; });
  const run = area.animate('.a', { opacity: [0, 1] });
  const nested = child.animate('.b', { opacity: [0, 1] });
  const scalar = area.value(0); const listener = vi.fn(); scalar.subscribe(listener);
  const scalarRun = scalar.animate(100, { duration: 1000, ease: 'linear' });
  root.querySelector('.a')!.dispatchEvent(new dom.window.Event('click')); expect(clicks).toBe(1);
  clock.step(100); expect(listener).toHaveBeenCalled();
  area.dispose(); off(); area.dispose();
  expect(child.disposed).toBe(true); expect(area.disposed).toBe(true);
  root.querySelector('.a')!.dispatchEvent(new dom.window.Event('click')); expect(clicks).toBe(1);
  expect(await run.finished).toEqual({ status: 'stopped' });
  expect(await nested.finished).toEqual({ status: 'stopped' });
  expect(await scalarRun.finished).toEqual({ status: 'stopped' });
  await Promise.resolve(); clock.step(1000);
  expect(clock.jobs.size).toBe(0);
});

it('disposed scope не читает новые getters и не запускает callbacks layout', async () => {
  clocks(); const area = scope(document.querySelector('main')!); area.dispose();
  const mutate = vi.fn(); const props = { get opacity(): number { throw new Error('read'); } };
  const c = area.animate('bad[', props);
  expect(await c.finished).toEqual({ status: 'stopped' });
  expect(await area.layout(mutate).finished).toEqual({ status: 'stopped' }); expect(mutate).not.toHaveBeenCalled();
});

it('значение принимает вложенный ввод и остаётся управляемым после исключения слушателя', () => {
  clocks(); const v = value(0); const calls: number[] = [];
  v.subscribe(n => { calls.push(n); if (n === 1) v.set(2); });
  v.set(1); expect(v.get()).toBe(2); expect(calls).toEqual([1, 2]);
  const failure = new Error('listener'); const off = v.subscribe(() => { throw failure; });
  expect(() => v.set(3)).toThrow(failure); off();
  v.set(4); expect(v.get()).toBe(4);
  v.dispose(); v.set(9); expect(v.get()).toBe(4);
});

it('старый off не снимает последующую регистрацию той же функции', () => {
  const v = value(0); const listener = vi.fn();
  const first = v.subscribe(listener); v.subscribe(listener); first();
  v.set(1); expect(listener).toHaveBeenCalledOnce();
  v.dispose();
});

it('явная длительность области заменяет физику по умолчанию без скрытого приоритета', () => {
  clocks(); const root = document.querySelector('main')!;
  const area = scope(root, { spring: { response: 200, bounce: .1 } });
  const c = area.animate('.a', { opacity: [0, 1] }, { duration: 100, ease: 'linear' });
  expect(c.duration).toBe(100); c.seek(50);
  expect((root.querySelector('.a')! as HTMLElement).style.opacity).toBe('0.5');
  area.dispose();
});

it('ошибка регистрации события не удерживает уже зарегистрированные listeners', () => {
  const area = scope(document.querySelector('main')!);
  const target = { addEventListener() { throw new Error('listen failed'); }, removeEventListener: vi.fn() };
  expect(() => area.on(target as unknown as EventTarget, 'click', () => {})).toThrow('listen failed');
  expect(target.removeEventListener).toHaveBeenCalledOnce(); area.dispose();
});
