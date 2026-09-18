import { afterEach, expect, it, vi } from 'vitest';
import { springStore } from '../src/svelte/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('a late subscriber immediately observes the latest emitted value', () => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: true }),
  });

  const store = springStore(0);
  store.set(100);

  const received: number[] = [];
  const unsubscribe = store.subscribe((value) => {
    received.push(value);
  });

  // Mutation proof: replacing `run(mv.value)` with `run(initial)` makes this RED.
  expect(received).toEqual([100]);

  unsubscribe();
  store.destroy();
});
