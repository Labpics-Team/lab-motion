import { describe, expect, it } from 'vitest';
import * as motionModule from '../src/index.js';

/**
 * Контрактный пин корневого runtime API.
 *
 * Почему точное множество, а не отдельные `toContain`: случайный экспорт расширяет
 * semver-контракт и может ухудшить tree-shaking. Удаление или переименование,
 * наоборот, обязано ломать CI до публикации.
 */
const EXPECTED_EXPORTS = new Set([
  'spring',
  'tween',
  'MotionParamError',
  'drive',
  'validateSpringParams',
  'MotionValue',
]);

describe('public API surface pin', () => {
  it('exports exactly the contracted names — no more, no less', () => {
    const exported = new Set(Object.keys(motionModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Missing exports: ${missing.join(', ')}`).toHaveLength(0);

    // PACKAGE_NAME — легаси-метаданные пакета, а не часть motion API.
    const extra = [...exported].filter(
      (name) => !EXPECTED_EXPORTS.has(name) && name !== 'PACKAGE_NAME',
    );
    expect(extra, `Unexpected new exports: ${extra.join(', ')}`).toHaveLength(0);
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

  it('MotionParamError is an instantiable error class', () => {
    expect(typeof motionModule.MotionParamError).toBe('function');
    expect(() => new motionModule.MotionParamError('test')).not.toThrow();
  });

  it('validateSpringParams is a function', () => {
    expect(typeof motionModule.validateSpringParams).toBe('function');
  });
});
