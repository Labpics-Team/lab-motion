/**
 * utils-finiteness-fuzz.test.ts — property/fuzz
 * Class: property — CSS-safe finiteness invariant.
 *
 * Every NUMERIC mapper output is finite (never NaN, never ±Infinity) for ALL
 * IEEE-754 value inputs, including <range, >range, NaN, ±Infinity, -0, subnormals.
 *
 * Strategy mirrors easing-finiteness-fuzz.test.ts: seeded Park-Miller LCG,
 * >=10k random samples across the full number line + enumerated IEEE-754 edges.
 *
 * The custom-mixer (T) path is NOT asserted here — finiteness of non-numeric
 * outputs is the mixer's own contract (e.g. ./value's mixColor returns CSS-safe
 * strings). Only the default numeric path is fuzzed.
 */

import { describe, expect, it } from 'vitest';
import { clamp, mix, wrap, snap, mapRange, interpolate } from '../src/utils/index.js';

/** Park-Miller LCG — seeded, reproducible, zero dependencies. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(48271, s) + 0) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const range = (u: number, min: number, max: number): number => min + u * (max - min);

const IEEE754_EDGES: number[] = [
  0, 1, -0, 0.5, -1, 2, -0.001, 1.001,
  Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE,
  Number.EPSILON, -Number.EPSILON, 5e-324, -5e-324,
  1 - Number.EPSILON, Number.EPSILON / 2,
];

const RANDOM_SAMPLES = 10_000;

/** A hostile sample sequence: IEEE edges, then 10k LCG samples across 4 buckets. */
function* hostileValues(seed: number): Generator<number> {
  for (const t of IEEE754_EDGES) yield t;
  const rand = lcg(seed);
  for (let i = 0; i < RANDOM_SAMPLES; i++) {
    const bucket = i % 4;
    if (bucket === 0) yield range(rand(), 0, 1);
    else if (bucket === 1) yield range(rand(), -10, 10);
    else if (bucket === 2) yield range(rand(), -1e10, 1e10);
    else yield (range(rand(), 0, 1) < 0.5 ? -rand() * 1e308 : rand() * 1e308);
  }
}

/** Assert a single-argument numeric mapper is finite over the hostile domain. */
function assertMapperFinite(name: string, fn: (v: number) => number, seed = 0xdeadbeef): void {
  const failures: string[] = [];
  for (const v of hostileValues(seed)) {
    const r = fn(v);
    if (!Number.isFinite(r)) failures.push(`${name}(${v}) = ${r}`);
  }
  expect(failures, `finiteness violation:\n${failures.slice(0, 20).join('\n')}`).toHaveLength(0);
}

describe('utils finiteness fuzz — CSS-safe invariant', () => {
  // prerequisite guards (anti-theater)
  it('clamp is callable — prerequisite guard', () => expect(typeof clamp).toBe('function'));
  it('interpolate is callable — prerequisite guard', () => expect(typeof interpolate).toBe('function'));

  it('clamp(0,1)(·) finite over all IEEE-754 inputs', () => {
    assertMapperFinite('clamp(0,1)', clamp(0, 1));
  });
  it('clamp(0,Infinity)(·) one-sided finite over all inputs', () => {
    assertMapperFinite('clamp(0,Inf)', clamp(0, Number.POSITIVE_INFINITY));
  });
  it('clamp(-Infinity,Infinity)(·) finite over all inputs', () => {
    assertMapperFinite('clamp(-Inf,Inf)', clamp(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY));
  });

  it('wrap(0,360)(·) finite over all IEEE-754 inputs', () => {
    assertMapperFinite('wrap(0,360)', wrap(0, 360));
  });
  it('wrap(-50,50)(·) finite over all inputs', () => {
    assertMapperFinite('wrap(-50,50)', wrap(-50, 50));
  });
  it('wrap(5,5)(·) degenerate range finite over all inputs', () => {
    assertMapperFinite('wrap(5,5)', wrap(5, 5));
  });

  it('snap(0.25)(·) finite over all inputs', () => {
    assertMapperFinite('snap(0.25)', snap(0.25));
  });
  it('snap(-7)(·) negative increment finite over all inputs', () => {
    assertMapperFinite('snap(-7)', snap(-7));
  });
  it('snap([0,90,180,270])(·) targets finite over all inputs', () => {
    assertMapperFinite('snap([...])', snap([0, 90, 180, 270]));
  });

  it('mapRange(-10,10,0,100)(·) finite over all inputs', () => {
    assertMapperFinite('mapRange', mapRange(-10, 10, 0, 100));
  });
  it('mapRange(5,5,0,1)(·) degenerate input range finite over all inputs', () => {
    assertMapperFinite('mapRange(5,5,..)', mapRange(5, 5, 0, 1));
  });

  it('interpolate multi-stop {clamp:false, ease:t*t}(·) finite over all inputs', () => {
    const f = interpolate([-1, 0, 1, 2], [0, 10, -5, 3], { clamp: false, ease: (t) => t * t });
    assertMapperFinite('interpolate', f);
  });
  it('interpolate default clamp {ease:t=>1/t hostile}(·) finite over all inputs', () => {
    // A hostile ease returning ±Infinity/NaN must still yield finite numeric output.
    const f = interpolate([0, 1, 2], [0, 100, -100], { ease: (t) => 1 / t });
    assertMapperFinite('interpolate(hostile ease)', f);
  });

  it('mix(fuzz, fuzz, fuzz) finite over 10k triples + edges', () => {
    const rand = lcg(0x51ee7);
    const failures: string[] = [];
    const edges = IEEE754_EDGES;
    // full edge × edge × edge cross-product
    for (const a of edges) for (const b of edges) for (const p of edges) {
      const r = mix(a, b, p);
      if (!Number.isFinite(r)) failures.push(`mix(${a},${b},${p}) = ${r}`);
    }
    // random triples across wide ranges
    for (let i = 0; i < RANDOM_SAMPLES; i++) {
      const a = range(rand(), -1e6, 1e6);
      const b = range(rand(), -1e6, 1e6);
      const p = i % 2 === 0 ? range(rand(), -3, 3) : (rand() < 0.5 ? -rand() * 1e308 : rand() * 1e308);
      const r = mix(a, b, p);
      if (!Number.isFinite(r)) failures.push(`mix(${a},${b},${p}) = ${r}`);
    }
    expect(failures, `mix finiteness violation:\n${failures.slice(0, 20).join('\n')}`).toHaveLength(0);
  });
});
