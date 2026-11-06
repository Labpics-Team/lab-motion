import { expect, it, vi } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback, SequenceStep } from '../src/motion/types.js';

it('сборка длинной sequence читает сегменты линейно и не мутирует входные программы', async () => {
  const h = harness(), count = 128;
  const known = new WeakSet<object>();
  const inputs: ReadonlyArray<unknown>[] = [];
  const draft = h.runtime._draft.bind(h.runtime);
  const observe = vi.spyOn(h.runtime, '_draft').mockImplementation((...args) => {
    const result = draft(...args);
    for (const entry of result) {
      const segments = entry._program._segments;
      for (const segment of segments) known.add(segment);
      Object.freeze(segments);
      inputs.push(segments);
    }
    return result;
  });
  const steps: SequenceStep[] = Array.from({ length: count }, (_, index) => [
    h.element, { x: index + 1 }, { duration: 10, ease: 'linear' },
  ]);
  const iterator = Array.prototype[Symbol.iterator];
  let visits = 0, run: Playback | undefined;
  try {
    // Наблюдаем обход настоящих сегментов, включая повторное копирование префикса.
    // Часы и длительность теста не участвуют в оценке сложности.
    Array.prototype[Symbol.iterator] = function* () {
      for (const value of iterator.call(this)) {
        if (value && typeof value === 'object' && known.has(value)) visits++;
        yield value;
      }
    };
    run = h.runtime.sequence(steps);
  } finally {
    Array.prototype[Symbol.iterator] = iterator;
    observe.mockRestore();
  }
  try {
    expect(visits).toBeLessThanOrEqual(count * 2);
    expect(inputs).toHaveLength(count);
    for (const segments of inputs) expect(segments).toHaveLength(1);
    expect(run!.duration).toBe(count * 10);
    run!.seek(1235); expect(h.x()).toBe(123.5);
    run!.seek(5); expect(h.x()).toBe(0.5);
    run!.finish(); expect(await run!.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(count);
    expect(h.updates.size + h.renders.size).toBe(0);
  } finally { run?.stop(); }
});
