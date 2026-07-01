/**
 * test/decay-differential.test.ts — differential oracle vs closed-form exponential decay
 *
 * Условие успеха (6): "TDD RED-proof (red fails first), mutation-checked,
 * differential oracle vs closed-form exponential-decay rest point."
 *
 * Oracle: an INDEPENDENT small-step Euler numerical integration of the same
 * physical ODE (dv/dt = -v/timeConstant, dx/dt = v), implemented here from
 * scratch (not imported from src/decay.ts), compared against createDecay()'s
 * analytical closed-form. Agreement across many (velocity, timeConstant, t)
 * combinations is strong evidence the closed-form is not just internally
 * self-consistent but physically correct.
 *
 * Test classes:
 *   C (Differential): independent numerical oracle vs implementation.
 *   A (Unit): known closed-form rest point for hand-computed cases.
 *
 * Mutation proof:
 *   - Flip sign in `amplitude = power * velocity * timeConstant` (e.g. drop `power`
 *     or `timeConstant` factor) → rest point diverges from the Euler oracle
 *     beyond tolerance → 'rest matches independent numerical oracle' fails.
 *   - Break velocity(t) = d/dt value(t) consistency (e.g. hardcode velocityAt
 *     to a constant) → 'velocityAt matches numerical derivative of valueAt' fails.
 */

import { describe, expect, it } from 'vitest';
import { createDecay } from '../src/decay.js';

/**
 * Independent Euler-integration oracle for dv/dt = -v/tau, dx/dt = v.
 * Deliberately NOT the closed-form formula — a from-scratch numerical
 * re-derivation used purely to cross-check src/decay.ts.
 */
function eulerDecay(
  from: number,
  v0: number,
  timeConstant: number,
  tEnd: number,
  steps = 200_000,
): { x: number; v: number } {
  const dt = tEnd / steps;
  let x = from;
  let v = v0;
  for (let i = 0; i < steps; i++) {
    const dv = (-v / timeConstant) * dt;
    x += v * dt;
    v += dv;
  }
  return { x, v };
}

describe('decay: differential oracle — closed-form vs independent Euler integration', () => {
  const cases: Array<{ from: number; velocity: number; power: number; timeConstant: number }> = [
    { from: 0, velocity: 1000, power: 0.8, timeConstant: 0.35 },
    { from: 50, velocity: -600, power: 0.8, timeConstant: 0.35 },
    { from: -200, velocity: 300, power: 1.0, timeConstant: 0.5 },
    { from: 10, velocity: 2000, power: 0.5, timeConstant: 0.2 },
  ];

  for (const c of cases) {
    it(`matches Euler oracle at multiple t for ${JSON.stringify(c)}`, () => {
      const m = createDecay(c);
      const v0 = c.power * c.velocity;

      for (const t of [0.05, 0.2, 0.5, 1, 2]) {
        const oracle = eulerDecay(c.from, v0, c.timeConstant, t);
        const value = m.valueAt(t);
        const velocity = m.velocityAt(t);

        // Relative-ish tolerance: Euler integration has small discretization
        // error; 200k steps over t<=2s makes it negligible (<1e-3 absolute
        // for these magnitudes).
        expect(Math.abs(value - oracle.x)).toBeLessThan(1e-2);
        expect(Math.abs(velocity - oracle.v)).toBeLessThan(1e-2);
      }
    });
  }

  it('rest point matches the Euler oracle run out to a very long horizon (t → "infinity")', () => {
    const c = { from: 0, velocity: 1000, power: 0.8, timeConstant: 0.35 };
    const m = createDecay(c);
    const oracle = eulerDecay(c.from, c.power * c.velocity, c.timeConstant, 20 /* ~57 time-constants */);
    expect(Math.abs(m.rest - oracle.x)).toBeLessThan(1e-3);
  });

  it('rest point matches the hand-derived closed-form: from + power*velocity*timeConstant', () => {
    const c = { from: 100, velocity: 500, power: 0.8, timeConstant: 0.35 };
    const m = createDecay(c);
    expect(m.rest).toBeCloseTo(100 + 0.8 * 500 * 0.35, 9);
  });
});

describe('decay: velocityAt is the exact analytical derivative of valueAt (internal consistency)', () => {
  it('numerical derivative of valueAt matches velocityAt within epsilon', () => {
    const m = createDecay({ from: 0, velocity: 1500, power: 0.8, timeConstant: 0.4 });
    const h = 1e-5;
    for (const t of [0.01, 0.1, 0.3, 0.8, 1.5]) {
      const numDeriv = (m.valueAt(t + h) - m.valueAt(t - h)) / (2 * h);
      expect(Math.abs(numDeriv - m.velocityAt(t))).toBeLessThan(1);
    }
  });
});

describe('decay: monotonic convergence (velocity magnitude decreases toward zero)', () => {
  it('|velocityAt(t)| is non-increasing over an increasing t sequence', () => {
    const m = createDecay({ from: 0, velocity: 1200, power: 0.8, timeConstant: 0.3 });
    let prev = Math.abs(m.velocityAt(0));
    for (let t = 0.05; t <= 3; t += 0.05) {
      const cur = Math.abs(m.velocityAt(t));
      expect(cur).toBeLessThanOrEqual(prev + 1e-9);
      prev = cur;
    }
  });

  it('isSettledAt becomes true past a sufficiently large t and stays true', () => {
    const m = createDecay({ from: 0, velocity: 1200, power: 0.8, timeConstant: 0.3, restDelta: 0.5 });
    expect(m.isSettledAt(100)).toBe(true);
    // Once decayed below threshold it should remain settled for even larger t.
    expect(m.isSettledAt(1000)).toBe(true);
  });
});

describe('decay: determinism (invariant 3 — bit-identical re-run via injected virtual time)', () => {
  it('same options + same t sequence → bit-identical outputs across independent model instances', () => {
    const opts = { from: 12.5, velocity: -777, power: 0.8, timeConstant: 0.35 };
    const m1 = createDecay({ ...opts });
    const m2 = createDecay({ ...opts });

    for (const t of [0, 0.01, 0.1, 0.5, 1, 5, 100]) {
      expect(m1.valueAt(t)).toBe(m2.valueAt(t));
      expect(m1.velocityAt(t)).toBe(m2.velocityAt(t));
      expect(m1.isSettledAt(t)).toBe(m2.isSettledAt(t));
    }
    expect(m1.rest).toBe(m2.rest);
  });
});
