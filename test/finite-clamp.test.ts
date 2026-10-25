import { describe, expect, it } from 'vitest';
import { clampFinite } from '../src/internal/finite.js';
import { clampFinite as valueClamp } from '../src/value/units.js';

const cases: readonly (readonly [number, number])[] = [
  [0, 0],
  [-0, -0],
  [1, 1],
  [-1, -1],
  [Number.MIN_VALUE, Number.MIN_VALUE],
  [-Number.MIN_VALUE, -Number.MIN_VALUE],
  [Number.MAX_VALUE, Number.MAX_VALUE],
  [-Number.MAX_VALUE, -Number.MAX_VALUE],
  [NaN, 0],
  [Infinity, Number.MAX_VALUE],
  [-Infinity, -Number.MAX_VALUE],
];

for (const [name, clamp] of [
  ['общий страж', clampFinite],
  ['внутренний экспорт value', valueClamp],
] as const) {
  describe(`clampFinite: ${name}`, () => {
    it.each(cases)('сохраняет численный контракт для %s', (input, expected) => {
      expect(clamp(input)).toBe(expected);
      expect(Number.isFinite(clamp(input))).toBe(true);
    });
  });
}
