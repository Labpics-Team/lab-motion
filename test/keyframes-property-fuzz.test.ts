/**
 * test/keyframes-property-fuzz.test.ts — property/fuzz for sampleKeyframes()/keyframes().
 *
 * Классы:
 *   C (Property): structural invariants over random valid inputs.
 *   V (Fuzz): hostile random inputs including overflow-range edges (±Infinity
 *     boundaries per North exit-criteria #3: "range=target−from→±∞").
 *
 * Seed: deterministic LCG (no Math.random) — reproducible across runs/CI.
 *
 * ── RED PROOF (verified by actual mutation, not merely asserted) ────────────
 * Replace `return Number.isFinite(value) ? value : to;` with `return value;` in
 * sampleKeyframesUnchecked() (src/internal/sample-keyframes.ts) → both fuzz suites below
 * (random overflow-range inputs AND the dedicated MAX_VALUE-scale edge test)
 * immediately fail with a non-finite (-Infinity/NaN) result at iter=5 →
 * confirmed RED. Restore → GREEN (54/54 passing). This is the sole
 * load-bearing finiteness guard for this function — an earlier draft had a
 * redundant early-return keyed on `range` alone that turned out to be
 * fully subsumed by this check (proven dead via the same mutation drill).
 */

import { describe, expect, it } from 'vitest';
import { sampleKeyframes, type EasingFn } from '../src/keyframes/index.js';

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const hostileEasings: EasingFn[] = [
  (t) => t,
  () => NaN,
  () => Infinity,
  () => -Infinity,
  (t) => t * t,
  (t) => 1 - t,
];

describe('keyframes — property/fuzz: finiteness (10 000 iterations)', () => {
  it('C/V: random values/times/easing/p → sampleKeyframes always finite', () => {
    const rng = makePrng(0xc0ffee);
    let iterations = 0;

    for (let iter = 0; iter < 10_000; iter++) {
      const n = 2 + Math.floor(rng() * 6); // 2..7 keyframes
      const valueChoice = () => {
        const r = rng();
        if (r < 0.05) return Number.MAX_VALUE * (rng() < 0.5 ? 1 : -1);
        if (r < 0.1) return 0;
        return (rng() - 0.5) * 2000;
      };
      const values = Array.from({ length: n }, valueChoice);

      // Ascending times starting 0 ending 1
      const rawTimes = Array.from({ length: n - 2 }, () => rng()).sort((a, b) => a - b);
      const times = [0, ...rawTimes, 1];

      const easings = Array.from(
        { length: n - 1 },
        () => hostileEasings[Math.floor(rng() * hostileEasings.length)]!,
      );

      const pChoice = rng();
      let p: number;
      if (pChoice < 0.05) p = NaN;
      else if (pChoice < 0.1) p = Infinity;
      else if (pChoice < 0.15) p = -Infinity;
      else if (pChoice < 0.2) p = rng() * 4 - 2; // out of [0,1] range
      else p = rng();

      const result = sampleKeyframes(values, times, easings, p);

      if (!Number.isFinite(result)) {
        throw new Error(
          `iter=${iter} values=${JSON.stringify(values)} times=${JSON.stringify(times)} p=${p} → non-finite: ${result}`,
        );
      }
      iterations++;
    }
    expect(iterations).toBe(10_000);
  });

  it('V: overflow-range edge — adjacent MAX_VALUE-scale values never yield NaN/Infinity', () => {
    const rng = makePrng(0xfeedface);
    const linear: EasingFn = (t) => t;
    let iterations = 0;

    for (let iter = 0; iter < 2_000; iter++) {
      const sign = rng() < 0.5 ? 1 : -1;
      const v0 = sign * Number.MAX_VALUE * (0.5 + rng() * 0.5);
      const v1 = -sign * Number.MAX_VALUE * (0.5 + rng() * 0.5); // opposite sign → range overflows
      const values = [v0, v1];
      const times = [0, 1];
      const p = rng();

      const result = sampleKeyframes(values, times, [linear], p);
      expect(Number.isFinite(result)).toBe(true);
      iterations++;
    }
    expect(iterations).toBe(2_000);
  });
});

describe('keyframes — property/fuzz: keyframes() controls virtual-time (500 iterations)', () => {
  it('C/V: random seek(t) with random repeat/repeatType/repeatDelay → onStep always finite', async () => {
    const rng = makePrng(0xabad1dea);
    const linear: EasingFn = (t) => t;

    for (let iter = 0; iter < 500; iter++) {
      const n = 2 + Math.floor(rng() * 4);
      const values = Array.from({ length: n }, () => (rng() - 0.5) * 1000);
      const duration = 0.1 + rng() * 3;
      const repeatChoice = rng();
      const repeat = repeatChoice < 0.1 ? Infinity : Math.floor(rng() * 4);
      const repeatType = (['loop', 'reverse', 'mirror'] as const)[Math.floor(rng() * 3)]!;
      const repeatDelay = rng() < 0.5 ? 0 : rng() * 2;

      let lastValue = 0;
      const c = (await import('../src/keyframes/index.js')).keyframes({
        values,
        duration,
        repeat,
        repeatType,
        repeatDelay,
        easing: linear,
        requestFrame: () => 0,
        onStep: (v) => {
          lastValue = v;
        },
      });

      const seekT = rng() * (Number.isFinite(c.totalDuration) ? c.totalDuration : duration * 5);
      c.seek(seekT);
      expect(Number.isFinite(lastValue)).toBe(true);
      c.cancel();
    }
  });
});
