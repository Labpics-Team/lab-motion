/**
 * test/decay-finiteness-fuzz.test.ts — CSS-safety fuzz for ./decay
 *
 * Условие успеха (4): "CSS-safe: fuzz 10k+ inputs NaN/∞-safe INCLUDING overflow
 * edges (velocity/from near ±MAX_VALUE) with finiteness guard/clampFinite —
 * never emits NaN/Infinity."
 *
 * Test classes:
 *   C (Property/Fuzz): 10k+ pseudo-random inputs incl. extreme overflow edges.
 *   D (Mutation proof): documented per assertion group.
 *
 * Mutation proof:
 *   - Remove `finiteOr(raw, rest)` guard in valueAt() → overflow inputs emit
 *     NaN/Infinity → 'valueAt is always finite' fails.
 *   - Remove `clampAmplitude` → `rest` can be NaN/Infinity for extreme
 *     velocity*timeConstant products → 'rest is always finite' fails.
 *   - Remove `clampT`'s NaN branch → valueAt(NaN) throws/NaNs → fails.
 */

import { describe, expect, it } from 'vitest';
import { createDecay } from '../src/decay.js';

// Deterministic PRNG (mulberry32) — no Math.random, reproducible fuzz run.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXTREME_VALUES = [
  0,
  1,
  -1,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MAX_VALUE / 2,
  -Number.MAX_VALUE / 2,
  Number.MIN_VALUE,
  1e300,
  -1e300,
  1e-300,
];

const EXTREME_T = [0, -1, -Infinity, Infinity, NaN, 1e300, Number.MAX_VALUE];

describe('decay: finiteness fuzz — random inputs (10k+)', () => {
  const rand = mulberry32(0xdecaf00d);
  const N = 10_000;

  it('valueAt/velocityAt/rest are always finite over 10k random (from, velocity, power, timeConstant, t)', () => {
    let ran = 0;
    for (let i = 0; i < N; i++) {
      // Sample across normal range plus occasional extreme magnitudes.
      const magnitude = rand() < 0.1 ? 1e300 : 1e6;
      const from = (rand() - 0.5) * 2 * magnitude;
      const velocity = (rand() - 0.5) * 2 * magnitude;
      const power = rand() < 0.05 ? -1 : rand() * 2;
      const timeConstant = rand() < 0.05 ? -1 : rand() * 2; // occasional invalid → default fallback
      const t = rand() < 0.05 ? -Infinity : rand() * 1000;

      const m = createDecay({ from, velocity, power, timeConstant });
      expect(Number.isFinite(m.rest), `rest not finite: ${JSON.stringify({ from, velocity, power, timeConstant })}`).toBe(true);

      const v = m.valueAt(t);
      expect(Number.isFinite(v), `valueAt not finite: t=${t} opts=${JSON.stringify({ from, velocity, power, timeConstant })}`).toBe(true);

      const vel = m.velocityAt(t);
      expect(Number.isFinite(vel), `velocityAt not finite: t=${t}`).toBe(true);

      ran++;
    }
    expect(ran).toBe(N);
  });
});

describe('decay: finiteness fuzz — overflow edges (cartesian of extreme magnitudes)', () => {
  it('rest/valueAt/velocityAt finite for every combination of extreme from/velocity', () => {
    let checked = 0;
    for (const from of EXTREME_VALUES) {
      for (const velocity of EXTREME_VALUES) {
        const m = createDecay({ from, velocity });
        expect(Number.isFinite(m.rest), `rest not finite: from=${from} velocity=${velocity}`).toBe(true);
        for (const t of EXTREME_T) {
          expect(Number.isFinite(m.valueAt(t)), `valueAt not finite: from=${from} velocity=${velocity} t=${t}`).toBe(true);
          expect(Number.isFinite(m.velocityAt(t)), `velocityAt not finite: from=${from} velocity=${velocity} t=${t}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBe(EXTREME_VALUES.length * EXTREME_VALUES.length);
  });

  it('extreme power/timeConstant combined with extreme velocity stay finite', () => {
    for (const power of [Number.MAX_VALUE, -Number.MAX_VALUE, 0]) {
      for (const timeConstant of [1e300, 1e-300, 0.35]) {
        const m = createDecay({ from: 0, velocity: Number.MAX_VALUE, power, timeConstant });
        expect(Number.isFinite(m.rest)).toBe(true);
        expect(Number.isFinite(m.valueAt(1))).toBe(true);
        expect(Number.isFinite(m.velocityAt(1))).toBe(true);
      }
    }
  });
});

describe('decay: NaN/Infinity in t (virtual time) never leaks', () => {
  it('valueAt(NaN) does not throw and returns a finite value (treated as t=0)', () => {
    const m = createDecay({ from: 5, velocity: 100 });
    expect(() => m.valueAt(NaN)).not.toThrow();
    expect(m.valueAt(NaN)).toBe(5);
  });

  it('valueAt(-Infinity) clamps to t=0 (not yet started)', () => {
    const m = createDecay({ from: 5, velocity: 100 });
    expect(m.valueAt(-Infinity)).toBe(5);
  });

  it('valueAt(Infinity) === rest (fully settled)', () => {
    const m = createDecay({ from: 5, velocity: 100 });
    expect(m.valueAt(Infinity)).toBe(m.rest);
  });

  it('velocityAt(Infinity) === 0', () => {
    const m = createDecay({ from: 5, velocity: 100 });
    expect(m.velocityAt(Infinity)).toBe(0);
  });
});

describe('decay: required-input validation (throws, does not silently NaN)', () => {
  it('from=NaN throws MotionParamError', () => {
    expect(() => createDecay({ from: NaN, velocity: 0 })).toThrow();
  });
  it('from=Infinity throws MotionParamError', () => {
    expect(() => createDecay({ from: Infinity, velocity: 0 })).toThrow();
  });
  it('velocity=NaN throws MotionParamError', () => {
    expect(() => createDecay({ from: 0, velocity: NaN })).toThrow();
  });
  it('velocity=-Infinity throws MotionParamError', () => {
    expect(() => createDecay({ from: 0, velocity: -Infinity })).toThrow();
  });
});
