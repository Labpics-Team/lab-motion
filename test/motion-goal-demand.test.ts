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

it('moving same-goal adoption never constructs discarded cold spring grids', async () => {
  const h = harness();
  const targets = Array.from({ length: 16 }, (_, i) => {
    const t = harness(); t.values.set('width', (i + 1) + 'px'); return t;
  });
  const options = { spring: { mass: 1, stiffness: 179.317, damping: 26 } };
  const prior = h.runtime.animate(targets.map(t => t.element), { width: 800 }, options) as Run;
  const old = [...prior._tracks];
  prior.seek(prior.duration * .125);
  expect(old.every(t => t._velocity[0]! !== 0)).toBe(true);
  const before = work.grids, snapshots = targets.map(t => t.values.get('width'));
  const next = h.runtime.animate(targets.map(t => t.element), { width: 800 }, options) as Run;
  try {
    expect(work.grids).toBe(before);
    expect([...next._tracks]).toEqual(old);
    expect(targets.map(t => t.values.get('width'))).toEqual(snapshots);
    expect(await prior.finished).toEqual({ status: 'stopped' });
    expect(next.duration).toBe(prior.duration);
    const changed = h.runtime.animate(targets.map(t => t.element), { width: 850 }, options);
    expect(work.grids).toBeGreaterThan(before);
    changed.finish(); expect(await changed.finished).toEqual({ status: 'finished' });
  } finally { prior.stop(); next.stop(); }
});

it('accepted sequence prepares all needed stop buffers before any playback frame', async () => {
  const h = harness();
  const first = { spring: { mass: 1, stiffness: 181.317, damping: 26 } };
  const second = { spring: { mass: 1, stiffness: 191.317, damping: 26 } };
  const before = work.grids;
  const run = h.runtime.sequence([[h.element, { x: 100 }, first], [h.element, { x: 200 }, second]]) as Run;
  try {
    const path = [...run._tracks][0]!._program;
    expect(path._segments.every(s => s._artifact?.[1] instanceof Float64Array)).toBe(true);
    expect(work.grids - before).toBe(2);
    run.seek(path._segments[1]!._at + 20);
    expect(work.grids - before).toBe(2);
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
  } finally { run.stop(); }
});

it('rejected sequence never creates its spring stop buffers', () => {
  const h = harness();
  const opts = { spring: { mass: 1, stiffness: 194.317, damping: 26 } };
  const before = work.grids;
  expect(() => h.runtime.sequence([[h.element, { x: 100 }, opts],
    [h.element, { x: 200 }, { ...opts, at: 1 }]])).toThrow(/Пересечение/);
  expect(work.grids).toBe(before);
  expect(h.writes).toHaveLength(0);
});
