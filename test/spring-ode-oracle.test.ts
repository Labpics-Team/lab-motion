import { describe, expect, it } from 'vitest';
import { integrateSpringPositions } from '../browser/fixtures/spring-ode.js';

const times = [0, 0.001, 0.125, 0.5, 1, 2, 4];

describe('независимое интегрирование m x″ + c x′ + k x = k', () => {
  for (const v0 of [-6, 0, 6]) {
    it(`согласуется с тремя элементарными решениями при v0=${v0}`, () => {
      const cases = [
        {
          spring: { mass: 1, stiffness: 25, damping: 6 },
          exact: (t: number) => 1 - Math.exp(-3 * t) * (
            Math.cos(4 * t) + (3 - v0) / 4 * Math.sin(4 * t)
          ),
        },
        {
          spring: { mass: 1, stiffness: 16, damping: 8 },
          exact: (t: number) => 1 + (-1 + (v0 - 4) * t) * Math.exp(-4 * t),
        },
        {
          spring: { mass: 1, stiffness: 12, damping: 8 },
          exact: (t: number) => 1 + (v0 - 6) / 4 * Math.exp(-2 * t)
            + (2 - v0) / 4 * Math.exp(-6 * t),
        },
      ];
      for (const { spring, exact } of cases) {
        const samples = integrateSpringPositions(spring, v0, times);
        const refined = integrateSpringPositions(spring, v0, times, 1 / 8192);
        samples.forEach((value, index) => {
          expect(Math.abs(value - exact(times[index]!))).toBeLessThan(2e-10);
          expect(Math.abs(value - refined[index]!)).toBeLessThan(2e-10);
        });
      }
    });
  }

  it('сохраняет начальное условие и повторные точки наблюдения', () => {
    expect(integrateSpringPositions({ mass: 1, stiffness: 16, damping: 8 }, 6, [0, 0])).toEqual([0, 0]);
    const samples = integrateSpringPositions({ mass: 1, stiffness: 16, damping: 8 }, 6, [0.5, 0.5]);
    expect(samples[0]).toBe(samples[1]);
  });

  it('отклоняет выход за численный и ресурсный диапазон вместо усечения', () => {
    const spring = { mass: 1, stiffness: 16, damping: 8 };
    for (const invalidTimes of [[], [-1], [NaN], [Infinity], [17], [1, 0], new Array<number>(16_386).fill(0)]) {
      expect(() => integrateSpringPositions(spring, 0, invalidTimes)).toThrow();
    }
    for (const step of [0, NaN, 1, 1 / 32768]) {
      expect(() => integrateSpringPositions(spring, 0, [1], step)).toThrow();
    }
    for (const invalid of [
      { ...spring, mass: 0 }, { ...spring, mass: NaN },
      { ...spring, stiffness: 257 }, { ...spring, damping: -1 },
    ]) {
      expect(() => integrateSpringPositions(invalid, 0, [1])).toThrow();
    }
    expect(() => integrateSpringPositions(spring, Infinity, [1])).toThrow();
  });
});
