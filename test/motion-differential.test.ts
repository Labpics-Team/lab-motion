import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { MotionProperties, Playback } from '../src/motion/types.js';

it('две реализации исполняют одинаковые 2000 смен целей, контролов и траекторий', async () => {
  const peers = [harness(false), harness(true)];
  const histories: Playback[][] = [[], []];
  let seed = 0x753912;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 2000; step++) {
    const action = random() % 7;
    if (action < 3 || !histories[0]!.length) {
      const x = random() % 501 - 250, y = random() % 101 - 50;
      const props: MotionProperties = action === 0 ? { x, y, opacity: (random() % 11) / 10 }
        : action === 1 ? { x: [0, x, y, 0] } : { x };
      const duration = 100 + random() % 1000;
      for (let i = 0; i < peers.length; i++) histories[i]!.push(peers[i]!.runtime.animate(peers[i]!.element, props, { duration, ease: 'linear' }));
    } else {
      const index = random() % histories[0]!.length;
      const time = random() % 1400;
      for (const history of histories) {
        const run = history[index]!;
        if (action === 3) run.seek(time);
        else if (action === 4) run.pause();
        else if (action === 5) run.play();
        else run.stop();
      }
    }
    const [a, b] = peers;
    expect(a!.x()).toBeCloseTo(b!.x(), 10);
    expect(a!.y()).toBeCloseTo(b!.y(), 10);
    expect(a!.values.get('opacity')).toBe(b!.values.get('opacity'));
    expect(histories[0]!.at(-1)!.state).toBe(histories[1]!.at(-1)!.state);
  }
  for (const history of histories) for (const run of history) run.finish();
  const results = await Promise.all(histories.map(history => Promise.all(history.map(run => run.finished))));
  expect(results[0]).toEqual(results[1]);
  for (const h of peers) expect(h.updates.size + h.renders.size).toBe(0);
  expect(peers[1]!.effects.every(effect => effect.cancelled)).toBe(true);
});
