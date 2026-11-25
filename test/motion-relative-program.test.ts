import { expect, it } from 'vitest';
import { program, sample, validatePlacement } from '../src/motion/program.js';
import { timing, properties } from '../src/motion/model.js';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';

it('a dense staggered declaration has one Program, independent placements and live buffers', async () => {
  const h = harness();
  const targets = Array.from({ length: 64 }, () => harness());
  const values = Array.from({ length: 129 }, (_, i) => i);
  const drafts = h.runtime._draft(targets.map(t => t.element), properties({ x: values }),
    timing({ duration: 512, ease: 'linear', stagger: 4 }));
  expect(new Set(drafts.map(d => d._program)).size).toBe(1);
  expect(drafts.map(d => d._offset)).toEqual(targets.map((_, i) => 4 * i));
  const run = h.runtime._execute(drafts) as Run;
  try {
    expect(new Set([...run._tracks].map(t => t._value)).size).toBe(targets.length);
    expect(run.duration).toBe(764);
    for (const t of [0, 36, 255, 511, 80, 513]) {
      run.seek(t);
      for (let i = 0; i < targets.length; i++)
        expect(targets[i]!.x()).toBe(Math.max(0, Math.min(128, (t - 4 * i) / 4)));
    }
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
  } finally { run.stop(); }
});

it('constant-time placement certificate agrees with exact endpoint representability', () => {
  const offsets = [0, .1, 1, 1e5, 2 ** 52, 2 ** 53, 1e100, 1e308, Number.MAX_VALUE, Number.MIN_VALUE];
  const durations = [0, Number.MIN_VALUE, 2 ** -1000, 2 ** -50, .125, 1, 1e4, 1e100, 1e308];
  let checked = 0;
  for (const duration of durations) for (const times of [[0, 1], [0, .125, .75, 1], [0, 2 ** -20, .5, 1]]) {
    let path;
    try { path = program('x', { _coordinates: [0], _unit: '' }, times.map((_, i) => i), true,
      timing({ duration, ease: 'linear', times }), []); }
    catch { continue; } // Local shape itself is not representable.
    for (const offset of offsets) {
      const valid = Number.isFinite(offset + path._duration) && path._segments.every(s =>
        s._end === s._at || offset + s._end > offset + s._at);
      if (valid) expect(() => validatePlacement(path, offset)).not.toThrow();
      else expect(() => validatePlacement(path, offset)).toThrow(/Непредставимая длительность/);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(180);
});

it('fractional placement preserves exact authored starts and terminal endpoints', () => {
  const path = program('x', { _coordinates: [0], _unit: '' }, [0, 3, -2, 10], true,
    timing({ duration: 37.4, ease: 'linear', times: [0, .2, .7, 1] }), []);
  const value: number[] = [], velocity: number[] = [];
  for (const offset of [.1, 20.1, 12345.125]) {
    validatePlacement(path, offset);
    for (const s of path._segments) {
      sample(path, offset + s._at, value, velocity, 1, offset);
      expect(value).toEqual(s._from);
    }
    sample(path, offset + path._duration, value, velocity, 1, offset);
    expect(value).toEqual([10]); expect(velocity).toEqual([0]);
  }
});

it('sequence composes each equal history once, with a different history for the interrupted channel', async () => {
  const h = harness(), targets = Array.from({ length: 16 }, () => harness());
  const all = targets.map(t => t.element);
  const opts = { duration: 100, ease: 'linear' } as const;
  const run = h.runtime.sequence([[all, { x: [0, 100] }, opts], [all, { x: 200 }, opts],
    [all[0]!, { x: 300 }, opts]]) as Run;
  try {
    const tracks = [...run._tracks];
    expect(new Set(tracks.map(t => t._program)).size).toBe(2);
    expect(tracks[0]!._program._segments).toHaveLength(3);
    expect(tracks[1]!._program._segments).toHaveLength(2);
    run.seek(250); expect(targets[0]!.x()).toBe(250);
    for (const target of targets.slice(1)) expect(target.x()).toBe(200);
    run.seek(50); for (const target of targets) expect(target.x()).toBe(50);
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
  } finally { run.stop(); }
});
