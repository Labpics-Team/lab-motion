/**
 * test/frame-api-surface-pin.test.ts
 * Класс Б (contract pin): ровно контрактные runtime-имена ./frame зафиксированы.
 * Инвариант North #6 (subpath tree-shaking): ./frame — публичный субпуть,
 * его поверхность заперта, как у всех остальных.
 *
 * RED-proof:
 *   Переименовать `export function createFrameLoop` → `export function frameLoop`
 *   в src/frame/index.ts → `missing` содержит 'createFrameLoop' → красный.
 *   Добавить неконтрактный runtime-экспорт → `extra` не пуст → красный.
 *
 * Mutation proof:
 *   Убрать метод read/update/render/cancelAll из возвращаемого объекта →
 *   соответствующий shape-тест красный.
 *
 * FrameLoop/FrameCallbackOptions — типы, стираются при рантайме,
 * в Object.keys не попадают.
 */

import { describe, expect, it } from 'vitest';
import * as frameModule from '../src/frame/index.js';

const EXPECTED_EXPORTS = new Set(['createFrameLoop', 'frame']);

describe('./frame public API surface pin (North invariant #6)', () => {
  it('экспортирует ровно контрактные имена — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(frameModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('createFrameLoop — функция', () => {
    expect(typeof frameModule.createFrameLoop).toBe('function');
  });
});

describe('./frame: FrameLoop shape', () => {
  it('созданный цикл несёт все три фазы и teardown', () => {
    const loop = frameModule.createFrameLoop({ requestFrame: () => 1 });
    expect(typeof loop.read).toBe('function');
    expect(typeof loop.update).toBe('function');
    expect(typeof loop.render).toBe('function');
    expect(typeof loop.cancelAll).toBe('function');
  });

  it('подписка возвращает идемпотентную отписку', () => {
    const loop = frameModule.createFrameLoop({ requestFrame: () => 1 });
    const off = loop.update(() => {});
    expect(typeof off).toBe('function');
    expect(() => {
      off();
      off();
    }).not.toThrow();
    loop.cancelAll();
  });

  it('дефолтный синглтон frame — тот же контракт FrameLoop', () => {
    expect(typeof frameModule.frame.read).toBe('function');
    expect(typeof frameModule.frame.update).toBe('function');
    expect(typeof frameModule.frame.render).toBe('function');
    expect(typeof frameModule.frame.cancelAll).toBe('function');
  });
});
