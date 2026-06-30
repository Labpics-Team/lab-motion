/**
 * test/driver-reduced-motion.test.ts
 * Class: А (unit — где находится фича)
 *
 * Invariant 4 — reduced-motion: CHARACTER-switch.
 *
 * Требование: при prefers-reduced-motion: reduce driver переключает
 * ХАРАКТЕР анимации (мгновенный snap-to-target), а НЕ hard-off
 * (контрол всё равно создаётся, all methods callable, Promise резолвится).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Убрать `if (reduce) { onStep(to); settled; resolve() }` из driver.ts:
 *   → snap-to-target не происходит → `steps[steps.length-1] !== to` → RED.
 *
 * Изменить на hard-off (вообще не вызывать onStep при reduce):
 *   → `steps.length === 0` → RED (CHARACTER-switch требует хотя бы 1 вызова).
 *
 * ── MUTATION PROOF ────────────────────────────────────────────────────────────
 * Swap `onStep(to)` на `onStep(from)`:
 *   → `steps[steps.length-1] === 100` fails → RED.
 */

import { describe, expect, it } from 'vitest';
import { createDriver } from '../src/driver.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: true, // prefers-reduced-motion: reduce
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function makeNoReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: false, // no preference
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

const STD_SPRING = { mass: 1, stiffness: 100, damping: 20 };

// ─── 1. CHARACTER-switch (reduce=true) ────────────────────────────────────────

describe('driver-reduced-motion: CHARACTER-switch (reduce=true)', () => {
  it('snap-to-target: onStep вызывается минимум 1 раз с финальным to', async () => {
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

    // CHARACTER-switch: хотя бы один вызов, последний = to.
    expect(steps.length, 'onStep должен быть вызван хотя бы раз').toBeGreaterThanOrEqual(1);
    expect(steps[steps.length - 1], 'последний шаг = to').toBe(100);
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
    // Объект существует.
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
    // Если бы rAF был задействован — это зависело бы от setTimeout.
    // Resolve должен произойти быстро.
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
    for (const v of steps) {
      expect(Number.isFinite(v), `reduce emitted non-finite: ${v}`).toBe(true);
    }
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

// ─── 2. Нормальная анимация (reduce=false) ────────────────────────────────────

describe('driver-reduced-motion: нормальная анимация (reduce=false)', () => {
  it('multi-frame анимация при no-preference: несколько вызовов onStep', async () => {
    const steps: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: makeNoReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => 0, // non-draining → setTimeout fallback
    });
    await c;

    // Нормальная анимация: больше одного кадра.
    expect(steps.length, 'нормальная анимация: больше 1 шага').toBeGreaterThanOrEqual(2);
    expect(steps[steps.length - 1], 'финальный шаг = to').toBe(100);
    for (const v of steps) {
      expect(Number.isFinite(v), `non-finite emitted: ${v}`).toBe(true);
    }
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

// ─── 3. Дифференциальный тест CHARACTER-switch vs. hard-off ──────────────────

describe('driver-reduced-motion: differential CHARACTER-switch vs hard-off', () => {
  it('reduce: хотя бы 1 onStep (не hard-off) — нет vs. 0 шагов', () => {
    // Если бы это было hard-off, steps.length === 0.
    const steps: number[] = [];
    const c = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => 0,
    });
    // Немедленно settle (Promise синхронно resolved через then-микрозадачу).
    c.cancel(); // даже cancel не добавит шагов если уже settled.

    // CHARACTER-switch: onStep(to) вызван при создании driver.
    expect(steps.length).toBeGreaterThanOrEqual(1);
  });
});
