/**
 * test/decay-api-surface-pin.test.ts
 * Класс Б (contract pin): ровно контрактные runtime-имена ./decay зафиксированы.
 * Инвариант North #6 (subpath tree-shaking) + условие успеха (5) "api-surface-pin.test.ts
 * pins ./decay public surface".
 *
 * RED-proof:
 *   Переименовать `export function createDecay` → `export function decay` в
 *   src/decay.ts → `missing` содержит 'createDecay' → красный.
 *   Добавить неконтрактный runtime-экспорт (например internalHelper) →
 *   `extra` не пуст → красный.
 *
 * Mutation proof:
 *   Удалить `rest` из возвращаемого объекта createDecay() → shape-тест ниже
 *   красный ('rest: читаемое числовое свойство').
 *   Удалить `valueAt`/`velocityAt`/`isSettledAt` → соответствующий 'функция' тест красный.
 *
 * DecayOptions/DecayModel — типы, стираются при рантайме, не перечисляются в Object.keys.
 */

import { describe, expect, it } from 'vitest';
import * as decayModule from '../src/decay/index.js';

const EXPECTED_EXPORTS = new Set(['createDecay']);

describe('./decay public API surface pin (North invariant #6)', () => {
  it('экспортирует ровно контрактные имена — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(decayModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('createDecay — функция', () => {
    expect(typeof decayModule.createDecay).toBe('function');
  });
});

describe('./decay: DecayModel shape', () => {
  it('rest: читаемое конечное числовое свойство', () => {
    const m = decayModule.createDecay({ from: 0, velocity: 1000 });
    expect(typeof m.rest).toBe('number');
    expect(Number.isFinite(m.rest)).toBe(true);
  });

  it('reduced: булево свойство', () => {
    const m = decayModule.createDecay({ from: 0, velocity: 1000 });
    expect(typeof m.reduced).toBe('boolean');
  });

  it('valueAt — функция', () => {
    const m = decayModule.createDecay({ from: 0, velocity: 1000 });
    expect(typeof m.valueAt).toBe('function');
  });

  it('velocityAt — функция', () => {
    const m = decayModule.createDecay({ from: 0, velocity: 1000 });
    expect(typeof m.velocityAt).toBe('function');
  });

  it('isSettledAt — функция', () => {
    const m = decayModule.createDecay({ from: 0, velocity: 1000 });
    expect(typeof m.isSettledAt).toBe('function');
  });

  it('бросает при from = NaN', () => {
    expect(() => decayModule.createDecay({ from: NaN, velocity: 0 })).toThrow();
  });

  it('бросает при velocity = Infinity', () => {
    expect(() => decayModule.createDecay({ from: 0, velocity: Infinity })).toThrow();
  });
});
