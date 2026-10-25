import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import { playhead } from '../src/motion/playhead.js';

it('отказ native rate не завершает нового владельца, принятого во время cancel', async () => {
  const h = harness(true), failure = new Error('rate rejected');
  const previous = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  const effect = h.effects[0]!;
  const cancel = effect.cancel;
  let successor: ReturnType<typeof h.runtime.animate> | undefined;
  effect.cancel = () => {
    cancel();
    successor = h.runtime.animate(h.element, { x: [100, 200] }, { duration: 1000 });
  };
  effect.updatePlaybackRate = () => { throw failure; };
  expect(() => { previous.timeScale = 2; }).toThrow(failure);
  await expect(previous.finished).rejects.toBe(failure);
  expect(successor).toBeDefined();
  expect(successor!.state).toBe('running');
  successor!.seek(500);
  expect(h.x()).toBe(150);
  successor!.finish();
  expect(await successor!.finished).toEqual({ status: 'finished' });
  expect(h.updates.size + h.renders.size).toBe(0);
});
