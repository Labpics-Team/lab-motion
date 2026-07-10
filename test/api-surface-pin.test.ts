import { describe, expect, it } from 'vitest';
import * as motionModule from '../src/index.js';

/**
 * Контрактный пин корневого API.
 *
 * Зачем: корневой импорт остаётся минимальным и предсказуемым. Добавление,
 * удаление или переименование runtime-экспорта является публичным изменением и
 * не должно происходить побочно при рефакторинге внутренних модулей.
 *
 * Сила теста проверяется прямыми диверсиями: удаление ожидаемого экспорта или
 * добавление незаявленного имени меняет точное множество и валит CI.
 */
const EXPECTED_EXPORTS = [
  'MotionParamError',
  'MotionValue',
  'drive',
  'spring',
  'tween',
  'validateSpringParams',
] as const;

describe('public API surface pin (invariant 6)', () => {
  it('exports exactly the contracted names — no more, no less', () => {
    expect(Object.keys(motionModule).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it('spring is a function', () => {
    expect(typeof motionModule.spring).toBe('function');
  });

  it('tween is a function', () => {
    expect(typeof motionModule.tween).toBe('function');
  });

  it('drive is a function', () => {
    expect(typeof motionModule.drive).toBe('function');
  });

  it('MotionParamError is an instantiable constructor', () => {
    expect(typeof motionModule.MotionParamError).toBe('function');
    expect(() => new motionModule.MotionParamError('test')).not.toThrow();
  });

  it('validateSpringParams is a function', () => {
    expect(typeof motionModule.validateSpringParams).toBe('function');
  });
});
