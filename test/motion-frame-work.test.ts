import { expect, it, vi } from 'vitest';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';

it('обычные кадры читают tracks без опережающего снимка; завершение сохраняет cleanup', async () => {
  const records: Array<{ copy: boolean; ahead: number }> = [];
  for (const copy of [false, true]) {
    const h = harness();
    const run = h.runtime.animate(h.element, { x: 100, y: 200, width: 50 }, {
      duration: 1000, ease: 'linear',
    }) as Run;
    const groups = new Set([...run._tracks].map(track => track._group));
    const restore: Array<() => void> = [];
    let ahead = 0;
    try {
      for (const group of groups) {
        const values = group._tracks.values.bind(group._tracks);
        let pulled = 0, checked = 0;
        const iteration = vi.spyOn(group._tracks, 'values').mockImplementation(() => {
          const observed = (function* () {
            pulled = 0; checked = 0;
            for (const track of values()) { pulled++; yield track; }
            return undefined;
          })();
          // Тот же контрпример на реальной границе values: eager Array.from
          // получает все tracks до первого predicate, не меняя сами tracks.
          return copy ? Array.from(observed).values() : observed;
        });
        restore.push(() => iteration.mockRestore());
        const ended = group._ended.bind(group);
        const predicate = vi.spyOn(group, '_ended').mockImplementation(track => {
          ahead = Math.max(ahead, pulled - checked);
          checked++;
          return ended(track);
        });
        restore.push(() => predicate.mockRestore());
      }
      const advance = (time: number) => { ahead = 0; h.step(time); return ahead; };
      const first = advance(250);
      expect(first).toBe(copy ? 2 : 1);
      expect(h.x()).toBe(25); expect(h.y()).toBe(50);
      expect(h.values.get('width')).toBe('12.5px');
      expect(advance(750)).toBe(copy ? 2 : 1);
      expect(h.x()).toBe(75); expect(h.y()).toBe(150);
      records.push({ copy, ahead });
      const finished = run.finished;
      advance(1000);
      expect(await finished).toEqual({ status: 'finished' });
      expect(h.x()).toBe(100); expect(h.y()).toBe(200);
      expect(h.values.get('width')).toBe('50px');
      expect(h.updates.size + h.renders.size).toBe(0);
    } finally {
      try { run.stop(); } finally { for (const off of restore.reverse()) off(); }
    }
  }
  console.log('frame copy-work mutation receipt', JSON.stringify(records));
});
