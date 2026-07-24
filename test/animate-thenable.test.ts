/**
 * test/animate-thenable.test.ts — thenable-контролы фасада (DX-канон Motion/
 * driver): `await animate(...)` эквивалентен `await animate(...).finished`.
 */

import { describe, expect, it } from 'vitest';
import { animate } from '../src/animate/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const noReduce = () => ({ matches: false });

describe('./animate — thenable controls', () => {
  it('await animate(...) ждёт естественного завершения', async () => {
    const clock = makeClock();
    const target = fakeEl();
    const controls = animate(target.el, { opacity: [0, 1] }, {
      duration: 100,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    let settled = false;
    const waiter = (async () => {
      await controls;
      settled = true;
    })();
    expect(settled).toBe(false);
    clock.drain(16);
    await waiter;
    expect(settled).toBe(true);
  });

  it('then делегирует к finished (одна и та же семантика cancel-резолва)', async () => {
    const clock = makeClock();
    const target = fakeEl();
    const controls = animate(target.el, { opacity: 1 }, {
      duration: 400,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    controls.cancel();
    await expect(Promise.resolve(controls)).resolves.toBeUndefined();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('пустой список целей — await резолвится сразу (no-op канон)', async () => {
    await animate([], { opacity: 1 }, { duration: 100 });
  });
});
