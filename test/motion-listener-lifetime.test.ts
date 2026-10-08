import { expect, it, vi } from 'vitest';
import { listen } from '../src/motion/listener.js';

it('once освобождает регистрацию каждого элемента и сохраняет this', () => {
  const a = new EventTarget(), b = new EventTarget(), owner = new Set<() => void>();
  const calls: EventTarget[] = [];
  const off = listen([a, b], 'ready', function () { calls.push(this); }, { once: true }, owner, () => true);
  a.dispatchEvent(new Event('ready')); a.dispatchEvent(new Event('ready'));
  expect(calls).toEqual([a]); expect(owner.size).toBe(1);
  b.dispatchEvent(new Event('ready')); expect(calls).toEqual([a, b]); expect(owner.size).toBe(0);
  off(); b.dispatchEvent(new Event('ready')); expect(calls).toHaveLength(2);
});
it('abort снимает физические callbacks и запись владельца', () => {
  const target = new EventTarget(), signal = new AbortController(), owner = new Set<() => void>(), callback = vi.fn();
  const off = listen([target], 'ready', callback, { signal: signal.signal }, owner, () => true);
  target.dispatchEvent(new Event('ready')); expect(callback).toHaveBeenCalledTimes(1);
  signal.abort(); expect(owner.size).toBe(0);
  target.dispatchEvent(new Event('ready')); off(); expect(callback).toHaveBeenCalledTimes(1);
  const add = vi.spyOn(target, 'addEventListener');
  listen([target], 'ready', callback, { signal: signal.signal }, owner, () => true);
  expect(add).not.toHaveBeenCalled(); expect(owner.size).toBe(0);
});
it('10 000 одноразовых и отменённых подписок не накапливаются в живой области', () => {
  const owner = new Set<() => void>(), target = new EventTarget(); let calls = 0;
  for (let i = 0; i < 10_000; i++) {
    if (i % 2) {
      const controller = new AbortController();
      listen([target], 'ready', () => { calls++; }, { signal: controller.signal }, owner, () => true);
      controller.abort();
    } else {
      listen([target], 'ready', () => { calls++; }, { once: true }, owner, () => true);
      target.dispatchEvent(new Event('ready'));
    }
    expect(owner.size).toBe(0);
  }
  target.dispatchEvent(new Event('ready')); expect(calls).toBe(5000);
});
it('отзыв области внутри add не оставляет физическую регистрацию', () => {
  const owner = new Set<() => void>(), target = new EventTarget(), callback = vi.fn(); let active = true;
  const add = target.addEventListener.bind(target), remove = vi.spyOn(target, 'removeEventListener');
  target.addEventListener = (name, cb, options) => {
    active = false; for (const stop of owner) stop();
    add(name, cb, options);
  };
  listen([target], 'ready', callback, undefined, owner, () => active);
  target.dispatchEvent(new Event('ready'));
  expect(callback).not.toHaveBeenCalled(); expect(owner.size).toBe(0); expect(remove).toHaveBeenCalledTimes(2);
});
