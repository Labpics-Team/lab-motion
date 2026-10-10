import { findSurfaceRecord } from '../src/internal/surface.js';
import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

const options = { duration: 1000, ease: 'linear' } as const;

for (const native of [false, true]) for (const paused of [false, true]) {
  it(`поздний отказ освобождает принятую цель без остановки соседа: native=${native}, paused=${paused}`, async () => {
    const h = harness(native);
    const previous = h.runtime.animate(h.element, { x: 100 }, options);
    if (paused) previous.pause();
    const sibling = h.runtime.animate(h.element, { y: 200 }, options);
    const other = { style: { getPropertyValue() { if (previous.state === 'stopped') throw failure; return ''; }, setProperty() {} } } as unknown as HTMLElement;
    const failure = new Error('second surface failed after adoption');
    const owner = () => findSurfaceRecord(h.element, 'transform')!.owner as unknown as { _tracks: Map<string, unknown> };
    try {
      expect(() => h.runtime.animate([h.element, other], { x: 100 }, options)).toThrow(failure);
      expect(await previous.finished).toEqual({ status: 'stopped' });
      expect([...owner()._tracks.keys()]).toEqual(['y']);
      expect(sibling.state).toBe('running');
      sibling.seek(500); expect(h.y()).toBe(100); expect(h.x()).toBe(0);
      sibling.finish(); expect(await sibling.finished).toEqual({ status: 'finished' });
      expect(h.updates.size + h.renders.size).toBe(0);
      expect(h.effects.every(effect => effect.cancelled)).toBe(true);
      const recovered = h.runtime.animate(h.element, { x: 50 }, options);
      recovered.seek(500); expect(h.x()).toBe(25); recovered.finish();
      expect(await recovered.finished).toEqual({ status: 'finished' });
      expect(owner()._tracks.size).toBe(0);
    } finally { previous.stop(); sibling.stop(); }
  });
}
