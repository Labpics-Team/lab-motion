/**
 * Пин capability-фасада ./compositor/stagger. Базовый compositor не должен
 * снова тянуть групповой контроллер, а потребитель группы получает связанные
 * одиночный и групповой примитивы из одного entry без двойного prebundle.
 */

import { describe, expect, it } from 'vitest';
import * as compositorStagger from '../src/compositor/stagger/index.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;

describe('compositor/stagger: api-surface-pin', () => {
  it('экспортирует ровно capability-поверхность группы', () => {
    expect(Object.keys(compositorStagger).sort()).toEqual([
      'CompositorSpring',
      'CompositorStaggerGroup',
      'compileSpringPlan',
      'compileStaggerPlan',
    ]);
  });

  it('SSR-safe: импорт и чистые вызовы не требуют DOM', () => {
    expect(() => {
      compositorStagger.compileSpringPlan({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
      });
      compositorStagger.compileStaggerPlan({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
        count: 3,
      });
      new compositorStagger.CompositorSpring({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
      }).destroy();
      new compositorStagger.CompositorStaggerGroup({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
        targets: [],
      }).destroy();
    }).not.toThrow();
  });
});
