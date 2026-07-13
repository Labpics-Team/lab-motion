/**
 * Результат stagger одновременно служит рабочим буфером расстояний. Так массовый
 * каскад не создаёт второй массив того же размера перед первым кадром.
 */

import { describe, expect, it } from 'vitest';
import { stagger } from '../src/stagger/index.js';

function countSizedArrays<T>(size: number, run: () => T): { value: T; count: number } {
  const NativeArray = globalThis.Array;
  let count = 0;
  const TrackedArray = new Proxy(NativeArray, {
    construct(target, args, newTarget) {
      if (args.length === 1 && args[0] === size) count++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  (globalThis as { Array: ArrayConstructor }).Array = TrackedArray;
  try {
    return { value: run(), count };
  } finally {
    (globalThis as { Array: ArrayConstructor }).Array = NativeArray;
  }
}

describe('stagger: один O(N)-массив на расчёт', () => {
  it.each([
    ['линейная геометрия', undefined],
    ['grid-геометрия', { columns: 7 }],
  ] as const)('%s', (_name, grid) => {
    const n = 257;
    const measured = countSizedArrays(n, () => stagger(n, {
      gap: 13,
      from: 'center',
      grid,
      easing: (t) => t * t,
    }));

    expect(measured.value).toHaveLength(n);
    expect(measured.value.every(Number.isFinite)).toBe(true);
    expect(measured.count).toBe(1);
  });
});
