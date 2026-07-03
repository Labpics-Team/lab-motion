/**
 * Тест: pin публичной API-поверхности модуля ./value.
 * Класс Б (Contract/Characterization): экспорты зафиксированы.
 * Инвариант 6 — ровно те имена, что в контракте.
 *
 * Назначение: любое добавление/удаление/переименование экспорта → CI красный.
 *
 * RED-доказательство:
 *   Убрать `export { parse }` из src/value/index.ts →
 *     `expect(exported).toContain('parse')` падает.
 *   Добавить неконтрактный экспорт `export const _internal = 1` →
 *     `extra` тест-кейс падает.
 *
 * Типы (type-only exports) стираются при рантайме → в Object.keys не видны.
 * Тестируем только runtime-значения (функции).
 */

import { describe, expect, it } from 'vitest';
import * as valueModule from '../src/value/index.js';

// Ровно те функции, которые экспортирует ./value как runtime-значения.
// Типы (ValueAST, ParsedUnit, …) стираются при рантайме — не перечислять.
const EXPECTED_EXPORTS = new Set([
  // Парсинг
  'parse',
  'parseUnit',
  'parseColor',
  // Интерполяция
  'interpolate',
  'interpolateUnit',
  'interpolateColor',
  'mixColor',
  // Трансформы
  'buildTransform',
  'interpolateTransform',
  // Утилиты цвета (экспортированы для тестов и consumer-использования)
  'hslToRgb',
  'rgbToHsl',
]);

describe('./value public API surface pin (инвариант 6)', () => {
  it('экспортирует ровно контрактные имена — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(valueModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('parse — функция', () => {
    expect(typeof valueModule.parse).toBe('function');
  });

  it('parseUnit — функция', () => {
    expect(typeof valueModule.parseUnit).toBe('function');
  });

  it('parseColor — функция', () => {
    expect(typeof valueModule.parseColor).toBe('function');
  });

  it('interpolate — функция', () => {
    expect(typeof valueModule.interpolate).toBe('function');
  });

  it('interpolateUnit — функция', () => {
    expect(typeof valueModule.interpolateUnit).toBe('function');
  });

  it('interpolateColor — функция', () => {
    expect(typeof valueModule.interpolateColor).toBe('function');
  });

  it('mixColor — функция', () => {
    expect(typeof valueModule.mixColor).toBe('function');
  });

  it('buildTransform — функция', () => {
    expect(typeof valueModule.buildTransform).toBe('function');
  });

  it('interpolateTransform — функция', () => {
    expect(typeof valueModule.interpolateTransform).toBe('function');
  });

  it('hslToRgb — функция', () => {
    expect(typeof valueModule.hslToRgb).toBe('function');
  });

  it('rgbToHsl — функция', () => {
    expect(typeof valueModule.rgbToHsl).toBe('function');
  });
});

describe('./value smoke: функции работают', () => {
  it('parse("100px") → kind=unit', () => {
    const r = valueModule.parse('100px');
    expect(r.kind).toBe('unit');
  });

  it('parseColor("#f00") → kind=color, r=255', () => {
    const r = valueModule.parseColor('#f00');
    expect(r?.kind).toBe('color');
    expect(r?.r).toBe(255);
  });

  it('interpolate(unit, unit, 0.5) → конечный результат', () => {
    const from = { kind: 'unit' as const, value: 0, unit: 'px' };
    const to = { kind: 'unit' as const, value: 100, unit: 'px' };
    const r = valueModule.interpolate(from, to, 0.5);
    expect(r).toBe('50px');
  });

  it('mixColor("#ff0000", "#0000ff", 0.5) → rgb(180, 0, 180) (linear-light default, 2026-07-03)', () => {
    const r = valueModule.mixColor('#ff0000', '#0000ff', 0.5);
    expect(r).toBe('rgb(180, 0, 180)');
  });

  it('buildTransform({}) → "none"', () => {
    expect(valueModule.buildTransform({})).toBe('none');
  });

  it('interpolateTransform({x:0}, {x:100}, 0.5) → translateX(50px)', () => {
    const r = valueModule.interpolateTransform({ x: 0 }, { x: 100 }, 0.5);
    expect(r).toBe('translateX(50px)');
  });

  it('hslToRgb(0, 1, 0.5) → r≈255, g≈0, b≈0', () => {
    const r = valueModule.hslToRgb(0, 1, 0.5);
    expect(Math.round(r.r)).toBe(255);
    expect(Math.round(r.g)).toBe(0);
    expect(Math.round(r.b)).toBe(0);
  });

  it('rgbToHsl(255, 0, 0) → h≈0, s≈1, l≈0.5', () => {
    const r = valueModule.rgbToHsl(255, 0, 0);
    expect(r.h).toBeCloseTo(0, 1);
    expect(r.s).toBeCloseTo(1, 3);
    expect(r.l).toBeCloseTo(0.5, 3);
  });
});
