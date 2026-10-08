import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

it('отказ подготовки не накапливает пустые поверхности на живом элементе', () => {
  const h = harness();
  const running = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
  const registry = (h.runtime as unknown as { _surfaces: WeakMap<Element, Map<string, unknown>> })._surfaces;
  try {
    for (let i = 0; i < 1000; i++) {
      expect(() => h.runtime.animate(h.element, { ['--invalid-' + i]: 'invalid-value' })).toThrow();
    }
    expect(registry.get(h.element)!.size).toBe(1);
    h.step(500); expect(h.x()).toBe(50); expect(running.state).toBe('running');
    const next = h.runtime.animate(h.element, { '--valid': [0, 100] }, { duration: 1000 });
    next.finish(); expect(h.values.get('--valid')).toBe('100'); expect(registry.get(h.element)!.size).toBe(1);
  } finally { running.stop(); }
});
