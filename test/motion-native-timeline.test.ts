import { expect, it } from 'vitest';
import { program } from '../src/motion/program.js';
import { timing } from '../src/motion/model.js';
import { harness } from './fixtures/motion-runtime.js';

it('canonical boundaries make every adjacent authored interval exactly contiguous', () => {
  const path = program('x', { _coordinates: [0], _unit: '' }, [0, 80, -20, 100], true,
    timing({ duration: 600, ease: 'linear', times: [0, .2, .7, 1] }), []);
  expect(path._segments.map(s => [s._at, s._end])).toEqual([[0, 120], [120, 420], [420, 600]]);
  expect(path._segments.every((s, i) => !i || s._at === path._segments[i - 1]!._end)).toBe(true);
});

it('continuous authored timeline uses one native effect and retains it during interior seek', async () => {
  const h = harness(true);
  const run = h.runtime.animate(h.element, { x: [0, 80, -20, 100] }, {
    duration: 600, ease: 'linear', times: [0, .2, .7, 1],
  });
  try {
    expect(h.effects).toHaveLength(1);
    const effect = h.effects[0]!;
    expect(effect.keys.map(k => k.offset)).toEqual([0, .2, .7, 1]);
    expect(effect.keys.map(k => k.transform)).toEqual([
      'translate(0px,0px)', 'translate(80px,0px)', 'translate(-20px,0px)', 'translate(100px,0px)',
    ]);
    expect(h.updates.size + h.renders.size).toBe(0);
    run.seek(270); expect(h.effects).toHaveLength(1); expect(effect.currentTime).toBe(270);
    effect.complete(); expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(100); expect(effect.cancelled).toBe(true);
  } finally { run.stop(); }
});

it('synchronized axes compose into one continuous native sequence', async () => {
  const h = harness(true), opts = { duration: 100, ease: 'linear' } as const;
  const run = h.runtime.sequence([[h.element, { x: [0, 40], y: [0, 20] }, opts],
    [h.element, { x: 80, y: 60 }, opts]]);
  try {
    expect(h.effects).toHaveLength(1);
    expect(h.effects[0]!.keys.map(k => k.offset)).toEqual([0, .5, 1]);
    expect(h.effects[0]!.keys.map(k => k.transform)).toEqual([
      'translate(0px,0px)', 'translate(40px,20px)', 'translate(80px,60px)',
    ]);
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
    expect([h.x(), h.y()]).toEqual([80, 60]);
  } finally { run.stop(); }
});

it('gaps, authored discontinuities and effectful curves retain the numerical executor', () => {
  const h = harness(true), opts = { duration: 100, ease: 'linear' } as const;
  for (const steps of [
    [[h.element, { x: [0, 40] }, opts], [h.element, { x: 80 }, { ...opts, at: 150 }]],
    [[h.element, { x: [0, 40] }, opts], [h.element, { x: [60, 80] }, opts]],
    [[h.element, { x: [0, 40] }, { duration: 100, ease: (x: number) => x }]],
  ] as const) {
    const run = h.runtime.sequence(steps);
    try { expect(h.effects).toHaveLength(0); expect(h.updates.size).toBe(1); }
    finally { run.stop(); }
  }
});
