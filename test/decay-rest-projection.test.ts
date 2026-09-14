import { describe, expect, it } from 'vitest';
import { createDecay, projectDefaultDecayRest } from '../src/decay.js';
import { lcg } from './projection-helpers.js';

describe('проекция default decay без создания полной модели', () => {
  it('сохраняет точные known endpoints', () => {
    expect(projectDefaultDecayRest(10, 0)).toBe(10);
    expect(projectDefaultDecayRest(0, 100)).toBe(28);
    expect(projectDefaultDecayRest(0, -100)).toBe(-28);
    // Независимые bit-level pins: заранее свёрнутые 0.8*0.35 дают 3 MIN, не 2.
    expect(Object.is(projectDefaultDecayRest(0, 9 * Number.MIN_VALUE), 2 * Number.MIN_VALUE)).toBe(true);
    expect(Object.is(projectDefaultDecayRest(0, -9 * Number.MIN_VALUE), -2 * Number.MIN_VALUE)).toBe(true);
    expect(Object.is(projectDefaultDecayRest(-0, -0), -0)).toBe(true);
    expect(projectDefaultDecayRest(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(projectDefaultDecayRest(-Number.MAX_VALUE, -Number.MAX_VALUE)).toBe(-Number.MAX_VALUE);
  });

  it('Object.is parity с полной моделью на границах IEEE и 10000 finite входов', () => {
    const edges = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 1e-308, -1e-308,
      1, -1, Number.MAX_VALUE, -Number.MAX_VALUE];
    const check = (from: number, velocity: number) => {
      expect(Object.is(projectDefaultDecayRest(from, velocity), createDecay({ from, velocity }).rest)).toBe(true);
    };
    for (const from of edges) for (const velocity of edges) check(from, velocity);
    const random = lcg(0x1badb002);
    const finite = () => (random() < 0.5 ? -1 : 1) * random() * 2 ** (Math.floor(random() * 2097) - 1074);
    for (let i = 0; i < 10000; i++) check(finite(), finite());
  });

  it('не меняет fail-fast codes и приоритет ошибок входа', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => projectDefaultDecayRest(value, 0)).toThrow('LM021');
      expect(() => projectDefaultDecayRest(0, value)).toThrow('LM022');
      expect(() => projectDefaultDecayRest(value, value)).toThrow('LM021');
    }
  });
});
