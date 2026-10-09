import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

it('относительная команда сравнивает разрешённую цель, а не строку прошлого вызова', async () => {
  const h = harness(); h.values.set('left', '0px');
  const options = { duration: 1000, ease: 'linear' } as const;
  const first = h.runtime.animate(h.element, { left: '+=20px' }, options);
  let second: ReturnType<typeof h.runtime.animate> | undefined, same: typeof second;
  try {
    h.step(250); expect(h.values.get('left')).toBe('5px');
    second = h.runtime.animate(h.element, { left: '+=20px' }, options);
    expect(await first.finished).toEqual({ status: 'stopped' });
    second.seek(500); expect(h.values.get('left')).toBe('15px');
    const writes = h.writes.length;
    same = h.runtime.animate(h.element, { left: '25px' }, options);
    expect(h.writes).toHaveLength(writes);
    expect(await second.finished).toEqual({ status: 'stopped' });
    same.seek(750); expect(h.values.get('left')).toBe('20px');
    same.finish(); expect(await same.finished).toEqual({ status: 'finished' });
    expect(h.values.get('left')).toBe('25px'); expect(h.updates.size + h.renders.size).toBe(0);
  } finally { first.stop(); second?.stop(); same?.stop(); }
});
