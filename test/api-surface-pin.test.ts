import { describe, expect, it } from 'vitest';
import * as motionModule from '../src/index.js';

/**
 * Контрактный пин корневого runtime API.
 *
 * Точное множество защищает обе стороны semver-контракта: удаление ломает
 * потребителя, а случайный экспорт расширяет обещанную поверхность и способен
 * ухудшить tree-shaking. История RED-фазы хранится в PR и коммитах.
 */
const EXPECTED_EXPORTS = new Set([
  'spring',
  'tween',
  'MotionParamError',
  'drive',
  'validateSpringParams',
  'validateSpringPhysics',
  'MotionValue',
]);

describe('public API surface pin', () => {
  it('exports exactly the contracted names — no more, no less', () => {
    const exported = new Set(Object.keys(motionModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Missing exports: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
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
