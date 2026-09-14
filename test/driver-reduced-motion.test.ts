/**
 * test/driver-reduced-motion.test.ts
 * Классы: А (unit CHARACTER-switch) + differential (reduce vs normal vs hard-off)
 *         + Д (mutation RED-proof обеих мутаций).
 *
 * Invariant 4 — reduced-motion: CHARACTER-switch.
 *
 * Требование: при prefers-reduced-motion: reduce driver переключает
 * ХАРАКТЕР анимации — РОВНО ОДИН СИНХРОННЫЙ snap-to-target (до rAF/setTimeout),
 * а НЕ hard-off (steps.length===0) и НЕ нормальная multi-frame (steps.length>=2).
 * Shared query-sensitive seam дополнительно делает неверный media query RED.
 */

import { describe, expect, it } from 'vitest';
import { createDriver } from '../src/driver.js';
import { reducedMotionMedia } from './helpers/reduced-motion.js';

const makeReduceMedia = () => reducedMotionMedia(true);
const makeNoReduceMedia = () => reducedMotionMedia(false);
const STD_SPRING = { mass: 1, stiffness: 100, damping: 20 };

describe('driver-reduced-motion: CHARACTER-switch (reduce=true)', () => {
  it('snap-to-target: onStep вызывается РОВНО 1 раз с финальным to', async () => {
    const steps: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => 0,
    });
    await c;
    expect(steps.length, 'snap: ровно 1 шаг').toBe(1);
    expect(steps[0], 'snap значение = to').toBe(100);
  });

  it('snap-to-target СИНХРОНЕН: steps.length===1 ДО await, rAF не вызывается', async () => {
    const steps: number[] = [];
    const rafCalled: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => { rafCalled.push(1); return 0; },
    });

    expect(steps.length, 'snap до await: ровно 1 шаг').toBe(1);
    expect(steps[0], 'snap до await: значение = to (100)').toBe(100);
    expect(rafCalled.length, 'при reduce rAF не вызывается').toBe(0);

    await c;
    expect(steps.length, 'после await: всё ещё ровно 1 шаг').toBe(1);
    expect(steps[0], 'после await: значение = to').toBe(100);
    expect(rafCalled.length, 'rAF не вызывался и после await').toBe(0);
  });

  it('не является hard-off: контрол всё равно создаётся', async () => {
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: () => {},
      requestFrame: (_cb) => 0,
    });
    expect(c).toBeTruthy();
    await c;
  });

  it('Promise резолвится немедленно (без ожидания rAF)', async () => {
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: () => {},
      requestFrame: (_cb) => 0,
    });
    await expect(c).resolves.toBeUndefined();
  });

  it('complete() после reduce-settled — no-op, не бросает', async () => {
    const c = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: () => {},
      requestFrame: (_cb) => 0,
    });
    await c;
    expect(() => c.complete()).not.toThrow();
  });

  it('cancel() после reduce-settled — no-op, не бросает', async () => {
    const c = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: () => {},
      requestFrame: (_cb) => 0,
    });
    await c;
    expect(() => c.cancel()).not.toThrow();
  });

  it('seek() после reduce-settled — no-op (нет дополнительных эмитов)', async () => {
    const steps: number[] = [];
    const c = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => 0,
    });
    await c;
    const countBefore = steps.length;
    c.seek(0.5);
    expect(steps.length, 'seek() после settled — no-op').toBe(countBefore);
  });

  it('onStep эмитирует только конечное значение (CHARACTER-switch, не NaN/Infinity)', async () => {
    const steps: number[] = [];
    const c = createDriver({
      from: -500,
      to: 500,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => 0,
    });
    await c;
    expect(steps).toEqual([500]);
    expect(steps.every(Number.isFinite)).toBe(true);
  });

  it('progress === 1 после reduce-settle', async () => {
    const c = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: () => {},
      requestFrame: (_cb) => 0,
    });
    await c;
    expect(c.progress).toBe(1);
  });
});

describe('driver-reduced-motion: нормальная анимация (reduce=false)', () => {
  it('multi-frame анимация при no-preference: несколько вызовов onStep', async () => {
    const steps: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: makeNoReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => 0,
    });
    await c;

    expect(steps.length, 'нормальная анимация: больше 1 шага').toBeGreaterThanOrEqual(2);
    expect(steps.at(-1), 'финальный шаг = to').toBe(100);
    expect(steps.every(Number.isFinite)).toBe(true);
  }, 10_000);

  it('нормальная анимация: без matchMedia → SSR-safe (не бросает)', async () => {
    const steps: number[] = [];
    const c = createDriver({
      from: 0,
      to: 10,
      spring: STD_SPRING,
      matchMedia: undefined,
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => 0,
    });
    await c;
    expect(steps.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

describe('driver-reduced-motion: differential CHARACTER-switch vs hard-off vs normal', () => {
  it('reduce: ровно 1 синхронный snap — не hard-off (0) и не normal (async/>=2)', () => {
    const steps: number[] = [];
    const rafCalled: number[] = [];
    createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => { rafCalled.push(1); return 0; },
    });
    expect(steps).toEqual([100]);
    expect(rafCalled).toEqual([]);
  });

  it('normal (no-preference): rAF вызывается, steps пуст ДО первого tick', () => {
    const steps: number[] = [];
    const rafCalled: number[] = [];
    const c = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeNoReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => { rafCalled.push(1); return 1; },
    });
    expect(steps.length, 'normal: 0 шагов до первого tick').toBe(0);
    expect(rafCalled.length, 'normal: rAF вызван ровно 1 раз для старта цикла').toBe(1);
    c.cancel();
  });
});
