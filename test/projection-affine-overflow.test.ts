import { describe, expect, it } from 'vitest';
import { lerp1, mixBox } from '../src/projection/geometry.js';

const M = Number.MAX_VALUE;

function rect(x: number) {
  return { x, y: x, width: 10, height: 10 };
}

describe('переполнение аффинной интерполяции projection', () => {
  it('сохраняет точные конечные точки после враждебного конечного вычитания', () => {
    expect(lerp1(100, Number.MIN_VALUE, 1)).toBe(Number.MIN_VALUE);
    expect(lerp1(-100, -Number.MIN_VALUE, 1)).toBe(-Number.MIN_VALUE);
    expect(Object.is(lerp1(-0, 7, 0), 0)).toBe(true);
  });

  it('сохраняет математическую середину при переполнении разности концов', () => {
    expect(lerp1(M, -M, 0.5)).toBe(0);
    expect(lerp1(-M, M, 0.5)).toBe(0);
  });

  it('mixBox наследует тот же закон середины для координат page-space', () => {
    const a = mixBox(rect(M), rect(-M), 0.5);
    const b = mixBox(rect(-M), rect(M), 0.5);
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  it('остаётся конечной и внутри выпуклой оболочки при ограниченном progress', () => {
    const values = [M, M / 2, 1e300, 1e200];
    for (const a of values) {
      for (const b of values) {
        for (const sign of [1, -1]) {
          const from = sign * a;
          const to = -sign * b;
          for (const t of [Number.MIN_VALUE, 0.125, 0.25, 0.5, 0.75, 0.875, 1 - Number.EPSILON]) {
            const value = lerp1(from, to, t);
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(Math.min(from, to));
            expect(value).toBeLessThanOrEqual(Math.max(from, to));
          }
        }
      }
    }
  });
});
