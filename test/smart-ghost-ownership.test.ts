import { describe, expect, it } from 'vitest';
import { captureSmart } from '../src/smart/index.js';
import { detach, makeClock, makeSmartWorld } from './smart-helpers.js';

describe('./smart ghost ownership isolation', () => {
  it('hides a live ghost only from its owning root', () => {
    const world = makeSmartWorld();
    const ghost = world.el('ghost', { x: 10, y: 10, width: 10, height: 10 }, { key: 'g' });
    const inner = world.root('inner', { x: 0, y: 0, width: 50, height: 50 }, { children: [ghost] });
    const outer = world.root('outer', { x: 0, y: 0, width: 100, height: 100 }, { children: [inner] });
    const clock = makeClock();
    const options = { requestFrame: clock.requestFrame, getScroll: world.getScroll, getComputedStyle: world.getComputedStyle };

    const before = captureSmart(inner, options);
    detach(inner, ghost);
    const flight = before.animate();

    expect(captureSmart(inner, options).size).toBe(0);
    expect(captureSmart(outer, options).size).toBe(1);

    flight.cancel();
  });
});
