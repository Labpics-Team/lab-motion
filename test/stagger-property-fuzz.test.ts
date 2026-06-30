/**
 * test/stagger-property-fuzz.test.ts — property/fuzz tests for stagger()
 *
 * 10 000+ randomised inputs verify structural invariants:
 *   ST1. Finiteness: every delay is finite and >= 0.
 *   ST3. Reduced-motion CHARACTER-switch: all delays = 0.
 *   PF1. Length invariant: result.length === floor(max(count, 0)).
 *   PF2. Origin delay = 0: the element at/closest to `from` always has delay 0.
 *   PF3. Symmetry (center / edges): delay[i] === delay[mirror(i)] within tolerance.
 *   PF4. Monotonicity (first / last): delays are sorted asc/desc respectively.
 *   PF5. Grid finiteness: grid mode never produces non-finite delays.
 *
 * TDD RED-proof:
 *   1. Remove the `clampDelay(...)` guard in stagger/index.ts (let non-finite through).
 *   2. Run: pnpm test test/stagger-property-fuzz.test.ts
 *   3. The PF-Finiteness suite MUST fail on fuzz iterations with hostile gap/easing.
 *   4. Restore → GREEN.
 *
 * Test classes:
 *   C (Property): structural invariants over random inputs
 *   V (Fuzz): hostile random inputs including extreme and non-finite values
 *
 * Seed: deterministic (no Math.random seeded) — uses a simple LCG for reproducibility.
 */

import { describe, expect, it } from 'vitest';
import { stagger } from '../src/stagger/index.js';

// ---------------------------------------------------------------------------
// Deterministic LCG pseudo-random number generator
// Avoids Math.random() for reproducibility.
// ---------------------------------------------------------------------------

function makePrng(seed: number): () => number {
  // LCG: Numerical Recipes constants
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// Helper: all delays in array are finite and >= 0
function allFiniteNonNeg(arr: number[]): boolean {
  return arr.every((d) => Number.isFinite(d) && d >= 0);
}

// ---------------------------------------------------------------------------
// PF-Finiteness: 10 000 random inputs, all delays must be finite >= 0
// ---------------------------------------------------------------------------

describe('stagger — property/fuzz: finiteness (10 000 iterations)', () => {
  it('C/V: random count, gap, from → all delays finite (ST1)', () => {
    const rng = makePrng(0xdeadbeef);
    const froms = ['first', 'last', 'center', 'edges', 0, 1, 2, 5, -1, NaN, Infinity] as const;
    let iterations = 0;

    for (let iter = 0; iter < 10_000; iter++) {
      const count = Math.floor(rng() * 200); // 0..199
      const gapChoice = rng();
      let gap: number;
      if (gapChoice < 0.1) gap = NaN;
      else if (gapChoice < 0.15) gap = Infinity;
      else if (gapChoice < 0.2) gap = -Infinity;
      else if (gapChoice < 0.25) gap = -100;
      else gap = rng() * 500;

      const fromIdx = Math.floor(rng() * froms.length);
      const from = froms[fromIdx] as any;

      const result = stagger(count, { gap, from });

      if (!allFiniteNonNeg(result)) {
        throw new Error(
          `iter=${iter} count=${count} gap=${gap} from=${String(from)} → non-finite delay detected: ${JSON.stringify(result.filter((d) => !Number.isFinite(d) || d < 0))}`,
        );
      }
      iterations++;
    }
    expect(iterations).toBe(10_000);
  });

  it('C/V: hostile easing functions → all delays finite (ST1)', () => {
    const rng = makePrng(0xc0ffee42);
    const hostileEasings: Array<(t: number) => number> = [
      () => NaN,
      () => Infinity,
      () => -Infinity,
      (t) => t * Infinity,
      (t) => 0 / 0,
      (t) => Math.sqrt(-1), // NaN
      (t) => t * t,
      (t) => 1 - t,
      (t) => t * 3 - 1, // can be negative or > 1
    ];

    for (let iter = 0; iter < 2_000; iter++) {
      const count = Math.floor(rng() * 50) + 1;
      const gap = rng() * 200;
      const easingIdx = Math.floor(rng() * hostileEasings.length);
      const easing = hostileEasings[easingIdx];

      const result = stagger(count, { gap, easing });

      if (!allFiniteNonNeg(result)) {
        throw new Error(
          `iter=${iter} count=${count} gap=${gap} easingIdx=${easingIdx} → non-finite: ${JSON.stringify(result)}`,
        );
      }
    }
    expect(true).toBe(true); // structural: 2000 iterations passed
  });

  it('C/V: grid mode with random columns → all delays finite (PF5)', () => {
    const rng = makePrng(0xfadecafe);
    const columnChoices = [0, 1, 2, 3, NaN, Infinity, -1];

    for (let iter = 0; iter < 2_000; iter++) {
      const count = Math.floor(rng() * 50) + 1;
      const colChoice = rng();
      let columns: number;
      if (colChoice < 0.2) {
        columns = columnChoices[Math.floor(rng() * columnChoices.length)];
      } else {
        columns = Math.floor(rng() * 10) + 1; // 1..10
      }

      const from = ['first', 'last', 'center', 'edges'][Math.floor(rng() * 4)] as any;

      const result = stagger(count, { grid: { columns }, from });

      if (!allFiniteNonNeg(result)) {
        throw new Error(
          `iter=${iter} count=${count} cols=${columns} from=${String(from)} → non-finite: ${JSON.stringify(result)}`,
        );
      }
    }
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PF-Length: result.length === floor(count) for valid inputs
// ---------------------------------------------------------------------------

describe('stagger — property: length invariant (PF1)', () => {
  it('C: result.length === floor(count) for positive counts', () => {
    const rng = makePrng(0x1234abcd);
    for (let iter = 0; iter < 1_000; iter++) {
      const rawCount = rng() * 300;
      const count = rawCount;
      const expected = rawCount > 0 && Number.isFinite(rawCount)
        ? Math.floor(rawCount)
        : 0;
      const result = stagger(count);
      if (result.length !== expected) {
        throw new Error(
          `iter=${iter} count=${count} expected.length=${expected} got=${result.length}`,
        );
      }
    }
    expect(true).toBe(true);
  });

  it('C: hostile counts → empty array', () => {
    for (const count of [0, -1, -100, NaN, Infinity, -Infinity]) {
      const result = stagger(count);
      expect(result).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// PF-Origin: element at 'from' origin always has delay 0
// ---------------------------------------------------------------------------

describe('stagger — property: origin has delay 0 (PF2)', () => {
  it('C: from=first → delays[0] === 0', () => {
    const rng = makePrng(0xabcdef01);
    for (let iter = 0; iter < 500; iter++) {
      const count = Math.floor(rng() * 20) + 2;
      const gap = rng() * 200 + 1;
      const result = stagger(count, { from: 'first', gap });
      if (result[0] !== 0) {
        throw new Error(`iter=${iter} count=${count} gap=${gap}: delays[0]=${result[0]} !== 0`);
      }
    }
    expect(true).toBe(true);
  });

  it('C: from=last → delays[count-1] === 0', () => {
    const rng = makePrng(0xabcdef02);
    for (let iter = 0; iter < 500; iter++) {
      const count = Math.floor(rng() * 20) + 2;
      const gap = rng() * 200 + 1;
      const result = stagger(count, { from: 'last', gap });
      if (result[count - 1] !== 0) {
        throw new Error(`iter=${iter}: delays[${count-1}]=${result[count-1]} !== 0`);
      }
    }
    expect(true).toBe(true);
  });

  it('C: from=center (odd n) → delays[mid] === 0', () => {
    // For odd n, center is an exact integer index
    for (const n of [3, 5, 7, 9, 11, 21, 51]) {
      const result = stagger(n, { from: 'center', gap: 50 });
      const mid = (n - 1) / 2;
      expect(result[mid]).toBe(0);
    }
  });

  it('C: from=center (even n) → both center indices have same delay', () => {
    // For even n, center falls between two indices — both should have equal (minimal) delay
    for (const n of [4, 6, 8, 10, 20]) {
      const result = stagger(n, { from: 'center', gap: 50 });
      const lo = n / 2 - 1;
      const hi = n / 2;
      // Both center elements should have the same delay (by symmetry)
      expect(result[lo]).toBeCloseTo(result[hi], 10);
      // And should be the minimum delay (0 or close to it)
      const minDelay = Math.min(...result);
      expect(result[lo]).toBeCloseTo(minDelay, 10);
    }
  });

  it('C: from=edges → delays[0] === 0 and delays[n-1] === 0', () => {
    const rng = makePrng(0xabcdef03);
    for (let iter = 0; iter < 500; iter++) {
      const count = Math.floor(rng() * 20) + 2;
      const result = stagger(count, { from: 'edges', gap: 50 });
      if (result[0] !== 0 || result[count - 1] !== 0) {
        throw new Error(`iter=${iter}: edges not 0: [${result[0]}, ${result[count-1]}]`);
      }
    }
    expect(true).toBe(true);
  });

  it('C: from=number (valid index) → delays[from] === 0', () => {
    const rng = makePrng(0xabcdef04);
    for (let iter = 0; iter < 500; iter++) {
      const count = Math.floor(rng() * 20) + 2;
      const origin = Math.floor(rng() * count);
      const result = stagger(count, { from: origin, gap: 100 });
      if (result[origin] !== 0) {
        throw new Error(`iter=${iter}: from=${origin} count=${count}: delays[${origin}]=${result[origin]} !== 0`);
      }
    }
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PF-Symmetry: center and edges modes produce symmetric delay arrays
// ---------------------------------------------------------------------------

describe('stagger — property: symmetry invariants (PF3)', () => {
  it('C: from=center → delays[i] ≈ delays[n-1-i] (symmetric around center)', () => {
    const rng = makePrng(0x55a5b5c5);
    for (let iter = 0; iter < 500; iter++) {
      const count = Math.floor(rng() * 30) + 2;
      const gap = rng() * 200 + 1;
      const result = stagger(count, { from: 'center', gap });
      for (let i = 0; i < count; i++) {
        const mirror = count - 1 - i;
        if (Math.abs(result[i] - result[mirror]) > 1e-9) {
          throw new Error(
            `iter=${iter} count=${count} i=${i}: result[${i}]=${result[i]} !== result[${mirror}]=${result[mirror]}`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });

  it('C: from=edges → delays[i] ≈ delays[n-1-i] (symmetric, edges=min)', () => {
    const rng = makePrng(0xe4e5e6e7);
    for (let iter = 0; iter < 500; iter++) {
      const count = Math.floor(rng() * 30) + 2;
      const gap = rng() * 200 + 1;
      const result = stagger(count, { from: 'edges', gap });
      for (let i = 0; i < count; i++) {
        const mirror = count - 1 - i;
        if (Math.abs(result[i] - result[mirror]) > 1e-9) {
          throw new Error(
            `iter=${iter} count=${count} i=${i}: result[${i}] !== result[${mirror}]`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PF-Monotonicity: from=first ascending, from=last descending
// ---------------------------------------------------------------------------

describe('stagger — property: monotonicity invariants (PF4)', () => {
  it('C: from=first, linear easing → delays non-decreasing', () => {
    const rng = makePrng(0xa0b1c2d3);
    for (let iter = 0; iter < 1_000; iter++) {
      const count = Math.floor(rng() * 50) + 2;
      const gap = rng() * 200 + 1;
      const result = stagger(count, { from: 'first', gap });
      for (let i = 1; i < result.length; i++) {
        if (result[i] < result[i - 1] - 1e-10) {
          throw new Error(
            `iter=${iter} count=${count}: not non-decreasing at i=${i}: ${result[i-1]} > ${result[i]}`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });

  it('C: from=last, linear easing → delays non-increasing', () => {
    const rng = makePrng(0xd3c2b1a0);
    for (let iter = 0; iter < 1_000; iter++) {
      const count = Math.floor(rng() * 50) + 2;
      const gap = rng() * 200 + 1;
      const result = stagger(count, { from: 'last', gap });
      for (let i = 1; i < result.length; i++) {
        if (result[i] > result[i - 1] + 1e-10) {
          throw new Error(
            `iter=${iter} count=${count}: not non-increasing at i=${i}: ${result[i-1]} < ${result[i]}`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });

  it('C: from=first reversed === from=last (mirrored)', () => {
    // Structural: first-stagger reversed is the same as last-stagger
    for (const count of [2, 3, 5, 10, 20]) {
      const first = stagger(count, { from: 'first', gap: 100 });
      const last = stagger(count, { from: 'last', gap: 100 });
      const reversed = [...first].reverse();
      for (let i = 0; i < count; i++) {
        expect(reversed[i]).toBeCloseTo(last[i], 10);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion property: all zeros over 2 000 random inputs
// ---------------------------------------------------------------------------

describe('stagger — property/fuzz: reduced-motion (ST3, 2 000 iterations)', () => {
  it('C/V: reducedMotion=true → all delays 0 for any input', () => {
    const rng = makePrng(0xdeadbeef ^ 0x12345678);
    const froms = ['first', 'last', 'center', 'edges', 0, 1, 2, NaN, Infinity] as const;

    for (let iter = 0; iter < 2_000; iter++) {
      const count = Math.floor(rng() * 100);
      const gap = rng() < 0.2 ? NaN : rng() * 1000;
      const from = froms[Math.floor(rng() * froms.length)] as any;

      const result = stagger(count, { reducedMotion: true, gap, from });
      const n = count > 0 && Number.isFinite(count) ? Math.floor(count) : 0;

      if (result.length !== n) {
        throw new Error(`iter=${iter}: expected length=${n} got=${result.length}`);
      }
      for (const d of result) {
        if (d !== 0) {
          throw new Error(
            `iter=${iter} count=${count} gap=${gap}: delay=${d} !== 0 in reducedMotion`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Explicit canonical delay values (deterministic regression)
// ---------------------------------------------------------------------------

describe('stagger — canonical values (regression, deterministic)', () => {
  it('B: from=first, count=5, gap=50 → [0, 50, 100, 150, 200]', () => {
    const result = stagger(5, { from: 'first', gap: 50 });
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(0);
    expect(result[1]).toBeCloseTo(50, 10);
    expect(result[2]).toBeCloseTo(100, 10);
    expect(result[3]).toBeCloseTo(150, 10);
    expect(result[4]).toBeCloseTo(200, 10);
  });

  it('B: from=last, count=5, gap=50 → [200, 150, 100, 50, 0]', () => {
    const result = stagger(5, { from: 'last', gap: 50 });
    expect(result[0]).toBeCloseTo(200, 10);
    expect(result[4]).toBe(0);
  });

  it('B: from=center, count=5, gap=50 → [100, 50, 0, 50, 100]', () => {
    const result = stagger(5, { from: 'center', gap: 50 });
    // center of 5 = index 2 (exact integer)
    expect(result[2]).toBe(0);
    expect(result[1]).toBeCloseTo(50, 10);
    expect(result[0]).toBeCloseTo(100, 10);
    expect(result[3]).toBeCloseTo(50, 10);
    expect(result[4]).toBeCloseTo(100, 10);
  });

  it('B: from=edges, count=5, gap=50 → [0, 50, 100, 50, 0]', () => {
    // edges start at 0 delay, center gets max delay
    const result = stagger(5, { from: 'edges', gap: 50 });
    expect(result[0]).toBe(0);
    expect(result[4]).toBe(0);
    expect(result[1]).toBeCloseTo(50, 10);
    expect(result[3]).toBeCloseTo(50, 10);
    expect(result[2]).toBeCloseTo(100, 10); // center = max
  });

  it('B: from=2, count=5, gap=50 → [100, 50, 0, 50, 100]', () => {
    const result = stagger(5, { from: 2, gap: 50 });
    expect(result[2]).toBe(0);
    expect(result[1]).toBeCloseTo(50, 10);
    expect(result[0]).toBeCloseTo(100, 10);
    expect(result[3]).toBeCloseTo(50, 10);
    expect(result[4]).toBeCloseTo(100, 10);
  });

  it('B: easing applied — easeIn(t)=t³ slows early items, speeds up late', () => {
    const easeIn = (t: number) => t * t * t;
    const result = stagger(5, { from: 'first', gap: 50, easing: easeIn });
    // With t³ easing, early positions get much smaller delays than linear
    // position 0 → delay=0; position 0.25 → 0.25³=0.015625; position 1 → 1
    const resultLinear = stagger(5, { from: 'first', gap: 50 });
    // Non-linear: intermediate delays differ from linear
    expect(result[0]).toBe(0);
    expect(result[4]).toBeCloseTo(resultLinear[4], 10); // both end at max*gap
    // Middle element: eased < linear (because t³ < t for 0 < t < 1)
    expect(result[2]).toBeLessThan(resultLinear[2]);
  });

  it('B: gap=0 → all delays are 0 regardless of from/easing', () => {
    const result = stagger(10, { gap: 0, from: 'center' });
    for (const d of result) {
      expect(d).toBe(0);
    }
  });

  it('B: grid 2×3, from=first → element 0 has delay 0, others positive', () => {
    const result = stagger(6, { grid: { columns: 3 }, from: 'first', gap: 50 });
    expect(result[0]).toBe(0);
    // At least some elements have non-zero delay
    expect(result.some((d) => d > 0)).toBe(true);
  });
});
