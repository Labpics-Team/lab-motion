import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback } from '../src/motion/types.js';

const linear = { duration: 1000, ease: 'linear' } as const;
type Track = { _value: number[]; _velocity: number[] };
function track(h: ReturnType<typeof harness>, element: Element, key: string): Track {
  const registry = (h.runtime as unknown as {
    _surfaces: WeakMap<Element, Record<string, { _tracks: Map<string, Track> }>>;
  })._surfaces;
  return registry.get(element)![key === 'x' ? 'transform' : key]!._tracks.get(key)!;
}

it('группа не связывает состояние и полномочия отдельных целей', async () => {
  const a = harness(), b = harness();
  const group = a.runtime.animate([a.element, b.element], { x: 100, opacity: 0 }, linear);
  let successor: Playback | undefined;
  try {
    for (const key of ['x', 'opacity']) {
      const first = track(a, a.element, key), second = track(a, b.element, key);
      expect(first._value).not.toBe(second._value);
      expect(first._velocity).not.toBe(second._velocity);
    }
    a.step(250); expect(a.x()).toBe(25); expect(b.x()).toBe(25);
    successor = a.runtime.animate(b.element, { x: 200 }, linear);
    a.step(500);
    expect(a.x()).toBe(50); expect(b.x()).toBe(68.75);
    expect(a.values.get('opacity')).toBe('0.5'); expect(b.values.get('opacity')).toBe('0.5');
    group.stop();
    expect(await group.finished).toEqual({ status: 'stopped' });
    expect(successor.state).toBe('running');
    a.step(1250);
    expect(a.x()).toBe(50); expect(b.x()).toBe(200);
    expect(await successor.finished).toEqual({ status: 'finished' });
    expect(a.updates.size + a.renders.size).toBe(0);
  } finally { group.stop(); successor?.stop(); }
});

it('разные начальные координаты сохраняют независимые траектории', () => {
  const a = harness(), b = harness();
  a.values.set('transform', 'translate(10px,0px)');
  b.values.set('transform', 'translate(20px,0px)');
  const run = a.runtime.animate([a.element, b.element], { x: 100 }, linear);
  try {
    run.seek(500); expect(a.x()).toBe(55); expect(b.x()).toBe(60);
    run.finish(); expect(a.x()).toBe(100); expect(b.x()).toBe(100);
  } finally { run.stop(); }
});

it('одинаковая поза с разной скоростью подхватывается независимо', () => {
  const a = harness(), b = harness();
  const moving = a.runtime.animate(a.element, { x: [0, 100] }, linear);
  const rested = a.runtime.animate(b.element, { x: [0, 50] }, { duration: 500, ease: 'linear' });
  let next: Playback | undefined;
  try {
    a.step(500); expect(a.x()).toBe(50); expect(b.x()).toBe(50);
    next = a.runtime.animate([a.element, b.element], { x: 200 });
    next.seek(100); expect(a.x()).toBeGreaterThan(b.x());
    next.finish(); expect(a.x()).toBe(200); expect(b.x()).toBe(200);
  } finally { moving.stop(); rested.stop(); next?.stop(); }
});

it('относительные значения не смешивают единицы разных элементов', () => {
  const a = harness(), b = harness();
  a.values.set('--distance', '1px'); b.values.set('--distance', '1em');
  const run = a.runtime.animate([a.element, b.element], { '--distance': '+=1' }, linear);
  try {
    run.seek(500);
    expect(a.values.get('--distance')).toBe('1.5px'); expect(b.values.get('--distance')).toBe('1.5em');
  } finally { run.stop(); }
});

it('одинаковый CSS var разрешается на каждом элементе', () => {
  const a = harness(), b = harness();
  a.values.set('--goal', '100px'); b.values.set('--goal', '200px');
  const run = a.runtime.animate([a.element, b.element], { width: ' var(--goal)' }, linear);
  try {
    run.seek(500); expect(a.values.get('width')).toBe('50px'); expect(b.values.get('width')).toBe('100px');
  } finally { run.stop(); }
});

it('stagger сохраняет раздельные временные начала', () => {
  const a = harness(), b = harness();
  const run = a.runtime.animate([a.element, b.element], { x: [0, 100] }, { ...linear, stagger: 100 });
  try {
    run.seek(500); expect(a.x()).toBe(50); expect(b.x()).toBe(40);
  } finally { run.stop(); }
});

it('пользовательский easing исполняется для каждой цели группы', () => {
  const a = harness(), b = harness();
  let samples = 0;
  const run = a.runtime.animate([a.element, b.element], { x: [0, 100] }, {
    duration: 1000, ease(t) { samples++; return t; },
  });
  try {
    a.step(500);
    expect(samples).toBe(6);
    expect(a.x()).toBe(50); expect(b.x()).toBe(50);
  } finally { run.stop(); }
});
