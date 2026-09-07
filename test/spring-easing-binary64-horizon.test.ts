import { describe, expect, it } from 'vitest';

import { springAsEasing } from '../src/spring/index.js';

/**
 * Пины результата до оптимизации горизонта. Значения получены независимым
 * 80-шаговым binary64 oracle и намеренно проверяются через Object.is: именно
 * representational equivalence позволяет удалить пустые итерации бисекции.
 * Deliberate sabotage 60→52 меняет каждый из этих witnesses и делает тест RED.
 */
const CASES = [
  {
    params: { mass: 1, stiffness: 100, damping: 10 }, // ζ=0.5
    t: 0.01,
    expected: 0.00844297539430574,
  },
  {
    params: { mass: 1, stiffness: 100, damping: 19.98 }, // ζ=0.999
    t: 0.013,
    expected: 0.005388003045513621,
  },
  {
    params: { mass: 1, stiffness: 100, damping: 20.002 }, // ζ=1.0001
    t: 0.03,
    expected: 0.026119210167776755,
  },
] as const;

describe('springAsEasing: предел binary64 горизонта', () => {
  it('сохраняет bit-exact результат 80-шагового oracle', () => {
    for (const { params, t, expected } of CASES) {
      expect(Object.is(springAsEasing(params)(t), expected)).toBe(true);
    }
  });
});
