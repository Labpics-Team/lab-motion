import { afterEach, expect, it, vi } from 'vitest';
import { springStore, type SpringStore } from '../src/svelte/index.js';

const stores: SpringStore[] = [];
function createStore(): SpringStore {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
  const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', () => {
    throw new Error('Reduced-motion witness не должен запрашивать кадр');
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores) store.destroy();
  stores.length = 0;
  vi.unstubAllGlobals();
});

it('повтор отменённой отписки не удаляет новую регистрацию того же callback', () => {
  const store = createStore();
  const received: number[] = [];
  const neighbor: number[] = [];
  const callback = (value: number): void => { received.push(value); };
  store.subscribe((value) => { neighbor.push(value); });
  const oldOff = store.subscribe(callback);
  oldOff();
  const successorOff = store.subscribe(callback);
  oldOff();
  store.set(1);
  expect(neighbor).toEqual([0, 1]);
  expect(received).toEqual([0, 0, 1]);
  successorOff();
  store.set(2);
  expect(received).toEqual([0, 0, 1]);
  expect(neighbor).toEqual([0, 1, 2]);
});

it.each([0, 1])('отписка duplicate %s отзывает старую регистрацию и не затрагивает преемника', (cancelIndex) => {
  const store = createStore();
  const received: number[] = [];
  const callback = (value: number): void => { received.push(value); };
  const handles = [store.subscribe(callback), store.subscribe(callback)] as const;
  expect(received).toEqual([0, 0]);
  store.set(1);
  expect(received).toEqual([0, 0, 1]);
  handles[cancelIndex]!();
  store.set(2);
  expect(received).toEqual([0, 0, 1]);
  const successorOff = store.subscribe(callback);
  handles[1 - cancelIndex]!();
  store.set(3);
  expect(received).toEqual([0, 0, 1, 2, 3]);
  successorOff();
});

it('сохраняет прежний fail-fast broadcast при ошибке подписчика', () => {
  const store = createStore();
  const failure = { source: 'subscriber' };
  const neighbor: number[] = [];
  store.subscribe((value) => { if (value !== 0) throw failure; });
  store.subscribe((value) => { neighbor.push(value); });
  let thrown: unknown;
  try { store.set(1); } catch (error) { thrown = error; }
  expect(thrown).toBe(failure);
  expect(neighbor).toEqual([0]);
  expect(() => store.set(2)).not.toThrow();
  expect(neighbor).toEqual([0]);
});
