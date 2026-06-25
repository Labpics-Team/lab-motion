import { describe, expect, it } from 'vitest';
import { spring } from '../src/index.js';

/**
 * Test: spring determinism + idempotency
 * Class: unit
 * Invariant 3 — identical (params, t) → byte-identical output; no hidden global state.
 *
 * RED proof:
 *   The production implementation does not exist yet (src/index.ts exports only
 *   PACKAGE_NAME). `spring` is not exported → the import fails at runtime → every
 *   test in this file fails with "spring is not a function" (or undefined), which is
 *   the CORRECT red reason: the function the test asserts is missing behavior.
 *
 * Mutation proof (for when the function exists):
 *   Break by making spring() call Math.random() or Date.now() internally.
 *   The deep-equal assertion on two calls with the same args will then fail.
 */

describe('spring determinism + idempotency (invariant 3)', () => {
  const params = { mass: 1, stiffness: 100, damping: 10 };

  it('returns byte-identical output for identical params at t=0', () => {
    const a = spring(params, 0);
    const b = spring(params, 0);
    expect(a).toStrictEqual(b);
  });

  it('returns byte-identical output for identical params at t=0.5', () => {
    const a = spring(params, 0.5);
    const b = spring(params, 0.5);
    expect(a).toStrictEqual(b);
  });

  it('returns byte-identical output for identical params at t=1', () => {
    const a = spring(params, 1);
    const b = spring(params, 1);
    expect(a).toStrictEqual(b);
  });

  it('varies output when params differ (not a constant function)', () => {
    const at0 = spring(params, 0);
    const at1 = spring(params, 1);
    // A real spring solver produces different output at different times.
    // This catches the trivially-passing stub that returns the same object always.
    expect(at0).not.toStrictEqual(at1);
  });
});
