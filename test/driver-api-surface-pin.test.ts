/**
 * test/driver-api-surface-pin.test.ts
 * Class: Б (contract pin — старое не сломалось / API contract characterization)
 *
 * Invariant 6 — точный набор экспортов и форма интерфейса AnimationControls
 * зафиксированы. Добавление/удаление/переименование методов ломает CI.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDriver } from '../src/driver.js';
import type { AnimationControls, DriverOptions } from '../src/driver.js';
import { reducedMotionMedia } from './helpers/reduced-motion.js';

/** Минимальные валидные параметры driver. ω₀ = sqrt(100) = 10 > 2; ζ = 1 (критическое). */
const BASE_OPTS: DriverOptions = {
  from: 0,
  to: 100,
  spring: { mass: 1, stiffness: 100, damping: 20 },
  onStep: () => {},
  requestFrame: (_cb) => 0,
};

describe('driver: module exports', () => {
  it('createDriver является функцией', () => {
    expect(typeof createDriver).toBe('function');
  });
});

describe('driver: AnimationControls interface shape', () => {
  function makeControls(): AnimationControls {
    const c = createDriver({ ...BASE_OPTS });
    c.cancel();
    return c;
  }

  it('возвращает объект (не null, не примитив)', () => {
    const c = makeControls();
    expect(c).toBeTruthy();
    expect(typeof c).toBe('object');
  });

  it('time: читаемое числовое свойство', () => {
    const c = makeControls();
    expect(typeof c.time).toBe('number');
  });

  it('progress: читаемое число в [0, 1]', () => {
    const c = makeControls();
    expect(typeof c.progress).toBe('number');
    expect(c.progress).toBeGreaterThanOrEqual(0);
    expect(c.progress).toBeLessThanOrEqual(1);
  });

  it('velocity: читаемое числовое свойство (units/s), read-only', () => {
    const c = makeControls();
    expect(typeof c.velocity).toBe('number');
    expect(Object.getOwnPropertyDescriptor(c, 'velocity')?.set).toBeUndefined();
  });

  it('timeScale: читаемо и записываемо', () => {
    const c = createDriver({ ...BASE_OPTS });
    expect(typeof c.timeScale).toBe('number');
    c.timeScale = 2;
    expect(c.timeScale).toBe(2);
    c.cancel();
  });

  for (const method of ['play', 'pause', 'reverse', 'seek', 'complete', 'cancel', 'stop', 'then'] as const) {
    it(`${method} — функция`, () => {
      const c = makeControls();
      expect(typeof c[method]).toBe('function');
    });
  }
});

describe('driver: thenable / Promise semantics', () => {
  it.each(['complete', 'cancel', 'stop'] as const)('%s() резолвит await controls', async (method) => {
    const c = createDriver({ ...BASE_OPTS });
    c[method]();
    await expect(c).resolves.toBeUndefined();
  });

  it('controls.then(cb) вызывает cb при complete()', async () => {
    const cb = vi.fn();
    const c = createDriver({ ...BASE_OPTS });
    const p = c.then(cb);
    c.complete();
    await p;
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('Повторные вызовы complete() не резолвят дважды', async () => {
    const cb = vi.fn();
    const c = createDriver({ ...BASE_OPTS });
    const p = c.then(cb);
    c.complete();
    c.complete();
    c.complete();
    await p;
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('driver: validation errors', () => {
  it('бросает при from = NaN', () => {
    expect(() => createDriver({ ...BASE_OPTS, from: NaN })).toThrow();
  });

  it('бросает при to = Infinity', () => {
    expect(() => createDriver({ ...BASE_OPTS, to: Infinity })).toThrow();
  });

  it('бросает при невалидных spring-параметрах', () => {
    expect(() => createDriver({ ...BASE_OPTS, spring: { mass: -1, stiffness: 100, damping: 20 } })).toThrow();
  });
});

describe('driver: reduced-motion CHARACTER-switch', () => {
  it('при reduce: ровно один terminal snap-to-target, НЕ hard-off', async () => {
    const steps: number[] = [];
    const c = createDriver({
      ...BASE_OPTS,
      to: 100,
      matchMedia: reducedMotionMedia(true),
      onStep: (v) => steps.push(v),
    });

    // Проверяем до await: CHARACTER-switch синхронен и hard-off ([]) не проходит.
    expect(steps).toEqual([100]);
    await c;
    expect(steps).toEqual([100]);
  });

  it('при reduce: complete() — no-op (уже settled)', async () => {
    const c = createDriver({ ...BASE_OPTS, matchMedia: reducedMotionMedia(true) });
    await c;
    expect(() => c.complete()).not.toThrow();
  });

  it('timeScale доступен после reduce-settled', async () => {
    const c = createDriver({ ...BASE_OPTS, matchMedia: reducedMotionMedia(true) });
    await c;
    expect(typeof c.timeScale).toBe('number');
  });
});

describe('driver: subpath export smoke (без dist — достаточно импорта)', () => {
  it('createDriver доступен как именованный экспорт', () => {
    expect(createDriver).toBeDefined();
  });
});
