import { expect, it, vi } from 'vitest';
import { properties, timing } from '../src/motion/model.js';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';

const options = { duration: 1000, ease: 'linear' } as const;

it('shares one Program per numeric property only within a multi-target draft batch', () => {
  const a = harness(), b = harness(), c = harness();
  const targets = [a.element, b.element, c.element];
  const input = properties({ x: 100, width: 100, opacity: 0 });
  const clock = timing(options);
  const reads = vi.spyOn(a.host, 'styles');
  const drafts = a.runtime._draft(targets, input, clock);
  expect(reads.mock.calls.map(([element]) => element)).toEqual([a.element, a.element, a.element, b.element, b.element, b.element, c.element, c.element, c.element]);
  expect(drafts).toHaveLength(9);
  for (const index of [3, 6]) {
    expect(drafts[index]).not.toBe(drafts[0]);
    expect(drafts[index]!._program).toBe(drafts[0]!._program);
    expect(drafts[index + 1]!._program).not.toBe(drafts[1]!._program);
    expect(drafts[index + 2]!._program).toBe(drafts[2]!._program);
  }
  expect(drafts[0]!._program).not.toBe(drafts[2]!._program);
  const again = a.runtime._draft(targets, input, clock);
  expect(again[0]!._program).not.toBe(drafts[0]!._program);
  const single = a.runtime._draft(a.element, input, clock);
  expect(single[0]!._program).not.toBe(drafts[0]!._program);
  reads.mockRestore();
});

it('replaces the one property slot rather than retaining unlike earlier starts', () => {
  const a = harness(), b = harness(), c = harness(), d = harness();
  b.element.style.setProperty('transform', 'translate(20px,0px)');
  const drafts = a.runtime._draft([a.element, b.element, c.element, d.element], properties({ x: 100 }), timing(options));
  expect(drafts[1]!._program).not.toBe(drafts[0]!._program);
  expect(drafts[2]!._program).not.toBe(drafts[0]!._program);
  expect(drafts[3]!._program).toBe(drafts[2]!._program);
  const run = a.runtime._execute(drafts);
  try {
    run.seek(500);
    expect([a.x(), b.x(), c.x(), d.x()]).toEqual([50, 60, 50, 50]);
  } finally { run.stop(); }
});

it('does not share staggered offsets and preserves the delayed target pose', () => {
  const a = harness(), b = harness();
  const drafts = a.runtime._draft([a.element, b.element], properties({ x: 100 }), timing({ ...options, stagger: 100 }));
  expect(drafts[0]!._program).not.toBe(drafts[1]!._program);
  expect(drafts.map(draft => draft._program._segments[0]!._at)).toEqual([0, 100]);
  const run = a.runtime._execute(drafts);
  try { run.seek(50); expect(a.x()).toBe(5); expect(b.x()).toBe(0); }
  finally { run.stop(); }
});

it('does not share equal positions with different real interruption velocities', () => {
  const a = harness(), b = harness();
  const first = a.runtime.animate(a.element, { x: 100 }, options);
  const second = a.runtime.animate(b.element, { x: 200 }, options);
  try {
    first.seek(500); second.seek(250);
    expect(a.x()).toBe(50); expect(b.x()).toBe(50);
    const drafts = a.runtime._draft([a.element, b.element], properties({ x: 300 }), timing(options));
    const [left, right] = drafts.map(draft => draft._program);
    expect(left).not.toBe(right);
    expect(left!._segments[0]!._from).toEqual(right!._segments[0]!._from);
    expect(left!._segments[0]!._velocity[0]).toBeCloseTo(100, 8);
    expect(right!._segments[0]!._velocity[0]).toBeCloseTo(200, 8);
  } finally { first.stop(); second.stop(); }
});

it('keeps signed-zero origin snapshots distinct', () => {
  const a = harness(), b = harness();
  const drafts = a.runtime._draft([a.element, b.element], properties({ x: 100 }), timing(options), 0,
    element => ({ _coordinates: [element === a.element ? -0 : 0], _unit: '' }));
  expect(drafts[0]!._program).not.toBe(drafts[1]!._program);
  expect(Object.is(drafts[0]!._program._segments[0]!._from[0], -0)).toBe(true);
  expect(Object.is(drafts[1]!._program._segments[0]!._from[0], 0)).toBe(true);
});

it('leaves spring, authored, string literal and non-motion property Programs unshared', () => {
  const a = harness(), b = harness();
  for (const [props, clock] of [
    [properties({ x: 100 }), timing(undefined)],
    [properties({ x: [0, 100] }), timing(options)],
    [properties({ opacity: [0, 1] }), timing(options)],
    [properties({ width: '100px' }), timing(options)],
    [properties({ width: 100 }), timing(options)],
  ] as const) {
    const drafts = a.runtime._draft([a.element, b.element], props, clock);
    expect(drafts[0]!._program).not.toBe(drafts[1]!._program);
  }
  expect(() => a.runtime._draft([a.element, b.element], properties({ x: '100' }), timing(options))).toThrow();
});

it('still rejects a later incompatible range before publishing any target', () => {
  const a = harness(), b = harness();
  b.element.style.setProperty('transform', `translate(${-Number.MAX_VALUE}px,0px)`);
  a.writes.length = 0; b.writes.length = 0;
  expect(() => a.runtime.animate([a.element, b.element], { x: Number.MAX_VALUE }, options)).toThrow();
  expect(a.writes).toEqual([]); expect(b.writes).toEqual([]);
  expect(a.updates.size + a.renders.size).toBe(0);
});

it('still resolves per-element variables without sharing or changing their start order', () => {
  const a = harness(), b = harness();
  a.values.set('--target', '100px'); b.values.set('--target', '200px');
  const run = a.runtime.animate([a.element, b.element], { width: 'var(--target)' }, options);
  try {
    run.seek(500);
    expect(a.values.get('width')).toBe('50px');
    expect(b.values.get('width')).toBe('100px');
  } finally { run.stop(); }
});

it('shared Programs retain distinct Tracks, buffers and independent successor controllers', async () => {
  const a = harness(), b = harness();
  const drafts = a.runtime._draft([a.element, b.element], properties({ x: 100 }), timing(options));
  expect(drafts[0]!._program).toBe(drafts[1]!._program);
  const previous = a.runtime._execute(drafts) as Run;
  const tracks = [...previous._tracks];
  expect(tracks).toHaveLength(2);
  expect(tracks[0]).not.toBe(tracks[1]);
  expect(tracks[0]!._value).not.toBe(tracks[1]!._value);
  expect(tracks[0]!._velocity).not.toBe(tracks[1]!._velocity);
  const successor = a.runtime.animate(a.element, { x: 200 }, options);
  try {
    successor.seek(500); expect(a.x()).toBe(100); expect(b.x()).toBe(0);
    previous.stop();
    expect(await previous.finished).toEqual({ status: 'stopped' });
    expect(successor.state).toBe('running');
    successor.finish();
    expect(await successor.finished).toEqual({ status: 'finished' });
    expect(a.x()).toBe(200); expect(b.x()).toBe(0);
    expect(a.updates.size + a.renders.size).toBe(0);
  } finally { previous.stop(); successor.stop(); }
});

it('sequence copies shared draft Programs before extending a single target history', async () => {
  const a = harness(), b = harness();
  const draft = vi.spyOn(a.runtime, '_draft');
  const execute = vi.spyOn(a.runtime, '_execute');
  const run = a.runtime.sequence([
    [[a.element, b.element], { x: 100 }, options],
    [a.element, { x: 200 }, options],
  ]);
  try {
    const originals = draft.mock.results[0]!.value;
    expect(originals[0]!._program).toBe(originals[1]!._program);
    const original = originals[0]!._program;
    expect(original._segments).toHaveLength(1);
    expect(original._duration).toBe(1000);
    expect(original._nativeEase).toBe('linear');
    expect(original._identity).toBeDefined();
    const merged = execute.mock.calls[0]![0];
    const left = merged.find(item => item._element === a.element)!._program;
    const right = merged.find(item => item._element === b.element)!._program;
    expect(left).not.toBe(original); expect(right).not.toBe(original);
    expect(left._segments).not.toBe(right._segments);
    expect(left._segments).not.toBe(original._segments);
    expect(right._segments).not.toBe(original._segments);
    expect(left._segments).toHaveLength(2); expect(right._segments).toHaveLength(1);
    run.seek(1500); expect(a.x()).toBe(150); expect(b.x()).toBe(100);
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(a.x()).toBe(200); expect(b.x()).toBe(100);
    expect(original._segments).toHaveLength(1); expect(original._duration).toBe(1000);
  } finally { run.stop(); draft.mockRestore(); execute.mockRestore(); }
});

for (const reduced of [false, true]) it(`authored Programs publish synchronous completion without effects, reduced=${reduced}`, async () => {
  const a = harness(true), b = harness(true);
  const drafts = a.runtime._draft([a.element, b.element], properties({ x: [20, 100] }), timing({
    ...options, duration: reduced ? 1000 : 0, reducedMotion: reduced ? 'always' : 'user',
  }));
  expect(drafts[0]!._program).not.toBe(drafts[1]!._program);
  const run = a.runtime._execute(drafts);
  expect(a.x()).toBe(100); expect(b.x()).toBe(100);
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(a.effects.length + b.effects.length).toBe(0);
  expect(a.updates.size + a.renders.size).toBe(0);
});
