/**
 * test/future-layout-api.test.ts — RED: animate(..., { layout: 'project' }).
 *
 * Спека: «ПОЛЬЗОВАТЕЛЬСКИЙ РЕЗУЛЬТАТ», «ТОЧНЫЙ ПЕРВЫЙ PRODUCTION-SLICE»,
 * RED-Фаза п.1 («width direct animation вызывает layout path вместо Future
 * Layout») и п.13 («cancel() откатывает final DOM»).
 *
 * RED PROOF: на текущем main `layout` молча игнорируется — animate()
 * исполняет прямой width-tween и возвращает обычные AnimateControls без
 * committed/ready/state/tier; cancel() останавливает tween в промежуточной
 * позиции вместо раскрытия committed DOM. Каждый тест падает СВОИМ
 * ассертом (RED-канон test/animate-facade-helpers.ts:9-31).
 */

import { describe, expect, it } from 'vitest';
import * as animateMod from '../src/animate/index.js';
import { fakeEl, makeClock, pickAnimate } from './animate-facade-helpers.js';
import type { FutureLayoutControlsLike } from './future-layout-helpers.js';

const animate = pickAnimate(animateMod as unknown as Record<string, unknown>);

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function projectOptions(clock: ReturnType<typeof makeClock>): Record<string, unknown> {
  return {
    layout: 'project',
    spring: SPRING,
    requestFrame: clock.requestFrame,
  };
}

describe('animate({ width: [240, 360] }, { layout: "project" }) — Future Layout lifecycle', () => {
  it('RED п.1: width [from,to] + layout:"project" идёт по Future Layout, а не direct-width', () => {
    const target = fakeEl({ width: '240px' });
    const clock = makeClock();
    const controls = animate(
      target.el,
      { width: [240, 360] },
      projectOptions(clock),
    ) as unknown as FutureLayoutControlsLike;

    // Lifecycle контракт FutureLayoutControls: committed/ready/finished/state/tier.
    expect(controls.committed).toBeInstanceOf(Promise);
    expect(controls.ready).toBeInstanceOf(Promise);
    expect(controls.finished).toBeInstanceOf(Promise);
    expect(controls.state).toBe('capturing-old');
    expect(['future-layout-native', 'future-layout-snap', 'future-layout-projection']).toContain(
      controls.tier,
    );
  });

  it('RED п.1: после committed конечный DOM уже 360px, snapshots ещё активны', async () => {
    const target = fakeEl({ width: '240px' });
    const clock = makeClock();
    const controls = animate(
      target.el,
      { width: [240, 360] },
      projectOptions(clock),
    ) as unknown as FutureLayoutControlsLike;

    await controls.committed;
    expect(target.el.style.getPropertyValue('width')).toBe('360px');
    expect(controls.state).toMatch(/capturing-new|running/);
  });

  it('RED п.1: active phase не пишет width — только постоянное число transform/opacity effects', async () => {
    const target = fakeEl({ width: '240px' });
    const clock = makeClock();
    const controls = animate(
      target.el,
      { width: [240, 360] },
      projectOptions(clock),
    ) as unknown as FutureLayoutControlsLike;

    await controls.ready;
    const before = target.writes.filter((w) => w.prop === 'width').length;
    clock.step(16);
    clock.step(16);
    const during = target.writes.filter((w) => w.prop === 'width').length;
    expect(during).toBe(before); // active phase: ноль width-записей
    expect(target.animateCalls.length).toBeGreaterThan(0);
    expect(target.animateCalls.length).toBeLessThanOrEqual(5);
  });

  it('RED п.13: cancel() раскрывает committed DOM и НЕ откатывает commit', async () => {
    const target = fakeEl({ width: '240px' });
    const clock = makeClock();
    const controls = animate(
      target.el,
      { width: [240, 360] },
      projectOptions(clock),
    ) as unknown as FutureLayoutControlsLike;

    await controls.committed;
    clock.step(16); // активная фаза началась
    controls.cancel();
    expect(controls.state).toBe('canceled');
    // Commit конечного состояния не откатывается:
    expect(target.el.style.getPropertyValue('width')).toBe('360px');
    await controls.finished;
  });
});
