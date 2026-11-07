import { expect, it, vi } from 'vitest';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';

it('обычные кадры не копируют tracks; завершение сохраняет снимок и cleanup', async () => {
  const h = harness();
  const own = vi.spyOn(Run.prototype, '_own');
  const run = h.runtime.animate(h.element, { x: 100, y: 200, width: 50 }, {
    duration: 1000, ease: 'linear',
  });
  const tracks = new WeakSet(own.mock.calls.map(([track]) => track));
  own.mockRestore();
  const iterator = Array.prototype[Symbol.iterator];
  let copied = 0;
  const advance = (time: number) => {
    copied = 0;
    try {
      // Считаем обход материализованных Track[], а не машинозависимое время.
      Array.prototype[Symbol.iterator] = function* () {
        for (const value of iterator.call(this)) {
          if (value && typeof value === 'object' && tracks.has(value)) copied++;
          yield value;
        }
      };
      h.step(time);
    } finally { Array.prototype[Symbol.iterator] = iterator; }
    return copied;
  };
  try {
    expect(advance(250)).toBe(0);
    expect(h.x()).toBe(25); expect(h.y()).toBe(50);
    expect(h.values.get('width')).toBe('12.5px');
    expect(advance(750)).toBe(0);
    expect(h.x()).toBe(75); expect(h.y()).toBe(150);
    expect(advance(1000)).toBeGreaterThan(0);
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(100); expect(h.y()).toBe(200);
    expect(h.values.get('width')).toBe('50px');
    expect(h.updates.size + h.renders.size).toBe(0);
  } finally { run.stop(); }
});
