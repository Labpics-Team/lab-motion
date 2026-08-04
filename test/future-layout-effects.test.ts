/**
 * test/future-layout-effects.test.ts — RED: постоянное число effects и
 * active-phase граница на bounded virtualized fixture.
 *
 * Спека: «ПОСТОЯННОЕ ЧИСЛО EFFECTS», «VIRTUALIZATION», «ACTIVE-PHASE
 * ГРАНИЦА»; RED-Фаза п.2 (10 000 строк создают per-element work), п.3
 * (active phase содержит target width writes), п.4 (descendant writes),
 * п.5 (layout/recalculate-style в controlled fixture), п.19 (effects count
 * растёт с числом строк).
 *
 * RED PROOF: на текущем main layout:'project' игнорируется — animate()
 * пишет width ЦЕЛИ на каждом кадре rAF-пути (recalc на запись), поэтому
 * active-phase ассерты красные по существу, а tier/effectCount-ассерты
 * падают через pick-хелперы заглушки (канон animate-facade-helpers).
 */

import { describe, expect, it } from 'vitest';
import * as animateMod from '../src/animate/index.js';
import * as surface from '../src/future-layout/index.js';
import { makeClock, pickAnimate } from './animate-facade-helpers.js';
import { makeSurfaceWorld, pickSurfacePlan, type FutureLayoutControlsLike } from './future-layout-helpers.js';

const animate = pickAnimate(animateMod as unknown as Record<string, unknown>);
const planSurface = pickSurfacePlan(surface as unknown as Record<string, unknown>);

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function startTransition(world: ReturnType<typeof makeSurfaceWorld>, clock: ReturnType<typeof makeClock>): FutureLayoutControlsLike {
  return animate(
    world.viewport,
    { width: [240, 360] },
    {
      layout: 'project',
      spring: SPRING,
      requestFrame: clock.requestFrame,
      host: world.host,
      readPseudoModel: world.readPseudoModel,
    },
  ) as unknown as FutureLayoutControlsLike;
}

describe('постоянное число effects: 100 == 10 000 == 1 000 000 строк', () => {
  it('RED п.2/п.19: effectCount не зависит от logicalRows', async () => {
    const counts = [];
    for (const rows of [100, 10_000, 1_000_000]) {
      const world = makeSurfaceWorld(rows);
      const clock = makeClock();
      const controls = startTransition(world, clock);
      await controls.ready;
      counts.push(world.effects().length);
      controls.cancel();
    }
    // Ровно 5 native CSS-effects (group scale, old scale+opacity, new
    // scale+opacity) — постоянно при любом числе логических строк.
    expect(counts[0]).toBe(5);
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBe(counts[2]);
  });

  it('RED п.2: materialized строк bounded при 1 000 000 логических', () => {
    const world = makeSurfaceWorld(1_000_000);
    expect(world.materializedRows).toBeLessThanOrEqual(25);
    const plan = planSurface(SPRING, 240, 360);
    expect(plan.effectCount).toBeLessThanOrEqual(5);
  });
});

describe('active-phase граница: только transform/opacity, ни одной layout-записи', () => {
  it('RED п.3: active phase НЕ содержит width-записей цели', async () => {
    const world = makeSurfaceWorld(100);
    const clock = makeClock();
    const controls = startTransition(world, clock);
    await controls.ready;

    const widthBefore = world.writes('viewport', 'width').length;
    clock.step(16);
    clock.step(16);
    clock.step(16);
    const widthDuring = world.writes('viewport', 'width').length;

    expect(widthDuring).toBe(widthBefore);
  });

  it('RED п.4: active phase НЕ содержит descendant-записей', async () => {
    const world = makeSurfaceWorld(100);
    const clock = makeClock();
    const controls = startTransition(world, clock);
    // Гард RED по правильной причине: без Future Layout ready нет вообще,
    // и «нет descendant-записей» было бы ложно-зелёным на direct-width main.
    expect(controls.ready).toBeInstanceOf(Promise);
    await controls.ready;

    clock.step(16);
    clock.step(16);
    for (let i = 0; i < world.rows.length; i++) {
      expect(world.writes(`row-${i}`)).toEqual([]);
    }
  });

  it('RED п.5: active phase НЕ вызывает layout/recalculate-style в controlled fixture', async () => {
    const world = makeSurfaceWorld(100);
    const clock = makeClock();
    const controls = startTransition(world, clock);
    await controls.ready;

    const recalcsBefore = world.recalcs().length;
    clock.step(16);
    clock.step(16);
    clock.step(16);
    expect(world.recalcs().length).toBe(recalcsBefore);
  });
});
