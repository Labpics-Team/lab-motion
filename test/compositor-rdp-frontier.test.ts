import { describe, expect, it, vi } from 'vitest';
import { douglasPeuckerVertical } from '../src/compositor/segmenter.js';

/**
 * Независимое рекурсивное определение RDP: объединяет упорядоченные половины.
 * Не знает о производственном стеке, bitmap или направлении обхода.
 */
function reference(xs: readonly number[], ys: readonly number[], eps: number, anchor = -1): number[] {
  if (xs.length === 0) return [];
  function visit(left: number, right: number): number[] {
    if (left === right) return [left];
    if (right === left + 1) return [left, right];
    const slope = (ys[right]! - ys[left]!) / (xs[right]! - xs[left]!);
    let split = -1;
    let largest = -1;
    for (let index = left + 1; index < right; index++) {
      const deviation = Math.abs(ys[index]! - (ys[left]! + slope * (xs[index]! - xs[left]!)));
      if (deviation > largest) {
        largest = deviation;
        split = index;
      }
    }
    if (!(largest > eps)) return [left, right];
    return [...visit(left, split).slice(0, -1), ...visit(split, right)];
  }
  const last = xs.length - 1;
  return anchor > 0 && anchor < last
    ? [...visit(0, anchor).slice(0, -1), ...visit(anchor, last)]
    : visit(0, last);
}

function corpus(): Array<{ xs: number[]; ys: number[]; eps: number; anchor: number }> {
  let seed = 0x73e2d11;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: 2048 }, (_, test) => {
    const count = test % 129;
    let coordinate = -100;
    const xs = Array.from({ length: count }, () => (coordinate += 0.01 + random() * 2));
    const ys = xs.map((x, index) => test % 4 === 0
      ? index % 2 === 0 ? -1 : 1
      : test % 4 === 1 ? Math.sin(x) * Math.exp(-index / 100)
        : test % 4 === 2 ? random() * 20 - 10 : x * 0.125);
    return { xs, ys, eps: test % 11 === 0 ? 0 : random(), anchor: test % (count + 2) - 1 };
  });
}

describe('RDP: монотонный фронтир без bitmap исходной сетки', () => {
  it('точно совпадает с рекурсивным определением на неравномерных и перекошенных полилиниях', () => {
    for (const { xs, ys, eps, anchor } of corpus()) {
      expect(douglasPeuckerVertical(xs, ys, eps, anchor)).toEqual(reference(xs, ys, eps, anchor));
    }
  });

  it('сохраняет концы, строгий порог и первый максимум при равных отклонениях', () => {
    expect(douglasPeuckerVertical([], [], 0)).toEqual([]);
    expect(douglasPeuckerVertical([0], [1], 0)).toEqual([0]);
    expect(douglasPeuckerVertical([0, 1], [2, 3], 0)).toEqual([0, 1]);
    const xs = [0, 1, 2, 3];
    const ys = [0, 1, 1, 0];
    expect(douglasPeuckerVertical(xs, ys, 1)).toEqual([0, 3]);
    expect(douglasPeuckerVertical(xs, ys, 1 - Number.EPSILON)).toEqual([0, 1, 3]);
    // Последний максимум дал бы [0, 2, 3], а разделение при равенстве добавило бы лишнюю точку.
    expect(reference(xs, ys, 1 - Number.EPSILON)).toEqual([0, 1, 3]);
  });

  it('защищённый узел разделяет независимые области даже на прямой', () => {
    const xs = [0, 0.01, 0.2, 0.7, 1];
    for (let anchor = -1; anchor <= xs.length; anchor++) {
      const expected = anchor > 0 && anchor < xs.length - 1 ? [0, anchor, 4] : [0, 4];
      expect(douglasPeuckerVertical(xs, xs, 1, anchor)).toEqual(expected);
    }
  });

  it('не выделяет bitmap; положительный контроль видит выделение Uint8Array', () => {
    const Native = Uint8Array;
    let allocations = 0;
    const observed = new Proxy(Native, {
      construct(target, args, newTarget) {
        allocations++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    vi.stubGlobal('Uint8Array', observed);
    let actual: number[];
    try {
      // Проверяем сам измерительный шов перед производственным вызовом.
      void new Uint8Array(4);
      expect(allocations).toBe(1);
      allocations = 0;
      actual = douglasPeuckerVertical([0, 1, 2, 3], [0, 1, -1, 0], 0.1, 1);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(allocations).toBe(0);
    expect(actual!).toEqual([0, 1, 2, 3]);
  });

  it('обрабатывает предельную сетку итеративно, без потери или дублирования индексов', () => {
    const xs = Array.from({ length: 4098 }, (_, i) => i);
    const ys = xs.map((i) => i % 2 === 0 ? 1 : -1);
    expect(douglasPeuckerVertical(xs, ys, 0, 1)).toEqual(xs);
  });
});