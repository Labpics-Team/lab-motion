import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback } from '../src/motion/types.js';

const linear = { duration: 1000, ease: 'linear' } as const;

it('одна цель использует снимок authored literals и сохраняет относительную единицу', () => {
  const h = harness();
  let reads = 0;
  const frames = Object.defineProperty(['10px', '+=20px'], 1, {
    get() { return ++reads === 1 ? '+=20px' : '+=999px'; },
  });
  const run = h.runtime.animate(h.element, { width: frames }, linear);
  try {
    expect(reads).toBe(1);
    run.seek(500); expect(h.values.get('width')).toBe('20px');
    run.finish(); expect(h.values.get('width')).toBe('30px');
    expect(reads).toBe(1);
  } finally { run.stop(); }
});

it('stagger literal сохраняет независимые origins и смещение времени', () => {
  const a = harness(), b = harness();
  a.values.set('width', '10px'); b.values.set('width', '30px');
  const run = a.runtime.animate([a.element, b.element], { width: '+=20px' }, { ...linear, stagger: 100 });
  try {
    run.seek(500);
    expect(a.values.get('width')).toBe('20px'); expect(b.values.get('width')).toBe('38px');
    run.finish();
    expect(a.values.get('width')).toBe('30px'); expect(b.values.get('width')).toBe('50px');
  } finally { run.stop(); }
});

it.each([1, 2])('CSS var разрешается заново для %i целей и каждого запуска', (count) => {
  const a = harness(), b = harness();
  const targets = [a.element, b.element].slice(0, count);
  const options = { ...linear, stagger: count === 1 ? 0 : 100 };
  const props = { width: ' \t VaR(--goal)' };
  a.values.set('--goal', '100px'); b.values.set('--goal', '200px');
  const first = a.runtime.animate(targets, props, options);
  let next: Playback | undefined;
  try {
    first.seek(500);
    expect(a.values.get('width')).toBe('50px');
    if (count === 2) expect(b.values.get('width')).toBe('80px');
    first.stop();
    a.values.set('--goal', '300px'); b.values.set('--goal', '400px');
    next = a.runtime.animate(targets, props, options);
    next.seek(500);
    expect(a.values.get('width')).toBe('175px');
    if (count === 2) expect(b.values.get('width')).toBe('208px');
  } finally { first.stop(); next?.stop(); }
  expect(() => a.runtime.animate(targets, { width: ' \t VaR(' }, options)).toThrow('CSS var не найдена');
  expect(a.updates.size + a.renders.size).toBe(0);
});
