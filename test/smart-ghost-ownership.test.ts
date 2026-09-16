import { describe, expect, it } from 'vitest';
import { captureSmart } from '../src/smart/index.js';
import { detach, makeClock, makeSmartWorld } from './smart-helpers.js';

describe('./smart ghost ownership isolation', () => {
  it('скрывает живой ghost только от владеющего root', () => {
    const world = makeSmartWorld();
    const ghost = world.el('ghost', { x: 10, y: 10, width: 10, height: 10 }, { key: 'g' });
    const inner = world.root('inner', { x: 0, y: 0, width: 50, height: 50 }, { children: [ghost] });
    const outer = world.root('outer', { x: 0, y: 0, width: 100, height: 100 }, { children: [inner] });
    const clock = makeClock();
    const options = {
      requestFrame: clock.requestFrame,
      getScroll: world.getScroll,
      getComputedStyle: world.getComputedStyle,
    };

    const before = captureSmart(inner, options);
    detach(inner, ghost);
    const flight = before.animate();

    expect(captureSmart(inner, options).size).toBe(0);
    expect(captureSmart(outer, options).size).toBe(1);

    flight.cancel();
  });

  it('сохраняет одновременное владение одним ghost у вложенных контроллеров', () => {
    const world = makeSmartWorld();
    const ghost = world.el('ghost', { x: 10, y: 10, width: 10, height: 10 }, { key: 'g' });
    const inner = world.root('inner', { x: 0, y: 0, width: 50, height: 50 }, { children: [ghost] });
    const outer = world.root('outer', { x: 0, y: 0, width: 100, height: 100 }, { children: [inner] });
    const clock = makeClock();
    const options = {
      requestFrame: clock.requestFrame,
      getScroll: world.getScroll,
      getComputedStyle: world.getComputedStyle,
    };

    const innerBefore = captureSmart(inner, options);
    detach(inner, ghost);
    const innerFlight = innerBefore.animate();

    // Чужой живой ghost остаётся обычным keyed-узлом для независимого outer controller.
    expect(captureSmart(outer, options).size).toBe(1);
    const outerBefore = captureSmart(outer, options);

    // Тот же DOM identity теперь независимо становится exit-ghost outer controller,
    // пока inner controller всё ещё жив и продолжает владеть своей записью.
    detach(inner, ghost);
    const outerFlight = outerBefore.animate();

    // Outer обязан скрывать уже свой ghost. Именно этот witness сделал single-owner
    // WeakMap representation из #424 красной (expected 0, received 1).
    expect(captureSmart(outer, options).size).toBe(0);

    outerFlight.cancel();
    innerFlight.cancel();
  });
});
