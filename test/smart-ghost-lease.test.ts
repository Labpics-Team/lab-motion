import { describe, expect, it } from 'vitest';
import { captureSmart } from '../src/smart/index.js';
import { detach, makeClock, makeSmartWorld } from './smart-helpers.js';

function overlappingGhosts() {
  const world = makeSmartWorld();
  const ghost = world.el(
    'ghost',
    { x: 10, y: 10, width: 10, height: 10 },
    {
      key: 'g',
      inline: {
        position: 'relative',
        left: '7px',
        top: '8px',
        width: '9px',
        height: '10px',
        opacity: '0.7',
      },
    },
  );
  const focusable = ghost as typeof ghost & { inert: boolean };
  focusable.inert = false;
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

  // Чужой ghost остаётся видимым independent outer controller, как требует
  // ownership-oracle соседнего smart-ghost-ownership.test.ts.
  const outerBefore = captureSmart(outer, options);
  detach(inner, ghost);
  const outerFlight = outerBefore.animate();

  return { ghost, focusable, innerFlight, outerFlight };
}

describe('./smart shared ghost lease', () => {
  it('не восстанавливает pinned styles до последнего overlapping owner', () => {
    const { ghost, innerFlight, outerFlight } = overlappingGhosts();

    expect(ghost.inline.get('position')).toBe('absolute');
    innerFlight.cancel();

    // Первый release не имеет права разрушить физическую поверхность второго owner.
    expect(ghost.inline.get('position')).toBe('absolute');

    outerFlight.cancel();
    expect(Object.fromEntries(ghost.inline)).toMatchObject({
      position: 'relative',
      left: '7px',
      top: '8px',
      width: '9px',
      height: '10px',
      opacity: '0.7',
    });
  });

  it('держит ghost inert до последнего owner и точно восстанавливает initial bit', () => {
    const { focusable, innerFlight, outerFlight } = overlappingGhosts();

    // JOURNEY-01: live visual ghost не должен оставаться в focus lifetime.
    expect(focusable.inert).toBe(true);

    innerFlight.cancel();
    expect(focusable.inert).toBe(true);

    outerFlight.cancel();
    expect(focusable.inert).toBe(false);
  });
});
