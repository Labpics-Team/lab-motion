/**
 * test/solid.test.ts — Solid-биндинг (subpath ./solid, S19).
 * Классы: А (жизненный цикл/анимация на реальном solid-js, headless createRoot)
 * + В (reduced-motion характер) + Д (mutation-хуки задокументированы в шапке).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый блок своим ассертом.
 * Mutation-proof: убрать reduced-ветку → «снап без пружины» RED; не подписать
 * onChange → «доезжает до цели» RED; потерять onCleanup-регистрацию →
 * «dispose корня глушит анимацию» RED; сломать getOwner-гард → вызов вне
 * корня падает предупреждением/ошибкой вместо тихой работы.
 *
 * Solid используется НАСТОЯЩИЙ (devDep): createSignal/createRoot работают
 * headless в node — сильнее мока.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createRoot } from 'solid-js';
import * as solid from '../src/solid/index.js';
import { createMotionValue, createSpring } from '../src/solid/index.js';

function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handle = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    drainAll(max = 3000): void {
      let i = 0;
      while (queue.length > 0 && i++ < max) {
        const cb = queue.shift()!;
        clock += dtMs;
        cb(clock);
      }
    },
  };
}

const SPRING = { mass: 1, stiffness: 200, damping: 26 };

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('solid: createSpring — анимация на реальных сигналах', () => {
  it('стартует с initial, доезжает до цели по виртуальным кадрам', () => {
    const vc = makeVirtualClock();
    createRoot((dispose) => {
      const [x, setX] = createSpring(0, SPRING, 'instant', vc.requestFrame);
      expect(x()).toBe(0);
      setX(100);
      vc.drainAll();
      expect(Math.abs(x() - 100)).toBeLessThan(0.5);
      dispose();
    });
  });

  it('повторный setTarget mid-flight подхватывается (значение продолжает движение к новой цели)', () => {
    const vc = makeVirtualClock();
    createRoot((dispose) => {
      const [x, setX] = createSpring(0, SPRING, 'instant', vc.requestFrame);
      setX(100);
      vc.drainAll(10); // недоехал
      const midway = x();
      expect(midway).toBeGreaterThan(0);
      expect(midway).toBeLessThan(100);
      setX(-50);
      vc.drainAll();
      expect(Math.abs(x() - -50)).toBeLessThan(0.5);
      dispose();
    });
  });

  it('dispose корня глушит анимацию (onCleanup зарегистрирован)', () => {
    const vc = makeVirtualClock();
    let x!: () => number;
    let setX!: (t: number) => void;
    createRoot((dispose) => {
      [x, setX] = createSpring(0, SPRING, 'instant', vc.requestFrame);
      dispose();
    });
    setX(100); // после dispose — no-op, не бросает
    vc.drainAll();
    expect(x()).toBe(0);
  });

  it('явный destroy работает и вне реактивного корня (без предупреждений/утечек)', () => {
    const vc = makeVirtualClock();
    const [x, setX, destroy] = createSpring(5, SPRING, 'instant', vc.requestFrame);
    setX(50);
    vc.drainAll();
    expect(Math.abs(x() - 50)).toBeLessThan(0.5);
    destroy();
    setX(999);
    vc.drainAll();
    expect(Math.abs(x() - 50)).toBeLessThan(0.5); // после destroy цель не принимается
  });

  it('destroy держится и в reduced-ветке: снап после destroy не проходит', () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const vc = makeVirtualClock();
    const [x, setX, destroy] = createSpring(7, SPRING, 'instant', vc.requestFrame);
    destroy();
    setX(100); // reduced-путь пишет в сигнал напрямую — обязан уважать destroy
    expect(x()).toBe(7);
  });

  it('дефолтный spring исполняется: доезжает без явных параметров', () => {
    const vc = makeVirtualClock();
    const [x, setX, destroy] = createSpring(0, undefined, 'instant', vc.requestFrame);
    setX(100);
    vc.drainAll();
    expect(Math.abs(x() - 100)).toBeLessThan(0.5);
    destroy();
  });

  it('двойной destroy идемпотентен (не бросает, состояние стабильно)', () => {
    const vc = makeVirtualClock();
    const [x, , destroy] = createSpring(3, SPRING, 'instant', vc.requestFrame);
    destroy();
    expect(() => destroy()).not.toThrow();
    expect(x()).toBe(3);
  });

  it('reduced-путь не пропускает non-finite в сигнал (MotionParamError, зеркало ядра)', () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const vc = makeVirtualClock();
    const [x, setX, destroy] = createSpring(0, SPRING, 'instant', vc.requestFrame);
    expect(() => setX(NaN)).toThrow();
    expect(() => setX(Infinity)).toThrow();
    expect(x()).toBe(0); // сигнал не загрязнён
    destroy();
  });

  it('reduced-motion: снап к цели без пружины (характер, не выключение)', () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const vc = makeVirtualClock();
    createRoot((dispose) => {
      const [x, setX] = createSpring(0, SPRING, 'instant', vc.requestFrame);
      setX(100);
      expect(x()).toBe(100); // синхронно, без кадров
      dispose();
    });
  });
});

describe('solid: createMotionValue', () => {
  it('dispose корня разрушает сам MotionValue (не только подписку — нет утечки кадров)', () => {
    const vc = makeVirtualClock();
    let mv!: import('../src/motion-value.js').MotionValue;
    createRoot((dispose) => {
      [mv] = createMotionValue(0, SPRING, vc.requestFrame);
      dispose();
    });
    const seen: number[] = [];
    mv.onChange((v) => seen.push(v));
    mv.setTarget(10);
    vc.drainAll();
    // разрушенный MotionValue не анимирует: допускается только немедленный
    // эмит текущего значения при подписке, движения к 10 быть не должно
    expect(seen.every((v) => Math.abs(v) < 0.001)).toBe(true);
  });

  it('отдаёт живой MotionValue + dispose', () => {
    const vc = makeVirtualClock();
    const [mv, dispose] = createMotionValue(0, SPRING, vc.requestFrame);
    const seen: number[] = [];
    mv.onChange((v) => seen.push(v));
    mv.setTarget(10);
    vc.drainAll();
    expect(Math.abs(seen[seen.length - 1]! - 10)).toBeLessThan(0.5);
    dispose();
  });
});

describe('bindings-api-surface-pin: solid', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(solid).sort()).toEqual(['createMotionValue', 'createSpring']);
  });
});
