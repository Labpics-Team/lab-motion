import { describe, expect, it } from 'vitest';
import { springStore } from '../src/svelte/index.js';

describe('Svelte Bindings', () => {
  it('springStore has subscribe, set, and update', async () => {
    const store = springStore(100, { mass: 1, stiffness: 100, damping: 10 });
    expect(store.subscribe).toBeTypeOf('function');
    expect(store.set).toBeTypeOf('function');
    expect(store.update).toBeTypeOf('function');

    const vals: any[] = [];
    const unsubscribe = store.subscribe((v) => {
      vals.push(v);
    });

    expect(vals).toEqual([100]);

    await store.set(200);
    expect(vals.length).toBeGreaterThan(1);
    expect(vals[vals.length - 1]).toBe(200);

    unsubscribe();
  });

  it('springStore update computes next value and animates', async () => {
    const store = springStore(100);
    const vals: any[] = [];
    const unsubscribe = store.subscribe((v) => {
      vals.push(v);
    });

    await store.update((n) => (n as number) + 50);
    expect(vals[vals.length - 1]).toBe(150);

    unsubscribe();
  });
});
