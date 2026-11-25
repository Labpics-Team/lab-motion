import { expect, it, vi } from 'vitest';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';

it('ordinary frames and controls use existing immutable membership; completion leaves earlier snapshots intact', async () => {
  const h = harness();
  const own = vi.spyOn(Run.prototype, '_own');
  const run = h.runtime.animate(h.element, { x: 100, y: 200, width: 50 }, {
    duration: 1000, ease: 'linear',
  });
  const tracks = own.mock.calls.map(([track]) => track);
  own.mockRestore();
  const groups = [...new Set(tracks.map(track => track._group))];
  const snapshots = groups.map(group => group._tracks);
  const known = new WeakSet(snapshots);
  const members = new WeakSet(tracks);
  const iterator = Array.prototype[Symbol.iterator];
  let copied = 0;
  const check = (action: () => void) => {
    copied = 0;
    try {
      Array.prototype[Symbol.iterator] = function* () {
        for (const value of iterator.call(this)) {
          if (!known.has(this) && value && typeof value === 'object' && members.has(value)) copied++;
          yield value;
        }
      };
      action();
    } finally { Array.prototype[Symbol.iterator] = iterator; }
    expect(copied).toBe(0);
    groups.forEach((group, i) => expect(group._tracks).toBe(snapshots[i]));
  };
  try {
    check(() => h.step(250));
    expect(h.x()).toBe(25); expect(h.y()).toBe(50);
    expect(h.values.get('width')).toBe('12.5px');
    check(() => run.seek(750));
    expect(h.x()).toBe(75); expect(h.y()).toBe(150);
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(100); expect(h.y()).toBe(200);
    expect(h.values.get('width')).toBe('50px');
    expect(h.updates.size + h.renders.size).toBe(0);
    expect(snapshots.flat()).toEqual(tracks);
    for (const group of groups) expect(group._tracks).toHaveLength(0);
  } finally { run.stop(); }
});
