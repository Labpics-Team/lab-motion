import { expect, it, vi } from 'vitest';
import { timing } from '../src/motion/model.js';
import { program, sample, materialize } from '../src/motion/program.js';
import { harness } from './fixtures/motion-runtime.js';

const work = vi.hoisted(() => ({ builds: 0, horizons: 0 }));
vi.mock('../src/compositor/segmenter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/compositor/segmenter.js')>();
  return { ...actual,
    tryBuildSpringNodes(...args: Parameters<typeof actual.tryBuildSpringNodes>) {
      if (args[3]) work.horizons++;
      return actual.tryBuildSpringNodes(...args);
    },
  };
});
vi.mock('../src/internal/solver.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/internal/solver.js')>();
  return { ...actual,
    makeSpringValueSampler(...args: Parameters<typeof actual.makeSpringValueSampler>) {
      work.builds++;
      return actual.makeSpringValueSampler(...args);
    },
  };
});
const spring = { mass: 1, stiffness: 173, damping: 26 };

it('cold playable spring actually builds a grid while terminal projection does not', () => {
  const before = work.builds;
  const clock = timing({ spring: { mass: 1, stiffness: 123.456, damping: 20 } });
  const from = { _coordinates: [0], _unit: 'px' };
  program('width', from, [17], false, clock, []);
  expect(work.builds).toBe(before);
  materialize(program('width', from, [17], false, clock, []));
  expect(work.builds).toBe(before + 1);
});

it('terminal projection preserves the exact validated horizon without building or caching stops', () => {
  for (const physics of [spring, { mass: 1, stiffness: 100, damping: 20 }, { mass: 1, stiffness: 100, damping: 60 }])
    for (const to of [0, 1, 500, 1e9]) for (const v of [-400, 0, 400]) {
      const clock = timing({ spring: physics, delay: 75 });
      const from = { _coordinates: [0], _unit: 'px' };
      const normal = program('width', from, [to], false, clock, [v], 17);
      materialize(normal);
      const before = work.builds;
      const terminal = program('width', from, [to], false, clock, [v], 17);
      expect(work.builds).toBe(before);
      expect(Object.is(terminal._duration, normal._duration)).toBe(true);
      expect(terminal._duration).toBe(normal._duration);
      const value: number[] = [], velocity: number[] = [];
      sample(terminal, terminal._duration, value, velocity);
      expect(value).toEqual([to]); expect(velocity).toEqual([0]);
    }
});

it.each(['always', 'system'] as const)('reduced %s never constructs a spring grid and completes synchronously', async mode => {
  const hosts = Array.from({ length: 64 }, () => harness(true));
  const h = hosts[0]!;
  if (mode === 'system') h.host.reduced = () => true;
  for (let i = 0; i < hosts.length; i++) hosts[i]!.values.set('width', i + 'px');
  const before = { ...work };
  const run = h.runtime.animate(hosts.map(x => x.element), { width: 432 }, { spring,
    ...(mode === 'always' ? { reducedMotion: 'always' as const } : {}) });
  expect(run.state).toBe('finished'); expect(run.duration).toBe(0);
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(work.builds).toBe(before.builds);

  for (const target of hosts) {
    expect(target.values.get('width')).toBe('432px');
    expect(target.effects).toHaveLength(0);
  }
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('globally reduced sequence validates actual spring step boundaries without materializing them', async () => {
  const h = harness();
  const before = { ...work };
  const first = { spring: { ...spring, stiffness: 191 } };
  const run = h.runtime.sequence([[h.element, { x: 300 }, first], [h.element, { x: 500 }, first]], { reducedMotion: 'always' });
  expect(await run.finished).toEqual({ status: 'finished' }); expect(run.duration).toBe(0);
  expect(h.x()).toBe(500);

  expect(() => h.runtime.sequence([[h.element, { x: 300 }, first], [h.element, { x: 500 }, { ...first, at: 1 }]], { reducedMotion: 'always' })).toThrow(/Пересечение/);
  expect(h.x()).toBe(500); expect(work.builds).toBe(before.builds);
  expect(() => h.runtime.animate(h.element, { x: 100 }, { ...first, delay: Number.MAX_VALUE, reducedMotion: 'always' })).toThrow(/Непредставимая/);
  expect(h.x()).toBe(500);
});

it('a reduced first step followed by a playable step still uses its serialized spring trajectory', () => {
  const h = harness();
  const physics = { ...spring, stiffness: 193 };
  const reference = program('width', { _coordinates: [0], _unit: 'px' }, [100], false, timing({ spring: physics }), []);
  materialize(reference);
  const run = h.runtime.sequence([[h.element, { width: [0, 100] }, { spring: physics, reducedMotion: 'always' }], [h.element, { width: 200 }, { duration: 100, ease: 'linear' }]]);
  try {
    const t = reference._duration * .375, value: number[] = [], velocity: number[] = [];
    sample(reference, t, value, velocity);
    run.seek(t);
    expect(h.values.get('width')).toBe(value[0] + 'px');
  } finally { run.stop(); }
});

it('a reduced layout commits once without a spring grid or a view transition', async () => {
  const { layout } = await import('../src/motion/layout.js');
  const h = harness();
  const root = Object.assign(h.element, {
    ownerDocument: { defaultView: { matchMedia: () => ({ matches: true }) } },
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  });
  Object.assign(root.style, { getPropertyPriority: () => '' });
  const before = { ...work };
  const mutate = vi.fn();
  const run = layout(root, mutate, { spring });
  expect(run.duration).toBe(0);
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(work.builds).toBe(before.builds);

});

it('sequence snapshots system motion preference once for the entire operation', async () => {
  const h = harness();
  let reads = 0;
  h.host.reduced = () => ++reads === 1;
  const before = { ...work };
  const opts = { spring };
  const run = h.runtime.sequence([[h.element, { x: 101 }, opts], [h.element, { x: 302 }, opts]]);
  expect(reads).toBe(1);
  expect(run.duration).toBe(0);
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.x()).toBe(302);

  expect(work.builds).toBe(before.builds);
});
