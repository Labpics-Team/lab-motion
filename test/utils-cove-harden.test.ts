/**
 * utils-cove-harden.test.ts — adversarial-verification hardening
 *
 * Pins derived from a Chain-of-Verification pass (independent skeptics that
 * executed code against the built dist, plus an external reviewer). Each pin
 * either fixes a confirmed defect or kills a confirmed surviving mutant that
 * the original suite missed. Grouped by root cause.
 */

import { describe, expect, it } from 'vitest';
import { clamp, mix, wrap, snap, mapRange, interpolate } from '../src/utils/index.js';
import { MotionParamError } from '../src/errors.js';

// A non-dyadic float pair: a + (b - a) drifts from b, so bit-exact endpoints
// can only come from an explicit short-circuit (not the a+(b-a)*t formula).
const A = -981.5098163680669;
const B = -9.906160017621835;

describe('cove — U1 finiteness at interpolate endpoints (custom numeric mixer)', () => {
  // With a custom mixer the output array is NOT eagerly validated (opaque T),
  // so a non-finite NUMERIC endpoint must still be clamped at the short-circuit.
  const numMixer = (f: number, t: number, p: number): number => f + (t - f) * p;
  it('non-finite numeric endpoint output is clamped, not leaked (upper)', () => {
    const f = interpolate([0, 1], [0, Number.POSITIVE_INFINITY], { mixer: numMixer });
    expect(f(5)).toBe(Number.MAX_VALUE); // x >= inLast short-circuit, clamped
    expect(Number.isFinite(f(5))).toBe(true);
  });
  it('non-finite numeric endpoint output is clamped, not leaked (lower)', () => {
    const f = interpolate([0, 1], [Number.NEGATIVE_INFINITY, 0], { mixer: numMixer });
    expect(f(-5)).toBe(-Number.MAX_VALUE);
  });
  it('NON-numeric endpoint (string mixer) is returned verbatim (T preserved)', () => {
    const d = interpolate([0, 1], ['a', 'b'], { mixer: (f, t, p) => (p < 0.5 ? f : t) });
    expect(d(5)).toBe('b'); // upper endpoint verbatim
    expect(d(-5)).toBe('a'); // lower endpoint verbatim
  });
});

describe('cove — interior/terminal breakpoint exactness (lerp overflow)', () => {
  // Right-hand segment output difference overflows: |MAX - (-MAX)| = 2·MAX → ∞.
  // ∞*0 = NaN would collapse to 0 without an endpoint short-circuit in lerp.
  it('interior breakpoint is bit-exact even when the next segment overflows', () => {
    const f = interpolate([0, 1, 2], [0, -Number.MAX_VALUE, Number.MAX_VALUE]);
    expect(f(1)).toBe(-Number.MAX_VALUE); // p=0 of segment [1,2] → output[1] exact
  });
  it('terminal breakpoint under clamp:false is bit-exact (no a+(b-a)*1 drift)', () => {
    const f = interpolate([0, 1], [A, B], { clamp: false });
    expect(f(1)).toBe(B); // p=1, no short-circuit gate → must still be exact
  });
});

describe('cove — mutation survivors: clamp inner clampFinite on NaN (range excludes 0)', () => {
  it('clamp(5,10,NaN) === 5 (NaN value clamped INTO range, not passed through)', () => {
    expect(clamp(5, 10, Number.NaN)).toBe(5);
  });
  it('clamp(-10,-5,NaN) === -5 (upper-side NaN clamp for all-negative range)', () => {
    expect(clamp(-10, -5, Number.NaN)).toBe(-5);
  });
});

describe('cove — mutation survivors: interpolate clamp-endpoint comparators', () => {
  it('lower endpoint IGNORES ease: f(input[0]) === output[0] (kills x<=in0 → x<in0)', () => {
    expect(interpolate([0, 1], [0, 100], { ease: (t) => t + 0.1 })(0)).toBe(0);
  });
  it('upper endpoint IGNORES ease: f(input[last]) === output[last] (kills x>=inLast → x>inLast)', () => {
    expect(interpolate([0, 1], [0, 100], { ease: (t) => t * 0.9 })(1)).toBe(100);
  });
  it('interior seg-scan boundary is inclusive: breakpoint is bit-exact (kills x>=input[k+1] → x>)', () => {
    expect(interpolate([0, 1, 2], [A, B, 0])(1)).toBe(B);
  });
});

describe('cove — mutation survivors: bit-exact endpoints on non-dyadic values', () => {
  it('mix(A,B,1) === B bit-exact (kills dropping p===1 short-circuit)', () => {
    expect(mix(A, B, 1)).toBe(B);
    expect(Object.is(mix(A, B, 1), B)).toBe(true);
  });
  it('mix(A,B,0) === A bit-exact (kills dropping p===0 short-circuit)', () => {
    expect(mix(A, B, 0)).toBe(A);
  });
  it('mapRange(0,1,A,B,1) === B bit-exact (kills dropping x===inMax short-circuit)', () => {
    expect(mapRange(0, 1, A, B, 1)).toBe(B);
  });
  it('mapRange(0,1,A,B,0) === A bit-exact (kills dropping x===inMin short-circuit)', () => {
    expect(mapRange(0, 1, A, B, 0)).toBe(A);
  });
});

describe('cove — U3 purity: mappers are immune to post-build caller mutation', () => {
  it('interpolate snapshots input/output (later caller mutation does not change the mapper)', () => {
    const input = [0, 1, 2];
    const output = [0, 10, 20];
    const f = interpolate(input, output);
    const before = f(1.5);
    input[1] = 999; // hostile post-factory mutation
    output[1] = -999;
    input[2] = -5;
    expect(f(1.5)).toBe(before); // unaffected
    expect(f(1)).toBe(10); // breakpoint still original output
  });
  it('snap(targets) snapshots the targets array', () => {
    const targets = [0, 10, 100];
    const s = snap(targets);
    targets[1] = 999; // hostile mutation after build
    expect(s(7)).toBe(10); // still nearest to the ORIGINAL 10, not 999
  });
});

describe('cove — U2 eager validation: interpolate ease-array element callability', () => {
  it('a non-function ease element throws MotionParamError eagerly (not a deferred TypeError)', () => {
    expect(() =>
      // @ts-expect-error — intentional invalid element for the runtime guard
      interpolate([0, 0.5, 1], [0, 10, 20], { ease: [(t: number) => t, 'nope'] }),
    ).toThrow(MotionParamError);
    expect(() =>
      // @ts-expect-error — intentional invalid element
      interpolate([0, 0.5, 1], [0, 10, 20], { ease: [(t: number) => t, null] }),
    ).toThrow(/^LM118$/);
  });
  it('a valid ease array still does not throw', () => {
    expect(() =>
      interpolate([0, 0.5, 1], [0, 10, 20], { ease: [(t) => t, (t) => t * t] }),
    ).not.toThrow();
  });
});

describe('cove — regression guard: wrap still finite at exact -0 boundary', () => {
  it('wrap(0,360,-0) === 0 (no signed-zero surprise)', () => {
    expect(wrap(0, 360, -0)).toBe(0);
  });
});
