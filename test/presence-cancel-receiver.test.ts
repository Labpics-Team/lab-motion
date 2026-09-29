import { expect, it } from 'vitest';
import { createPresenceTransition, type PresenceAnimation } from '../src/presence/index.js';

it('cancel читается один раз и вызывается с исходным executor как receiver', () => {
  const finished = new Promise<never>(() => {});
  let reads = 0;
  let receiver: unknown;
  const animation = {
    finished,
    get cancel() {
      reads++;
      return function (this: unknown) { receiver = this; };
    },
  } as PresenceAnimation;

  const controls = createPresenceTransition({ enter: () => animation });
  controls.setPresent(true);
  expect(reads).toBe(1);

  controls.destroy();
  expect(reads).toBe(1);
  expect(receiver).toBe(animation);
});
