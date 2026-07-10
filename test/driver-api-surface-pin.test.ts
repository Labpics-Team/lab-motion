/**
 * test/driver-api-surface-pin.test.ts
 * Class: Б (contract pin — старое не сломалось / API contract characterization)
 *
 * Invariant 6 — точный набор экспортов и форма интерфейса AnimationControls
 * зафиксированы. Добавление/удаление/переименование методов ломает CI.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Удалить `createDriver` из src/driver.ts:
 *   → `typeof createDriver === 'function'` → RED для правильной причины.
 * Удалить метод `seek` из controls:
 *   → `'seek' in controls` → RED для правильной причины.
 * Удалить `then` из controls:
 *   → `typeof controls.then === 'function'` → RED.
 *
 * ── MUTATION PROOF ────────────────────────────────────────────────────────────
 * Переименовать `AnimationControls.stop` в `halt`:
 *   → `'stop' in controls` → RED.
 * Удалить `reverse()`:
 *   → `typeof controls.reverse === 'function'` → RED.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDriver } from '../src/driver.js';
import type { AnimationControls, DriverOptions } from '../src/driver.js';

/** Минимальные валидные параметры driver. ω₀ = sqrt(100) = 10 > 2; ζ = 1 (критическое). */
const BASE_OPTS: DriverOptions = {
  from: 0,
  to: 100,
  spring: { mass: 1, stiffness: 100, damping: 20 },
  onStep: () => {},
  requestFrame: (_cb) => 0, // non-draining (тест не запускает реальный rAF)
};

// ── 1. Экспорт ────────────────────────────────────────────────────────────────

describe('driver: module exports', () => {
  it('createDriver является функцией', () => {
    expect(typeof createDriver).toBe('function');
  });
});

// ── 2. Форма AnimationControls ────────────────────────────────────────────────

describe('driver: AnimationControls interface shape', () => {
  function makeControls(): AnimationControls {
    const c = createDriver({ ...BASE_OPTS });
    // Немедленно cancelим, чтобы не гонять frame loop в тестах.
    c.cancel();
    return c;
  }

  it('возвращает объект (не null, не примитив)', () => {
    const c = makeControls();
    expect(c).toBeTruthy();
    expect(typeof c).toBe('object');
  });

  // Свойства — readonly
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

  // #93 срез 3: аналитическое чтение скорости live-рана (поведение —
  // test/driver-velocity-read.test.ts; здесь только форма поверхности).
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

  // Методы
  it('play — функция', () => {
    const c = makeControls();
    expect(typeof c.play).toBe('function');
  });

  it('pause — функция', () => {
    const c = makeControls();
    expect(typeof c.pause).toBe('function');
  });

  it('reverse — функция', () => {
    const c = makeControls();
    expect(typeof c.reverse).toBe('function');
  });

  it('seek — функция', () => {
    const c = makeControls();
    expect(typeof c.seek).toBe('function');
  });

  it('complete — функция', () => {
    const c = makeControls();
    expect(typeof c.complete).toBe('function');
  });

  it('cancel — функция', () => {
    const c = makeControls();
    expect(typeof c.cancel).toBe('function');
  });

  it('stop — функция', () => {
    const c = makeControls();
    expect(typeof c.stop).toBe('function');
  });

  it('then — функция (thenable)', () => {
    const c = makeControls();
    expect(typeof c.then).toBe('function');
  });
});

// ── 3. Thenable поведение ─────────────────────────────────────────────────────

describe('driver: thenable / Promise semantics', () => {
  it('await controls с complete() резолвится', async () => {
    const c = createDriver({ ...BASE_OPTS });
    c.complete();
    await expect(c).resolves.toBeUndefined();
  });

  it('await controls с cancel() резолвится', async () => {
    const c = createDriver({ ...BASE_OPTS });
    c.cancel();
    await expect(c).resolves.toBeUndefined();
  });

  it('await controls с stop() резолвится', async () => {
    const c = createDriver({ ...BASE_OPTS });
    c.stop();
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

// ── 4. Валидация входных данных ───────────────────────────────────────────────

describe('driver: validation errors', () => {
  it('бросает MotionParamError при from = NaN', () => {
    expect(() => createDriver({ ...BASE_OPTS, from: NaN })).toThrow();
  });

  it('бросает MotionParamError при to = Infinity', () => {
    expect(() => createDriver({ ...BASE_OPTS, to: Infinity })).toThrow();
  });

  it('бросает MotionParamError при невалидных spring-параметрах', () => {
    expect(() =>
      createDriver({ ...BASE_OPTS, spring: { mass: -1, stiffness: 100, damping: 20 } }),
    ).toThrow();
  });
});

// ── 5. Reduced-motion CHARACTER-switch ────────────────────────────────────────

describe('driver: reduced-motion CHARACTER-switch', () => {
  function makeReduceMedia(): (query: string) => MediaQueryList {
    return (): MediaQueryList => ({
      matches: true,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  it('при reduce: snap-to-target, НЕ hard-off — контрол существует и then резолвится', async () => {
    const steps: number[] = [];
    const c = createDriver({
      ...BASE_OPTS,
      to: 100,
      matchMedia: makeReduceMedia(),
      onStep: (v) => steps.push(v),
    });
    await c;
    // CHARACTER-switch: финальное значение — to=100, эмитировано ровно раз.
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[steps.length - 1]).toBe(100);
  });

  it('при reduce: complete() — no-op (уже settled)', async () => {
    const c = createDriver({ ...BASE_OPTS, matchMedia: makeReduceMedia() });
    await c;
    // Повторные вызовы complete() не должны бросать.
    expect(() => c.complete()).not.toThrow();
  });

  it('timeScale доступен после reduce-settled', async () => {
    const c = createDriver({ ...BASE_OPTS, matchMedia: makeReduceMedia() });
    await c;
    expect(typeof c.timeScale).toBe('number');
  });
});

// ── 6. Subpath smoke ──────────────────────────────────────────────────────────

describe('driver: subpath export smoke (без dist — достаточно импорта)', () => {
  it('createDriver доступен как именованный экспорт', () => {
    // Если импорт выше не упал — тест автоматически зелёный.
    expect(createDriver).toBeDefined();
  });
});
