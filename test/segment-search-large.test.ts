/** Дифференциальный пин binary-ветки длинных шкал: оракул намеренно линеен. */

import { describe, expect, it } from 'vitest';
import { sampleKeyframes } from '../src/keyframes/index.js';
import { interpolate } from '../src/utils/index.js';

function segment(times: readonly number[], x: number): number {
  let i = 0;
  while (i < times.length - 2 && x >= times[i + 1]!) i++;
  return i;
}

describe('segment search — длинные шкалы', () => {
  it('utils.interpolate: 1000 stops бит-в-бит совпадают с линейным оракулом', () => {
    const input = Array.from({ length: 1000 }, (_, i) => i / 7);
    const output = input.map((_, i) => i * 3 - 17);
    const map = interpolate(input, output, { clamp: false });
    for (const x of [-100, 0, 1 / 7, 19.25, input[998]!, input[999]!, 500]) {
      const i = segment(input, x);
      const p = (x - input[i]!) / (input[i + 1]! - input[i]!);
      const expected = p === 0 ? output[i]! : p === 1 ? output[i + 1]! : output[i]! + (output[i + 1]! - output[i]!) * p;
      expect(Object.is(map(x), expected)).toBe(true);
    }
  });

  it('sampleKeyframes: rightmost-семантика дублей times совпадает с линейным оракулом', () => {
    const n = 64;
    const values = Array.from({ length: n }, (_, i) => i * 10);
    const times = Array.from({ length: n }, (_, i) => Math.floor(i / 3) / Math.floor((n - 1) / 3));
    times[0] = 0;
    times[n - 1] = 1;
    const easings = new Array(n - 1).fill((t: number) => t);
    for (const p of [0, times[9]!, 0.37, times[60]!, 0.999, 1]) {
      const i = segment(times, p);
      const t0 = times[i]!;
      const t1 = times[i + 1]!;
      const expected = p <= times[0]!
        ? values[0]!
        : p >= times[n - 1]!
          ? values[n - 1]!
          : t1 <= t0
            ? values[i + 1]!
            : values[i]! + (values[i + 1]! - values[i]!) * ((p - t0) / (t1 - t0));
      expect(sampleKeyframes(values, times, easings, p)).toBe(expected);
    }
  });
});
