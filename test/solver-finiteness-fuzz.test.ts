import { describe, expect, it } from 'vitest';
import { spring } from '../src/index.js';

/**
 * Test: solver finiteness property fuzz
 * Class: property
 * Invariant 2 — CSS-safe output: no path ever returns NaN/Infinity/-Infinity.
 *
 * Strategy: seeded LCG (linear congruential generator) — deterministic, zero deps,
 * fully reproducible without any external property-testing library.
 * 500 draws over the valid (mass, stiffness, damping, t) space, including edges.
 *
 * RED proof:
 *   `spring` is not exported from the placeholder (it is `undefined`). The test
 *   first asserts `typeof spring === 'function'` before the loop, which fails with:
 *   "expected 'undefined' to be 'function'" — RED for the right reason (behavior
 *   missing, not a compile error or test logic error).
 *
 *   Note: a naive fuzz loop that catches all errors would PASS on the placeholder
 *   (swallowing "spring is not a function" → no failures recorded → green). That
 *   is test theater and is explicitly rejected here. The function-type guard at the
 *   top of the test proves the engine is present before the fuzz loop runs.
 *
 * Mutation proof (for when implemented):
 *   Break the solver by returning `{ value: NaN, velocity: 0 }` for any input.
 *   The Number.isFinite(result.value) assertion fails on the very first sample.
 *   Or break by returning Infinity when damping approaches 0 — the boundary
 *   samples in the LCG sequence will trigger it.
 *   Only `MotionParamError` may be thrown for truly degenerate params (e.g.
 *   mass exactly 0); any other exception is a bug (assertion re-throws it).
 */

/** Park-Miller LCG — seeded, reproducible, zero dependencies. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(48271, s) + 0) & 0x7fffffff;
    return s / 0x7fffffff; // [0, 1)
  };
}

/** Map a uniform [0,1) value to the range [min, max]. */
function range(u: number, min: number, max: number): number {
  return min + u * (max - min);
}

describe('solver finiteness property fuzz (invariant 2)', () => {
  it('spring is callable — prerequisite guard (RED if engine absent)', () => {
    // This assertion is the RED hook for the placeholder:
    // src/index.ts does not export `spring`, so it is `undefined`.
    // If this fails, the fuzz loop below would silently pass (theater) — so we
    // explicitly break here instead.
    expect(typeof spring).toBe('function');
  });

  it('produces finite value and velocity for >=500 seeded samples over the valid domain', () => {
    const rand = lcg(0xdeadbeef);
    const SAMPLES = 500;

    // Domain bounds:
    //   mass:      (0, 100] — positive, bounded above
    //   stiffness: (0, 2000] — positive, bounded above
    //   damping:   [0, 200] — zero is undamped (valid, oscillatory)
    //   t:         [0, 1] — normalized simulation time

    // Edge values injected at fixed positions to guarantee boundary coverage:
    const EDGES: Array<{ mass: number; stiffness: number; damping: number; t: number }> = [
      { mass: 1e-9, stiffness: 1e-9, damping: 0, t: 0 },
      { mass: 100, stiffness: 2000, damping: 200, t: 1 },
      { mass: 1, stiffness: 1, damping: 0, t: 0.5 },
      { mass: 50, stiffness: 1000, damping: 100, t: 0 },
      { mass: 0.001, stiffness: 0.001, damping: 0.001, t: 1 },
    ];

    const failures: string[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      // Every ~100 samples inject an edge case instead of a random one.
      const sample =
        i < EDGES.length
          ? (EDGES[i] ?? { mass: 1, stiffness: 100, damping: 10, t: 0.5 })
          : {
              mass: range(rand(), 1e-9, 100),
              stiffness: range(rand(), 1e-9, 2000),
              damping: range(rand(), 0, 200),
              t: rand(),
            };

      let result: { value: number; velocity: number };
      try {
        result = spring(sample, sample.t);
      } catch (err: unknown) {
        // MotionParamError is allowed for truly degenerate params that the engine
        // rejects (e.g. params near zero that exceed the safe domain). Re-throw
        // anything that is NOT a MotionParamError — those are real bugs.
        const isMotionParamError =
          err instanceof Error && err.constructor.name === 'MotionParamError';
        if (!isMotionParamError) {
          throw err; // propagate unexpected errors — RED for the right reason
        }
        continue; // legitimate param rejection — skip this sample
      }

      if (!Number.isFinite(result.value)) {
        failures.push(`sample ${i}: value=${result.value} for params=${JSON.stringify(sample)}`);
      }
      if (!Number.isFinite(result.velocity)) {
        failures.push(
          `sample ${i}: velocity=${result.velocity} for params=${JSON.stringify(sample)}`,
        );
      }
    }

    expect(
      failures,
      `Non-finite outputs detected (CSS-safe invariant 2 violated):\n${failures.join('\n')}`,
    ).toHaveLength(0);
  });
});
