import { expect, it, vi } from 'vitest';
import { properties, timing } from '../src/motion/model.js';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';

const work = vi.hoisted(() => ({ grids: 0 }));
vi.mock('../src/internal/solver.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/internal/solver.js')>();
  return { ...actual, makeSpringValueSampler(...args: Parameters<typeof actual.makeSpringValueSampler>) {
    work.grids++; return actual.makeSpringValueSampler(...args);
  }};
});

for (const native of [false, true]) it(`repeating a resolved goal keeps its track and skips all new spring grids, native=${native}`, async () => {
  const h = harness(native);
  const options = { spring: { mass: 1, stiffness: 183.91, damping: 25 } };
  const prior = h.runtime.animate(h.element, { x: 300 }, options) as Run;
  const track = [...prior._tracks][0]!;
  prior.pause(); prior.seek(prior.duration * .375);
  const pose = h.x(), writes = h.writes.length, before = work.grids;
  const same = h.runtime.animate(h.element, { x: 300 }, options) as Run;
  try {
    expect([...same._tracks][0]).toBe(track);
    expect(work.grids).toBe(before);
    expect(h.x()).toBe(pose);
    expect(h.writes).toHaveLength(writes);
    expect(await prior.finished).toEqual({ status: 'stopped' });
    same.finish();
    expect(await same.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(300);
  } finally { same.stop(); prior.stop(); }
});

it('a prepared same-goal fallback materializes if another goal intervenes', async () => {
  const h = harness();
  const options = { spring: { mass: 1, stiffness: 184.93, damping: 27 } };
  const donor = h.runtime.animate(h.element, { x: 320 }, options) as Run;
  donor.seek(donor.duration * .4);
  const captured = [...donor._tracks][0]!, from = captured._value[0]!, v = captured._velocity[0]!;
  const before = work.grids;
  const drafts = h.runtime._draft(h.element, properties({ x: 320 }), timing(options));
  expect(work.grids).toBe(before);
  const successor = h.runtime.animate(h.element, { x: 777 }, options);
  const beforeAccept = work.grids;
  const run = h.runtime._execute(drafts) as Run;
  try {
    expect([...run._tracks][0]).not.toBe(captured);
    const seg = [...run._tracks][0]!._program._segments[0]!;
    expect(seg._from).toEqual([from]); expect(seg._velocity).toEqual([v]);
    expect(seg._artifact?.[1]).toBeInstanceOf(Float64Array);
    expect(work.grids - beforeAccept).toBe(1);
    expect(await successor.finished).toEqual({ status: 'stopped' });
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(320);
  } finally { donor.stop(); successor.stop(); run.stop(); }
});
