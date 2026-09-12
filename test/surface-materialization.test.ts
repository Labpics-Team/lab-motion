import { describe, expect, it } from 'vitest';
import { tryCompileSurfaceArtifact, RECIPROCAL_MAX_STOPS } from '../src/future-layout/artifact.js';
import { compileSpringExecutionArtifactTupleUnchecked } from '../src/compositor/curve.js';

// Замороженный построитель main: независимо сохраняет прежнюю арифметику,
// обе границы сегментов и отказ по логическому размеру. Это не оракул ОДУ.
function oldReciprocal(
  samples: Float64Array,
  fromWidth: number,
  toWidth: number,
  budgetPx: number,
): Float64Array | undefined {
  const count = samples.length / 2;
  const delta = 1 / toWidth - 1 / fromWidth;
  // Fail-closed: без двух stops и без представимого ненулевого Δ доказательство
  // невозможно, а сериализация дала бы невалидный `linear()` или NaN-токены.
  if (count < 2 || !Number.isFinite(delta) || delta === 0) return undefined;
  const widthAt = (percent: number, i: number): number => {
    const x0 = samples[i * 2];
    const p0 = samples[i * 2 + 1];
    const x1 = samples[(i + 1) * 2];
    const p1 = samples[(i + 1) * 2 + 1];
    const q = (percent - x0) / (x1 - x0);
    return fromWidth + (toWidth - fromWidth) * ((1 - q) * p0 + q * p1);
  };
  const qAt = (w: number): number => (1 / w - 1 / fromWidth) / delta;

  // err-bound на сегменте [a,b] (percent): W линеен, β = ΔW/h.
  const segmentErrorPx = (percentA: number, percentB: number, i: number): number => {
    const h = percentB - percentA;
    const wA = widthAt(percentA, i);
    const wB = widthAt(percentB, i);
    const beta = Math.abs(wB - wA) / h;
    const wMin = Math.min(wA, wB);
    if (wMin <= 0) return Number.POSITIVE_INFINITY;
    const maxW = Math.max(wA, wB);
    const contentW = Math.max(fromWidth, toWidth);
    const qErr = (h * h / 8) * (2 * beta * beta) / (wMin * wMin * wMin) / Math.abs(delta);
    return maxW * contentW * Math.abs(delta) * qErr;
  };

  const out: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    let a = samples[i * 2];
    out.push(a, qAt(widthAt(a, i)));
    const stack: number[] = [samples[(i + 1) * 2]];
    while (stack.length > 0) {
      const b = stack.pop()!;
      if (segmentErrorPx(a, b, i) > budgetPx) {
        const mid = (a + b) / 2;
        // Дальше делить некуда, а бюджет не выполнен: доказательство
        // невозможно в double — fail-closed до крупных аллокаций.
        if (mid === a || mid === b) return undefined;
        stack.push(b, mid);
        continue;
      }
      if (out.length / 2 >= RECIPROCAL_MAX_STOPS) return undefined;
      out.push(b, qAt(widthAt(b, i)));
      a = b;
    }
  }
  return Float64Array.from(out);
}

/** Удаляет лишь бит-тождественные повторы, но не скачки на одной позиции. */
function uniqueKnots(values: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 2) {
    if (out.length && values[i] === out[out.length - 2]) {
      if (!Object.is(values[i + 1], out[out.length - 1])) throw new Error('разрыв');
    } else out.push(values[i]!, values[i + 1]!);
  }
  return out;
}

function parseExplicit(css: string): number[] {
  if (!css.startsWith('linear(') || !css.endsWith(')')) throw new Error('не linear');
  return css.slice(7, -1).split(',').flatMap((stop) => {
    const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)%\s*$/i.exec(stop);
    if (!m) throw new Error('не explicit stop');
    const pair = [Number(m[2]), Number(m[1])];
    if (!pair.every(Number.isFinite)) throw new Error('не finite');
    return pair;
  });
}

const springs = [
  { mass: 1, stiffness: 170, damping: 26 },
  { mass: 1, stiffness: 170, damping: 9 },
  { mass: 1, stiffness: 100, damping: 20 },
  { mass: 1, stiffness: 100, damping: 40 },
];

describe('единственная материализация сопряжённых кривых после допуска', () => {
  it('общая граница не создаёт вторую копию данных Q/A', () => {
    const a = tryCompileSurfaceArtifact(springs[0]!, 240, 360)!;
    expect(a.reciprocalSamples.length / 2).toBe(33);
    expect(a.blendSamples.length).toBe(33);
    expect(Array.from(a.reciprocalSamples)).toEqual(uniqueKnots(a.reciprocalSamples));
  });

  it('все подразделения и Q/A бит-точны относительно прежней траектории без дублей', () => {
    let accepted = 0;
    let rejected = 0;
    for (const spring of springs) for (const v0 of [-1, 0, 1]) {
      for (const [w0, w1] of [[240, 360], [360, 240], [400, 401], [80, 960], [960, 80], [40, 360]]) {
        const tuple = compileSpringExecutionArtifactTupleUnchecked(spring, v0, 1 / 400);
        const expected = oldReciprocal(tuple[1], w0!, w1!, 0.25);
        const actual = tryCompileSurfaceArtifact(spring, w0!, w1!, undefined, undefined, v0);
        let minW = Infinity;
        for (let i = 1; i < tuple[1].length; i += 2) minW = Math.min(minW, w0! + (w1! - w0!) * tuple[1][i]!);
        if (!(minW > 0) || expected === undefined) {
          expect(actual).toBeUndefined();
          rejected++;
          continue;
        }
        expect(actual).toBeDefined();
        expect(actual!.easing).toBe(tuple[0]);
        expect(actual!.samples).toBe(tuple[1]);
        expect(actual!.durationMs).toBe(tuple[2]);
        expect(actual!.minWidth).toBe(minW);
        const knots = uniqueKnots(expected);
        expect(Array.from(actual!.reciprocalSamples)).toEqual(knots);
        expect(parseExplicit(actual!.reciprocalEasing)).toEqual(knots.map((v) => v + 0));
        const blend = knots.map((value, i) => i % 2 === 0 ? value : (() => {
          const x = knots[i - 1]! / 100;
          return (3 - 2 * x) * x * x;
        })());
        expect(parseExplicit(actual!.blendEasing)).toEqual(blend);
        expect(actual!.blendSamples).toEqual(blend.filter((_, i) => i % 2 === 1));
        accepted++;
      }
    }
    expect(accepted + rejected).toBe(72);
    expect(accepted).toBeGreaterThan(50);
  });

  it('отложенная проекция сохраняет прежний logical-cap, включая соседей границы', () => {
    const spring = springs[0]!;
    const tuple = compileSpringExecutionArtifactTupleUnchecked(spring, 0, 1 / 400);
    let accepted = 0;
    let rejected = 0;
    for (const budget of [1, 0.1, 0.009, 0.00883, 0.001, 0.00001, 0.0000001]) {
      const old = oldReciprocal(tuple[1], 1, 4096, budget);
      const actual = tryCompileSurfaceArtifact(spring, 1, 4096, undefined, budget);
      if (old === undefined) {
        expect(actual).toBeUndefined();
        rejected++;
      } else {
        expect(actual).toBeDefined();
        expect(Array.from(actual!.reciprocalSamples)).toEqual(uniqueKnots(old));
        accepted++;
      }
    }
    expect(accepted).toBe(3);
    expect(rejected).toBe(4);
    expect(oldReciprocal(tuple[1], 1, 4096, 0.00883)).toBeUndefined();
    expect(tryCompileSurfaceArtifact(spring, 1, 4096, undefined, 0.00883)).toBeUndefined();
    expect(tryCompileSurfaceArtifact(spring, 1, 4096, undefined, 0.009)).toBeDefined();
  });

  it('проекция не публикует ширину вместо Q и сохраняет знак нуля', () => {
    for (const [w0, w1] of [[240, 360], [360, 240]]) {
      const a = tryCompileSurfaceArtifact(springs[0]!, w0!, w1!)!;
      expect(Object.is(a.reciprocalSamples[1], 0 / (1 / w1! - 1 / w0!))).toBe(true);
      expect(a.reciprocalSamples[a.reciprocalSamples.length - 1]).toBe(1);
      expect(a.reciprocalSamples.buffer.byteLength).toBe(a.reciprocalSamples.length * 8);
      const previous = Array.from(a.reciprocalSamples);
      tryCompileSurfaceArtifact(springs[1]!, 80, 960);
      expect(Array.from(a.reciprocalSamples)).toEqual(previous);
    }
  });

  it('контроли различают скачок, потерю узла и подмену Q шириной', () => {
    expect(uniqueKnots([0, 0, 30, 0.8, 30, 0.8, 100, 1])).toEqual([0, 0, 30, 0.8, 100, 1]);
    expect(() => uniqueKnots([0, 0, 30, 0.8, 30, 0.7, 100, 1])).toThrow('разрыв');
    expect(uniqueKnots([0, 0, 100, 1])).not.toEqual([0, 0, 30, 0.8, 100, 1]);
    expect(parseExplicit('linear(240 0%, 360 100%)')).not.toEqual([0, 0, 100, 1]);
  });
});
