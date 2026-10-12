import { expect, it } from 'vitest';
import { program, repeatProgram, sample } from '../src/motion/program.js';
import { authoredTiming, timing } from '../src/motion/timing.js';
import { repeat } from '../src/motion/repeat.js';
import { repetition } from '../src/motion/repeat-contract.js';
import { repeatCursor } from '../src/internal/repeat-cursor.js';
import { harness } from './fixtures/motion-runtime.js';

it('направление скорости и удержание принадлежат тому же cursor, что и progress', () => {
  const state = { rate: NaN };
  expect(repeatCursor(25, 0, 100, 1, 20, 1, state)).toBe(.25); expect(state.rate).toBe(1);
  expect(repeatCursor(110, 0, 100, 1, 20, 1, state)).toBe(1); expect(state.rate).toBe(0);
  expect(repeatCursor(145, 0, 100, 1, 20, 1, state)).toBe(.75); expect(state.rate).toBe(-1);
  expect(repeatCursor(220, 0, 100, 1, 20, 1, state)).toBe(0); expect(state.rate).toBe(0);
  repeatCursor(1e-310, 0, 2e-310, 1, 0, 0, state); expect(state.rate).toBe(1);
});

it('одна траектория и одно рабочее место сохраняются при 10000 семплах', () => {
  const original = program('x', { _coordinates: [0], unit: '' }, [0, 100], true, authoredTiming(timing({ duration: 100 })), [0]);
  const loop = repeatProgram(original, repetition(repeat(Infinity, { type: 'reverse', delay: 20 }).repeat)!);
  const values = [0], velocity = [0], workspace = loop._repeat!._sample;
  for (let t = 0; t < 10000; t++) {
    sample(loop, t, values, velocity);
    expect(loop._segments).toBe(original._segments); expect(loop._repeat!._sample).toBe(workspace);
  }
  sample(loop, 145, values, velocity); expect(values[0]).toBe(75); expect(velocity[0]).toBeCloseTo(-1000, 6);
  sample(loop, 110, values, velocity); expect(velocity[0]).toBe(0);
});

it('retarget пружины получает отрицательную скорость обратного прохода', () => {
  const h = harness();
  h.runtime.animate(h.element, { x: [0, 100] }, { duration: 100, ...repeat(1, { type: 'reverse' }) });
  h.step(125); expect(h.x()).toBe(75);
  const successor = h.runtime.animate(h.element, { x: 200 });
  h.step(125.001); expect(h.x()).toBeLessThan(75);
  successor.finish(); expect(h.x()).toBe(200);
});

it('не объявляет repeatDelay и нелинейный mirror эквивалентными WAAPI alternate', () => {
  for (const options of [{ ...repeat(1, { delay: 10 }) }, { ...repeat(1, { type: 'mirror' }), ease: 'ease-in' as const }]) {
    const h = harness(true);
    const run = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 100, ...options });
    expect(h.effects).toHaveLength(0); expect(h.updates.size).toBe(1); run.stop();
  }
});
