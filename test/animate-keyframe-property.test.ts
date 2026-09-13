import { describe, expect, it } from 'vitest';
import { animate } from '../src/animate/index.js';
import { groupRecord } from '../src/animate/channels.js';
import { sampleKeyframes } from '../src/keyframes/index.js';
import { parseMotionProgramV1 } from '../src/internal/motion-program.js';
import { evaluateMotionProgramSegmentsV1, evaluateMotionProgramScheduleV1, resolveMotionProgramSegmentsV1 } from '../scripts/motion-program-semantics.js';
import { minimalProgramInput } from './motion-program-v1.fixtures.js';
import { fakeEl, translateXSeries } from './animate-facade-helpers.js';

const linear = (t: number): number => t;

/** Простой O(N) эталон: последний завершённый интервал и следующий непустой.
 * Не импортирует production locator, mix, sampler или derivative. */
function reference(values: readonly number[], times: readonly number[], p: number): [number, number] {
  if (p <= 0) return [values[0]!, times[1] === 0 ? 0 : (values[1]! - values[0]!) / times[1]!];
  if (p >= 1) return [values.at(-1)!, 0];
  let i = 0;
  for (let j = 1; j < times.length - 1; j++) if (times[j]! <= p) i = j;
  const span = times[i + 1]! - times[i]!;
  const delta = values[i + 1]! - values[i]!;
  return [values[i]! + delta * (p - times[i]!) / span, delta / span];
}

describe('N-keyframes: независимые позиции, производная и portable semantics', () => {
  it('seeded N=3/4/11: 12000 перемоток, дубликаты и обратный порядок seek', () => {
    let seed = 0x51de;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let run = 0; run < 1000; run++) {
      const n = [3, 4, 11][run % 3]!;
      const values = Array.from({ length: n }, () => Math.floor(random() * 2001) - 1000);
      const times = [0, ...Array.from({ length: n - 2 }, () => Math.floor(random() * 16) / 16).sort((a, b) => a - b), 1];
      const f = fakeEl();
      const controls = animate(f.el, { x: values }, { duration: 1000, times, requestFrame: () => 1 });
      for (let step = 0; step < 12; step++) {
        const p = step < times.length - 1 ? times[step]! : random();
        controls.seek(p * 1000);
        const [value, velocity] = reference(values, times, p);
        const actual = groupRecord(f.el, 'transform')._owner!._captureNum('x')!;
        // Четыре арифметических операции эталона и взвешенной реализации:
        // допуск << 1e-9 px на этом ограниченном целочисленном корпусе.
        expect(Math.abs(actual._value - value)).toBeLessThanOrEqual(2e-10);
        expect(Math.abs(actual._velocity - velocity)).toBeLessThanOrEqual(2e-8);
        expect(sampleKeyframes(values, times, Array(n - 1).fill(linear), p)).toBeCloseTo(value, 9);
      }
      controls.cancel();
    }
  });

  it('локальная квадратичная производная не пересекает authored jump', () => {
    const f = fakeEl();
    const controls = animate(f.el, { x: [0, 100, 40, 200] }, {
      duration: 1000, times: [0, .25, .25, 1], ease: [t => t * t, linear, t => t * t], requestFrame: () => 1,
    });
    controls.seek(625); // local t=0.5, Δ=160, span=.75s
    const snapshot = groupRecord(f.el, 'transform')._owner!._captureNum('x')!;
    expect(snapshot._value).toBe(80);
    expect(snapshot._velocity).toBeCloseTo(160 / .75, 8);
    controls.cancel();
  });

  it('existing MotionProgram V1 выражает uneven/zero-width track без нового IR', () => {
    const values = [0, 100, 40, 200], times = [0, .25, .25, 1];
    const input = minimalProgramInput();
    const track = (input[5] as unknown[][])[0]!;
    track[2] = 1000;
    // V1 хранит непустые интервалы; interior jump — разрыв между их operands,
    // а не запрещённый segment нулевой длины. Это public wire contract parser-а.
    track[7] = values.slice(0, -1).flatMap((from, i) => times[i] === times[i + 1] ? [] : [[times[i], times[i + 1], [1, [0, from]], [1, [0, values[i + 1]]], 0, 0]]);
    const parsed = parseMotionProgramV1(input);
    const f = fakeEl();
    const controls = animate(f.el, { x: values }, { duration: 1000, times, requestFrame: () => 1 });
    for (const p of [0, .125, .25 - Number.EPSILON, .25, .25 + Number.EPSILON, .625, .99]) {
      controls.seek(p * 1000);
      const authored = parsed[5][0]!;
      const programValue = evaluateMotionProgramSegmentsV1(authored[7], resolveMotionProgramSegmentsV1(authored[7]), parsed[3], evaluateMotionProgramScheduleV1(authored, p * 1000));
      expect(translateXSeries(f.writes).at(-1)).toBeCloseTo((programValue as readonly number[])[1]!, 10);
    }
    controls.cancel();
  });

  it('IEEE endpoints и overflow-span: никакого NaN, infinity или потери точных краёв', () => {
    for (const values of [[-0, 1, 0], [0, -1, -0], [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE], [0, 9 * Number.MIN_VALUE, Number.MIN_VALUE]]) {
      const f = fakeEl();
      const c = animate(f.el, { x: values }, { duration: 1000, requestFrame: () => 1 });
      c.seek(0);
      expect(Object.is(groupRecord(f.el, 'transform')._owner!._captureNum('x')!._value, values[0])).toBe(true);
      for (const t of [250, 500, 750]) {
        c.seek(t);
        const snapshot = groupRecord(f.el, 'transform')._owner!._captureNum('x')!;
        expect(Number.isFinite(snapshot._value) && Number.isFinite(snapshot._velocity)).toBe(true);
      }
      c.seek(1000);
      expect(Object.is(groupRecord(f.el, 'transform')._numeric.get('x')!._value, values[2])).toBe(true);
    }
  });
});
