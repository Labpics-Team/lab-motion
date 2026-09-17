import { describe, expect, it } from 'vitest';
import { captureSmart } from '../src/smart/index.js';
import { detach, makeClock, makeSmartWorld } from './smart-helpers.js';

function overlappingGhosts(initialInert = false) {
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
  focusable.inert = initialInert;
  const inner = world.root('inner', { x: 0, y: 0, width: 50, height: 50 }, {
    children: [ghost],
    computed: { position: 'static' },
  });
  const outer = world.root('outer', { x: 0, y: 0, width: 100, height: 100 }, {
    children: [inner],
    computed: { position: 'static' },
  });
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

  return { ghost, focusable, inner, outer, innerFlight, outerFlight };
}

function expectOriginalStyles(ghost: ReturnType<typeof overlappingGhosts>['ghost']): void {
  expect(Object.fromEntries(ghost.inline)).toMatchObject({
    position: 'relative',
    left: '7px',
    top: '8px',
    width: '9px',
    height: '10px',
    opacity: '0.7',
  });
}

describe('./smart shared ghost lease', () => {
  it('не восстанавливает pinned surface до последнего owner', () => {
    const { ghost, focusable, outer, innerFlight, outerFlight } = overlappingGhosts();

    expect(ghost.inline.get('position')).toBe('absolute');
    expect(focusable.inert).toBe(true);
    innerFlight.cancel();

    // Первый release не имеет права разрушить физическую поверхность второго owner.
    expect(outer.children).toContain(ghost);
    expect(ghost.inline.get('position')).toBe('absolute');
    expect(focusable.inert).toBe(true);

    outerFlight.cancel();
    expectOriginalStyles(ghost);
    expect(focusable.inert).toBe(false);
  });

  it('сохраняет физический ghost при обратном release-order и initial inert=true', () => {
    const { ghost, focusable, inner, outer, innerFlight, outerFlight } = overlappingGhosts(true);

    expect(ghost.inline.get('position')).toBe('absolute');
    expect(focusable.inert).toBe(true);
    outerFlight.cancel();

    // Простого refcount styles/inert недостаточно: releasing controller не может
    // физически удалить DOM identity, пока другой owner всё ещё держит visual lifetime.
    expect(inner.children.includes(ghost) || outer.children.includes(ghost)).toBe(true);
    expect(ghost.inline.get('position')).toBe('absolute');
    expect(focusable.inert).toBe(true);

    innerFlight.cancel();
    expect(inner.children).not.toContain(ghost);
    expect(outer.children).not.toContain(ghost);
    expectOriginalStyles(ghost);
    expect(focusable.inert).toBe(true);
  });
});
