import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

const options = { duration: 1000, ease: 'linear' } as const;

for (const native of [false, true]) for (const paused of [false, true]) {
  it(`поздний отказ освобождает принятую цель без остановки соседа: native=${native}, paused=${paused}`, async () => {
    const h = harness(native);
    const previous = h.runtime.animate(h.element, { x: 100 }, options);
    if (paused) previous.pause();
    const sibling = h.runtime.animate(h.element, { y: 200 }, options);
    const other = { style: { getPropertyValue: () => '', setProperty() {} } } as unknown as HTMLElement;
    const failure = new Error('second surface failed after adoption');
    const styles = h.host.styles;
    h.host.styles = element => {
      if (element === other && previous.state === 'stopped') throw failure;
      return styles(element);
    };
    const registry = (h.runtime as unknown as {
      _surfaces: WeakMap<Element, Map<string, { _tracks: Map<string, unknown> }>>;
    })._surfaces;
    try {
      expect(() => h.runtime.animate([h.element, other], { x: 100 }, options)).toThrow(failure);
      expect(await previous.finished).toEqual({ status: 'stopped' });
      expect([...registry.get(h.element)!.get('transform')!._tracks.keys()]).toEqual(['y']);
      expect(sibling.state).toBe('running');
      sibling.seek(500); expect(h.y()).toBe(100); expect(h.x()).toBe(0);
      sibling.finish(); expect(await sibling.finished).toEqual({ status: 'finished' });
      expect(h.updates.size + h.renders.size).toBe(0);
      expect(h.effects.every(effect => effect.cancelled)).toBe(true);
      h.host.styles = styles;
      const recovered = h.runtime.animate(h.element, { x: 50 }, options);
      recovered.seek(500); expect(h.x()).toBe(25); recovered.finish();
      expect(await recovered.finished).toEqual({ status: 'finished' });
      expect(registry.get(h.element)!.get('transform')!._tracks.size).toBe(0);
    } finally { h.host.styles = styles; previous.stop(); sibling.stop(); }
  });
}
