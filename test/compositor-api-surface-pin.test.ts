/**
 * test/compositor-api-surface-pin.test.ts — пин публичной поверхности ./compositor.
 * Класс: contract (invariant 6). Пропавший И лишний runtime-экспорт → красный.
 *
 * RED PROOF: удалить `export function readCompositorSpring` → набор не совпадёт →
 * RED. Добавить недокументированный экспорт → exact-set RED.
 */

import { describe, expect, it } from 'vitest';
import * as compositor from '../src/compositor/index.js';

describe('compositor: api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов (типы стёрты)', () => {
    expect(Object.keys(compositor).sort()).toEqual([
      'CompositorSpring',
      'DEFAULT_TOLERANCE',
      'compileSpringLinear',
      'compileSpringPlan',
      'createSpringLinearCache',
      'handoffToLive',
      'readCompositorSpring',
      'supportsCompositor',
    ]);
  });

  it('SSR: import + чистые вызовы в node env не бросают (window/document нет)', () => {
    expect(() => {
      compositor.compileSpringLinear({ mass: 1, stiffness: 170, damping: 26 });
      compositor.compileSpringPlan({ spring: { mass: 1, stiffness: 170, damping: 26 }, property: 'opacity', from: 0, to: 1 });
      compositor.readCompositorSpring({ mass: 1, stiffness: 170, damping: 26 }, { t: 0.1 });
      compositor.supportsCompositor();
      compositor.createSpringLinearCache(4).compile({ mass: 1, stiffness: 170, damping: 26 });
      // handoffToLive без requestFrame использует node-фоллбек (setTimeout-шим) —
      // импорт и построение значения не трогают window/document.
      compositor.handoffToLive({ spring: { mass: 1, stiffness: 170, damping: 26 }, value: 0, velocity: 0, target: 1 }).destroy();
    }).not.toThrow();
  });

  it('типы функций/классов корректны', () => {
    expect(typeof compositor.compileSpringLinear).toBe('function');
    expect(typeof compositor.compileSpringPlan).toBe('function');
    expect(typeof compositor.readCompositorSpring).toBe('function');
    expect(typeof compositor.supportsCompositor).toBe('function');
    expect(typeof compositor.createSpringLinearCache).toBe('function');
    expect(typeof compositor.CompositorSpring).toBe('function');
    expect(typeof compositor.handoffToLive).toBe('function');
    expect(typeof compositor.DEFAULT_TOLERANCE).toBe('number');
  });
});
