/**
 * utils-determinism.test.ts — NE4 determinism / purity
 *
 * Identical inputs → bit-identical outputs (Object.is). No Date.now,
 * no Math.random, no DOM, no global state. Two independently-built mappers
 * with the same config produce identical outputs across a sweep.
 */

import { describe, expect, it } from 'vitest';
import { clamp, mix, wrap, snap, mapRange, interpolate, pipe } from '../src/utils/index.js';

const EDGES = [0, 1, -0, 0.5, -1, 2, -0.001, 1.001, 123.456, -987.654, 1e9, -1e9, 5e-324];

describe('utils determinism — bit-identical repeats', () => {
  it('mix is deterministic across the edge set', () => {
    for (const p of EDGES) {
      expect(Object.is(mix(3, 17, p), mix(3, 17, p))).toBe(true);
    }
  });
  it('clamp / wrap / snap / mapRange scalars are deterministic', () => {
    for (const v of EDGES) {
      expect(Object.is(clamp(-2, 5, v), clamp(-2, 5, v))).toBe(true);
      expect(Object.is(wrap(0, 100, v), wrap(0, 100, v))).toBe(true);
      expect(Object.is(snap(0.5, v), snap(0.5, v))).toBe(true);
      expect(Object.is(snap([0, 3, 9], v), snap([0, 3, 9], v))).toBe(true);
      expect(Object.is(mapRange(0, 10, -1, 1, v), mapRange(0, 10, -1, 1, v))).toBe(true);
    }
  });
  it('a curried closure returns bit-identical values on repeated calls', () => {
    const c = clamp(0, 1);
    const w = wrap(0, 360);
    for (const v of EDGES) {
      expect(Object.is(c(v), c(v))).toBe(true);
      expect(Object.is(w(v), w(v))).toBe(true);
    }
  });
  it('two independent interpolate mappers with identical config agree everywhere', () => {
    const cfg = { clamp: false as const, ease: (t: number) => t * t };
    const a = interpolate([-1, 0, 1, 2], [0, 10, -5, 3], cfg);
    const b = interpolate([-1, 0, 1, 2], [0, 10, -5, 3], cfg);
    for (let v = -3; v <= 4; v += 0.11) {
      expect(Object.is(a(v), b(v))).toBe(true);
    }
  });
  it('pipe pipeline is deterministic and side-effect-free', () => {
    const f = pipe(clamp(0, 10), snap(2), (x: number) => x + 1);
    for (const v of EDGES) {
      expect(Object.is(f(v), f(v))).toBe(true);
    }
  });
});
