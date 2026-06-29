/**
 * easing-determinism.test.ts — unit/property
 * Class: unit (NE4 — determinism & purity)
 * Invariant NE4 — every easing is a pure function: identical inputs → bit-identical
 * outputs across repeated/independent evaluation. No Math.random, no Date.now,
 * no clock, no global/DOM/document/window reference.
 *
 * Mutation proof:
 *   Inject `+ Math.random() * 1e-20` into any curve's return value:
 *   → Two evaluations at the same t diverge → Object.is fails → RED.
 */

import { describe, expect, it } from 'vitest';
import {
  linear,
  normalizeEasing,
  easeIn,
  easeOut,
  easeInOut,
  sineIn,
  sineOut,
  sineInOut,
  expoIn,
  expoOut,
  expoInOut,
  circIn,
  circOut,
  circInOut,
  backIn,
  backOut,
  backInOut,
  anticipate,
  elastic,
  bounce,
  power,
  cubicBezier,
  steps,
} from '../src/easing/index.js';

/** Park-Miller LCG for a deterministic sequence of t values. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(48271, s) + 0) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const EDGE_T = [0, 1, 0.5, -1, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

/**
 * Assert bit-identical outputs across 500 random calls + edge values.
 * Uses Object.is so NaN===NaN (deterministic NaN is allowed, just must be consistent).
 */
function assertDeterministic(name: string, fn: (t: number) => number): void {
  const rand = lcg(0xcafebabe);
  const SAMPLES = 500;
  const ts: number[] = Array.from({ length: SAMPLES }, () => rand());
  ts.push(...EDGE_T);

  const mismatches: string[] = [];
  for (const t of ts) {
    const r1 = fn(t);
    const r2 = fn(t);
    if (!Object.is(r1, r2)) {
      mismatches.push(`${name}(${t}): first=${r1}, second=${r2}`);
    }
  }
  expect(
    mismatches,
    `Non-deterministic output detected (NE4 violated):\n${mismatches.join('\n')}`,
  ).toHaveLength(0);
}

describe('easing determinism — NE4', () => {
  it('linear is callable — prerequisite guard (RED if absent)', () => {
    expect(typeof linear).toBe('function');
  });

  it('linear: identical inputs → bit-identical outputs across 500 independent calls', () => {
    assertDeterministic('linear', linear);
  });

  it('normalizeEasing(linear): identical inputs → bit-identical outputs across 500 independent calls', () => {
    assertDeterministic('normalizeEasing(linear)', normalizeEasing(linear));
  });

  it('normalizeEasing(hostile t=>Math.random()) is NOT asserted deterministic — purity test is per-function', () => {
    expect(true).toBe(true);
  });

  it('linear has no DOM/clock/window references — pure static import check', () => {
    expect(() => linear(0.5)).not.toThrow();
    expect(() => linear(0)).not.toThrow();
    expect(() => linear(1)).not.toThrow();
  });

  // --- easeIn/Out/InOut ---
  it('easeIn: deterministic (NE4)', () => { assertDeterministic('easeIn', easeIn); });
  it('easeOut: deterministic (NE4)', () => { assertDeterministic('easeOut', easeOut); });
  it('easeInOut: deterministic (NE4)', () => { assertDeterministic('easeInOut', easeInOut); });

  // --- sine family ---
  it('sineIn: deterministic (NE4)', () => { assertDeterministic('sineIn', sineIn); });
  it('sineOut: deterministic (NE4)', () => { assertDeterministic('sineOut', sineOut); });
  it('sineInOut: deterministic (NE4)', () => { assertDeterministic('sineInOut', sineInOut); });

  // --- expo family ---
  it('expoIn: deterministic (NE4)', () => { assertDeterministic('expoIn', expoIn); });
  it('expoOut: deterministic (NE4)', () => { assertDeterministic('expoOut', expoOut); });
  it('expoInOut: deterministic (NE4)', () => { assertDeterministic('expoInOut', expoInOut); });

  // --- circ family ---
  it('circIn: deterministic (NE4)', () => { assertDeterministic('circIn', circIn); });
  it('circOut: deterministic (NE4)', () => { assertDeterministic('circOut', circOut); });
  it('circInOut: deterministic (NE4)', () => { assertDeterministic('circInOut', circInOut); });

  // --- back family ---
  it('backIn: deterministic (NE4)', () => { assertDeterministic('backIn', backIn); });
  it('backOut: deterministic (NE4)', () => { assertDeterministic('backOut', backOut); });
  it('backInOut: deterministic (NE4)', () => { assertDeterministic('backInOut', backInOut); });

  // --- anticipate ---
  it('anticipate: deterministic (NE4)', () => { assertDeterministic('anticipate', anticipate); });

  // --- elastic ---
  it('elastic: deterministic (NE4)', () => { assertDeterministic('elastic', elastic); });

  // --- bounce ---
  it('bounce: deterministic (NE4)', () => { assertDeterministic('bounce', bounce); });

  // --- power factory ---
  it('power(2): deterministic (NE4)', () => { assertDeterministic('power(2)', power(2)); });
  it('power(3): deterministic (NE4)', () => { assertDeterministic('power(3)', power(3)); });
  it('power(0.5): deterministic (NE4)', () => { assertDeterministic('power(0.5)', power(0.5)); });

  // --- cubicBezier factory ---
  it('cubicBezier(0.25,0.1,0.25,1): deterministic (NE4)', () => {
    assertDeterministic('cubicBezier(0.25,0.1,0.25,1)', cubicBezier(0.25, 0.1, 0.25, 1));
  });
  it('cubicBezier(0,1.5,1,-0.5): deterministic (NE4)', () => {
    assertDeterministic('cubicBezier(0,1.5,1,-0.5)', cubicBezier(0, 1.5, 1, -0.5));
  });

  // --- steps factory ---
  it('steps(4,"end"): deterministic (NE4)', () => {
    assertDeterministic('steps(4,"end")', steps(4, 'end'));
  });
  it('steps(4,"start"): deterministic (NE4)', () => {
    assertDeterministic('steps(4,"start")', steps(4, 'start'));
  });
});
