/**
 * Дифференциальный пин внутреннего hot-path пружины.
 * Граница API валидирует входы один раз; движк сэмплирует кадры без
 * validator/settle-расчёта, но результат обязан остаться бит-в-бит.
 */

import { describe, expect, it, vi } from 'vitest';

const work = vi.hoisted(() => ({ solves: 0 }));

vi.mock('../src/internal/solver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/internal/solver.js')>();
  return {
    ...actual,
    solveSpring(...args: Parameters<typeof actual.solveSpring>) {
      work.solves++;
      return actual.solveSpring(...args);
    },
  };
});

import { readSpringUnchecked, sampleSpringUnchecked } from '../src/internal/read-spring.js';
import { solveSpring } from '../src/internal/solver.js';
import type { SpringParams } from '../src/spring.js';

const SPRINGS: readonly SpringParams[] = [
  { mass: 1, stiffness: 100, damping: 10 },
  { mass: 1, stiffness: 100, damping: 20 },
  { mass: 1, stiffness: 100, damping: 30 },
];

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Независимый oracle: сырой solver + явно записанная публичная finite-policy. */
function expectedRead(
  spring: SpringParams,
  from: number,
  to: number,
  v0: number,
  t: number,
): { value: number; velocity: number } {
  const raw = solveSpring(spring, t, v0);
  const value = finiteOr(raw.value, 1);
  const velocity = finiteOr(raw.velocity, 0);
  const range = to - from;
  return {
    value: finiteOr(from + value * range, to),
    velocity: finiteOr(velocity * range, 0),
  };
}

describe('readSpringUnchecked — независимый parity/structure seal', () => {
  it('совпадает бит-в-бит с raw-solver oracle во всех режимах затухания', () => {
    for (const spring of SPRINGS) {
      for (const [from, to, v0] of [
        [0, 1, 0],
        [120, -40, 1.25],
        [-1e200, 1e200, -3],
      ] as const) {
        for (const t of [-1, 0, 1 / 240, 0.17, 2, 32]) {
          const expected = expectedRead(spring, from, to, v0, t);
          const actual = readSpringUnchecked(spring, from, to, v0, t);
          expect(Object.is(actual.value, expected.value)).toBe(true);
          expect(Object.is(actual.velocity, expected.velocity)).toBe(true);
        }
      }
    }
  });

  it('переиспользует буфер вместо аллокации результата', () => {
    const out = { value: 0, velocity: 0 };
    expect(readSpringUnchecked(SPRINGS[0]!, 10, 20, 0, 0.2, out)).toBe(out);
    expect(Number.isFinite(out.value)).toBe(true);
    expect(Number.isFinite(out.velocity)).toBe(true);
  });

  it('один solve и только две итоговые записи в caller-owned buffer', () => {
    let reads = 0;
    let writes = 0;
    const target = { value: 0, velocity: 0 };
    const out = new Proxy(target, {
      get(object, key, receiver) {
        reads++;
        return Reflect.get(object, key, receiver);
      },
      set(object, key, value, receiver) {
        writes++;
        return Reflect.set(object, key, value, receiver);
      },
    });
    const before = work.solves;
    expect(readSpringUnchecked(SPRINGS[0]!, 10, 20, 0.25, 0.2, out)).toBe(out);
    expect(work.solves - before).toBe(1);
    expect({ reads, writes }).toEqual({ reads: 0, writes: 2 });
  });

  it('сохраняет finite-policy на IEEE-754 краях и unchecked времени', () => {
    const bounds = [
      [-0, 0],
      [Number.MIN_VALUE, -Number.MIN_VALUE],
      [Number.MAX_VALUE, -Number.MAX_VALUE],
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MAX_VALUE, Number.MAX_VALUE],
    ] as const;
    for (const spring of SPRINGS) {
      for (const [from, to] of bounds) {
        for (const v0 of [-Number.MAX_VALUE, -0, Number.MIN_VALUE, Number.MAX_VALUE]) {
          for (const t of [-Infinity, -0, Number.MIN_VALUE, 1 / 240, Infinity, NaN]) {
            const expected = expectedRead(spring, from, to, v0, t);
            const actual = readSpringUnchecked(spring, from, to, v0, t);
            expect(Object.is(actual.value, expected.value)).toBe(true);
            expect(Object.is(actual.velocity, expected.velocity)).toBe(true);
            expect(Number.isFinite(actual.value)).toBe(true);
            expect(Number.isFinite(actual.velocity)).toBe(true);
          }
        }
      }
    }
  });

  it('нормализованный сэмплер бит-в-бит равен ranged-пути 0→1', () => {
    for (const spring of SPRINGS) {
      for (const v0 of [-3, 0, 2.5]) {
        for (const t of [0, 1 / 240, 0.3, 4, 32]) {
          const normalized = sampleSpringUnchecked(spring, v0, t);
          const ranged = readSpringUnchecked(spring, 0, 1, v0, t);
          expect(Object.is(normalized.value, ranged.value)).toBe(true);
          expect(Object.is(normalized.velocity, ranged.velocity)).toBe(true);
        }
      }
    }
  });
});
