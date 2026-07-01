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
 *
 * ── RED PROOF (mutation 1) ─────────────────────────────────────────────────────
 * Убрать ветку `else if (reduce) { settle(to); }` из driver.ts (нет reduce-snap):
 *   → нормальный multi-frame путь → scheduleFrame вызывается → steps.length===0
 *     до await (async, не sync) → тест `steps.length===1` НЕМЕДЛЕННО = RED.
 *   → steps.length>=2 после await → тест `===1` после await тоже RED.
 *
 * ── RED PROOF (mutation 2) ────────────────────────────────────────────────────
 * Изменить на hard-off (вообще не вызывать onStep при reduce: settle без onStep):
 *   → steps.length===0 ДО и ПОСЛЕ await → тест `===1` = RED.
 *
 * ── RED PROOF (mutation 3) ────────────────────────────────────────────────────
 * Swap `onStep(to)` на `onStep(from)` (snap к неверному значению):
 *   → steps[0]===0 (from) → тест `steps[0]===100` = RED.
 *
 * Почему `===1` (не `>=1`) различает reduce от normal:
 *   reduce path: settle() вызывается СИНХРОННО в теле конструктора →
 *     steps.length===1 немедленно, requestFrame НЕ вызывается (_settled=true
 *     не даёт ensureLoop() стартовать).
 *   normal path: ensureLoop() → scheduleFrame() → setTimeout(tick,0) async →
 *     steps.length===0 в момент синхронной проверки ДО await.
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
  /**
   * Mutation 1 RED: убрать reduce-snap → normal multi-frame → steps.length!==1.
   * Mutation 2 RED: hard-off → steps.length===0 → ===1 fails.
   * Mutation 3 RED: onStep(from) → steps[0]===0 → ===100 fails.
   */
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

    // CHARACTER-switch: ровно один вызов (отличает от нормального multi-frame).
    expect(steps.length, 'snap: ровно 1 шаг').toBe(1);
    expect(steps[0], 'snap значение = to').toBe(100);
  });

  /**
   * Mutation 1 RED: убрать reduce-snap → scheduleFrame ВЫЗЫВАЕТСЯ (ensureLoop) →
   *   rafCalled.length>=1 → тест `===0` fails.
   *   steps.length===0 до await → тест `===1` fails.
   * Mutation 2 RED: hard-off → steps.length===0 до await → fails.
   * Mutation 3 RED: onStep(from) → steps[0]===0 → fails.
   *
   * Это самый сильный RED-proof: проверяется ДО первого await —
   * синхронность гарантируется тем, что проверка выполнена до любой
   * микрозадачи/макрозадачи (setTimeout(tick,0) ещё не сработал).
   */
  it('snap-to-target СИНХРОНЕН: steps.length===1 ДО await, rAF не вызывается', async () => {
    const steps: number[] = [];
    const rafCalled: number[] = []; // сколько раз requestFrame вызван до await
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => { rafCalled.push(1); return 0; },
    });

    // ─── Синхронная проверка (ДО любого await/rAF/setTimeout) ───────────────
    // reduce-snap вызывает settle() синхронно в конструкторе → onStep(to) уже вызван.
    // Если бы это был normal-path: scheduleFrame вызван, steps пуст, rafCalled.length>=1.
    expect(steps.length, 'snap до await: ровно 1 шаг').toBe(1);
    expect(steps[0], 'snap до await: значение = to (100)').toBe(100);
    expect(rafCalled.length, 'при reduce rAF не вызывается').toBe(0);

    await c;

    // ─── После await: состояние не изменилось ────────────────────────────────
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

// ─── 3. Дифференциальный тест CHARACTER-switch vs. hard-off vs. normal ────────

describe('driver-reduced-motion: differential CHARACTER-switch vs hard-off vs normal', () => {
  /**
   * Доказывает, что reduce-path ОТЛИЧИМ от:
   *   (a) hard-off:   steps.length===0 (не вызывает onStep)
   *   (b) normal:     steps.length>=2, rAF вызван, не синхронно
   *
   * Все проверки — СИНХРОННЫЕ (до await), это единственное место, где
   * три режима строго различимы без зависимости от timing.
   */
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

    // CHARACTER-switch: ровно 1 шаг, синхронно, rAF не вызван.
    // Mutation 1 (нет reduce-snap): steps===0, rafCalled===1 → оба ассерта RED.
    // Mutation 2 (hard-off):        steps===0 → RED.
    // Mutation 3 (onStep(from)):     steps[0]===0 → RED.
    expect(steps.length, 'reduce: ровно 1 шаг (не 0, не >=2)').toBe(1);
    expect(steps[0], 'reduce snap: значение === to').toBe(100);
    expect(rafCalled.length, 'reduce: rAF не вызывается (синхронный snap)').toBe(0);
  });

  it('normal (no-preference): rAF вызывается, steps пуст ДО первого tick', () => {
    const steps: number[] = [];
    const rafCalled: number[] = [];
    createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: makeNoReduceMedia(),
      onStep: (v) => steps.push(v),
      requestFrame: (_cb) => { rafCalled.push(1); return 0; },
    });

    // Normal path: ensureLoop() → scheduleFrame вызван ДО любого тика.
    // В момент синхронной проверки steps пуст (tick ещё не вызван).
    expect(steps.length, 'normal: 0 шагов до первого tick').toBe(0);
    expect(rafCalled.length, 'normal: rAF вызван ровно 1 раз для старта цикла').toBe(1);
  });
});
