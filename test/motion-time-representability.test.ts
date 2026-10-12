import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

it('положительная длительность сохраняет различимый абсолютный конец', async () => {
  const delays = [0, 2 ** 20, 2 ** 53, Number.MAX_VALUE];
  const spans = [0, Number.MIN_VALUE, .125, 1, 100, 1e308];
  for (const delay of delays) for (const duration of spans) {
    const h = harness();
    const representable = Number.isFinite(delay + duration) &&
      (duration === 0 || delay + duration > delay);
    if (!representable) {
      expect(() => h.runtime.animate(h.element, { x: [0, 100] }, { delay, duration, ease: 'linear' }))
        .toThrow(/Непредставимая длительность/);
      expect(h.writes).toHaveLength(0);
      expect(h.updates.size + h.renders.size).toBe(0);
    } else {
      const playback = h.runtime.animate(h.element, { x: [0, 100] }, { delay, duration, ease: 'linear' });
      playback.finish();
      expect(await playback.finished).toEqual({ status: 'finished' });
      expect(h.x()).toBe(100);
      expect(h.updates.size + h.renders.size).toBe(0);
    }
  }
});

it('синонимы имени свойства нормализуются до проверки единственного владельца', () => {
  const h = harness();
  expect(() => h.runtime.animate(h.element, { scaleX: 1, 'scale-x': 2 })).toThrow(/задано несколько раз/);
  expect(h.writes).toHaveLength(0);
});
