/**
 * Тест: pin публичной API-поверхности модуля ./stagger.
 * Класс Б (Contract/Characterization): экспорты зафиксированы.
 * Инвариант North #6 (subpath tree-shaking) — ровно те runtime-имена, что в контракте.
 *
 * Назначение: любое добавление/удаление/переименование runtime-экспорта → CI красный.
 *
 * RED-доказательство:
 *   Переименовать `export function stagger` → `export function staggerDelays` в
 *   src/stagger/index.ts → `expect(missing).toHaveLength(0)` падает
 *   (stagger отсутствует) И `expect(extra).toHaveLength(0)` падает
 *   (staggerDelays — неконтрактный экспорт).
 *
 * Типы (StaggerFrom, StaggerGridOptions, StaggerOptions) стираются при
 * рантайме → в Object.keys не видны, не перечисляются здесь.
 */

import { describe, expect, it } from 'vitest';
import * as staggerModule from '../src/stagger/index.js';

// Ровно те функции, которые экспортирует ./stagger как runtime-значения.
const EXPECTED_EXPORTS = new Set(['stagger']);

describe('./stagger public API surface pin (North invariant #6)', () => {
  it('экспортирует ровно контрактные имена — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(staggerModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('stagger — функция', () => {
    expect(typeof staggerModule.stagger).toBe('function');
  });
});

describe('./stagger smoke: функция работает', () => {
  it('stagger(5) → 5 конечных неотрицательных задержек, начиная с 0', () => {
    const result = staggerModule.stagger(5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(0);
    expect(result.every((d) => Number.isFinite(d) && d >= 0)).toBe(true);
  });

  it('stagger(0) → []', () => {
    expect(staggerModule.stagger(0)).toEqual([]);
  });
});
