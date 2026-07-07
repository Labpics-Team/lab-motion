/**
 * utils-differential.test.ts — behavioral / differential
 *
 * Pins exact numeric behavior against INDEPENDENT re-implemented references
 * (never importing src internals). Endpoints asserted bit-exact (===);
 * interior asserted within 1e-9 of the reference.
 *
 * These are the assertions the design spec enumerated for each function.
 */

import { describe, expect, it } from 'vitest';
import { clamp, mix, wrap, snap, mapRange, interpolate, pipe } from '../src/utils/index.js';

// ── independent references (hand-rolled, no src import) ──────────────────────
const refLerp = (a: number, b: number, t: number): number => (1 - t) * a + t * b;
const refClamp = (min: number, max: number, v: number): number => Math.min(max, Math.max(min, v));
const refWrap = (min: number, max: number, v: number): number => {
  const r = max - min;
  return (((v - min) % r) + r) % r + min;
};
const refSnapInc = (i: number, v: number): number => Math.round(v / i) * i;
const refMap = (a: number, b: number, c: number, d: number, v: number): number =>
  c + ((v - a) / (b - a)) * (d - c);

describe('utils differential — clamp', () => {
  it('clamp(0,1,0.5)=0.5, clamp(0,1,-3)=0, clamp(0,1,5)=1', () => {
    expect(clamp(0, 1, 0.5)).toBe(0.5);
    expect(clamp(0, 1, -3)).toBe(0);
    expect(clamp(0, 1, 5)).toBe(1);
  });
  it('clamp(0,1,NaN)=0 (clampFinite value → in range)', () => {
    expect(clamp(0, 1, Number.NaN)).toBe(0);
  });
  it('clamp(10,5,7)=5 (min>max branch: Math.min wins)', () => {
    expect(clamp(10, 5, 7)).toBe(5);
  });
  it('clamp(0,Infinity,-3)=0 (one-sided lower clamp, finite)', () => {
    expect(clamp(0, Number.POSITIVE_INFINITY, -3)).toBe(0);
  });
  it('curried clamp(0,1)(5)=1 and equals uncurried', () => {
    expect(clamp(0, 1)(5)).toBe(1);
    expect(clamp(0, 1)(0.25)).toBe(clamp(0, 1, 0.25));
  });
  it('interior sweep matches reference within 1e-9', () => {
    for (let v = -5; v <= 5; v += 0.13) {
      expect(clamp(-2, 3, v)).toBeCloseTo(refClamp(-2, 3, v), 9);
    }
  });
});

describe('utils differential — mix', () => {
  it('mix(0,100,0.5)=50, mix(0,100,2)=200, mix(0,100,-0.5)=-50', () => {
    expect(mix(0, 100, 0.5)).toBe(50);
    expect(mix(0, 100, 2)).toBe(200);
    expect(mix(0, 100, -0.5)).toBe(-50);
  });
  it('mix endpoints are bit-exact (===): mix(a,b,0)=a, mix(a,b,1)=b', () => {
    expect(mix(7, 9, 0)).toBe(7);
    expect(mix(7, 9, 1)).toBe(9);
    expect(mix(-3.25, 11.75, 0)).toBe(-3.25);
    expect(mix(-3.25, 11.75, 1)).toBe(11.75);
  });
  it('mix(10,20,NaN)=10 (NaN progress → start)', () => {
    expect(mix(10, 20, Number.NaN)).toBe(10);
  });
  it('mix(0,100,Infinity)=MAX_VALUE, mix(5,5,Infinity)=5', () => {
    expect(mix(0, 100, Number.POSITIVE_INFINITY)).toBe(Number.MAX_VALUE);
    expect(mix(5, 5, Number.POSITIVE_INFINITY)).toBe(5);
  });
  it('interior sweep matches reference lerp within 1e-9', () => {
    for (let t = 0.01; t < 1; t += 0.017) {
      expect(mix(-40, 60, t)).toBeCloseTo(refLerp(-40, 60, t), 9);
    }
  });
});

describe('utils differential — wrap', () => {
  it('wrap(0,360,370)=10, wrap(0,360,-10)=350, wrap(0,360,360)=0', () => {
    expect(wrap(0, 360, 370)).toBe(10);
    expect(wrap(0, 360, -10)).toBe(350);
    expect(wrap(0, 360, 360)).toBe(0);
  });
  it('wrap(0,100,150)=50, wrap(-50,50,60)=-40', () => {
    expect(wrap(0, 100, 150)).toBe(50);
    expect(wrap(-50, 50, 60)).toBe(-40);
  });
  it('wrap(5,5,9)=5 (degenerate range → min)', () => {
    expect(wrap(5, 5, 9)).toBe(5);
  });
  it('wrap(0,10,NaN)=0 (clampFinite value)', () => {
    expect(wrap(0, 10, Number.NaN)).toBe(0);
  });
  it('curried wrap(0,360)(370)=10', () => {
    expect(wrap(0, 360)(370)).toBe(10);
  });
  it('interior sweep matches reference within 1e-9', () => {
    for (let v = -800; v <= 800; v += 37) {
      expect(wrap(0, 360, v)).toBeCloseTo(refWrap(0, 360, v), 9);
    }
  });
});

describe('utils differential — snap', () => {
  it('snap(10,12)=10, snap(10,17)=20, snap(10,15)=20', () => {
    expect(snap(10, 12)).toBe(10);
    expect(snap(10, 17)).toBe(20);
    expect(snap(10, 15)).toBe(20); // Math.round(1.5) = 2
  });
  it('snap(5,-12.5)=-10 (Math.round(-2.5)=-2, half toward +Infinity)', () => {
    expect(snap(5, -12.5)).toBe(-10);
  });
  it('snap([0,10,100],7)=10 (nearest)', () => {
    expect(snap([0, 10, 100], 7)).toBe(10);
  });
  it('snap([0,10,100],5)=0 (tie |5-0|==|5-10| resolves to first index)', () => {
    expect(snap([0, 10, 100], 5)).toBe(0);
  });
  it('snap(5,NaN)=0 (clampFinite value)', () => {
    expect(snap(5, Number.NaN)).toBe(0);
  });
  it('snap(-5,x) lands on the same |increment| lattice (multiple of 5)', () => {
    for (const v of [-13, -2.4, 0, 3.7, 12.5, 88, -0.1]) {
      expect(Number.isInteger(snap(-5, v) / 5)).toBe(true);
    }
  });
  it('snap(-5,x) === snap(5,x) away from exact half-ties', () => {
    // Equal everywhere EXCEPT exact k.5 ties, where Math.round rounds half
    // toward +Infinity asymmetrically under sign flip (snap(5,12.5)=15 vs
    // snap(-5,12.5)=10 — both on the lattice, different tie direction).
    for (const v of [-13, -2.4, 0, 3.7, 88, -0.1, 7.31]) {
      expect(snap(-5, v)).toBe(snap(5, v));
    }
  });
  it('curried snap(10)(17)=20 and snap([0,1])(0.7)=1', () => {
    expect(snap(10)(17)).toBe(20);
    expect(snap([0, 1])(0.7)).toBe(1);
  });
  it('increment sweep matches reference within 1e-9', () => {
    for (let v = -50; v <= 50; v += 3.1) {
      expect(snap(7, v)).toBeCloseTo(refSnapInc(7, v), 9);
    }
  });
});

describe('utils differential — mapRange', () => {
  it('mapRange(0,100,0,1,50)=0.5, endpoints exact', () => {
    expect(mapRange(0, 100, 0, 1, 50)).toBe(0.5);
    expect(mapRange(0, 100, 0, 1, 0)).toBe(0);
    expect(mapRange(0, 100, 0, 1, 100)).toBe(1);
  });
  it('mapRange(0,100,0,1,150)=1.5 (unclamped extrapolation)', () => {
    expect(mapRange(0, 100, 0, 1, 150)).toBe(1.5);
  });
  it('mapRange(0,10,100,0,2)=80 (reversed output range)', () => {
    expect(mapRange(0, 10, 100, 0, 2)).toBe(80);
  });
  it('mapRange(-1,1,0,10,0)=5', () => {
    expect(mapRange(-1, 1, 0, 10, 0)).toBe(5);
  });
  it('mapRange(5,5,0,1,9)=0 (degenerate input range → outMin)', () => {
    expect(mapRange(5, 5, 0, 1, 9)).toBe(0);
  });
  it('mapRange(0,10,100,0,NaN)=100 (clampFinite value → outMin at inMin)', () => {
    // clampFinite(NaN)=0=inMin → exact outMin endpoint
    expect(mapRange(0, 10, 100, 0, Number.NaN)).toBe(100);
  });
  it('curried mapRange(0,100,0,1)(50)=0.5', () => {
    expect(mapRange(0, 100, 0, 1)(50)).toBe(0.5);
  });
  it('interior sweep matches reference within 1e-9', () => {
    for (let v = -30; v <= 130; v += 4.3) {
      expect(mapRange(0, 100, -5, 5, v)).toBeCloseTo(refMap(0, 100, -5, 5, v), 9);
    }
  });
});

describe('utils differential — interpolate (N-stop piecewise)', () => {
  const tri = interpolate([-100, 0, 100], [0, 50, 0]);
  it('segment math: (-50)=25, (50)=25 (descending output)', () => {
    expect(tri(-50)).toBe(25);
    expect(tri(50)).toBe(25);
  });
  it('interior breakpoints are bit-exact: f(input[i]) === output[i]', () => {
    expect(tri(-100)).toBe(0);
    expect(tri(0)).toBe(50);
    expect(tri(100)).toBe(0);
  });
  it('clamp default true: (200)=0 and (-200)=0 (fold to endpoints)', () => {
    expect(tri(200)).toBe(0);
    expect(tri(-200)).toBe(0);
  });
  it('clamp:false extrapolates: interpolate([0,1],[0,100],{clamp:false})(1.5)=150', () => {
    expect(interpolate([0, 1], [0, 100], { clamp: false })(1.5)).toBe(150);
    expect(interpolate([0, 1], [0, 100], { clamp: false })(-0.5)).toBe(-50);
  });
  it('single ease applies to every segment: {ease:t=>t*t}(0.5)=25', () => {
    expect(interpolate([0, 1], [0, 100], { ease: (t) => t * t })(0.5)).toBe(25);
  });
  it('per-segment ease array: seg0 eased, seg1 identity', () => {
    const f = interpolate([0, 0.5, 1], [0, 10, 20], { ease: [(t) => t * t, (t) => t] });
    expect(f(0.25)).toBe(2.5); // seg0: p=0.5, ease 0.25 → lerp(0,10,0.25)=2.5
    expect(f(0.75)).toBe(15); // seg1: p=0.5, identity → lerp(10,20,0.5)=15
  });
  it('custom mixer plumbing (verbatim T return, segment select correct)', () => {
    const d = interpolate([0, 10], ['a', 'b'], { mixer: (f, t, p) => (p < 0.5 ? f : t) });
    expect(d(2)).toBe('a');
    expect(d(7)).toBe('b');
    expect(d(5)).toBe('b'); // p=0.5 → not < 0.5 → t
  });
  it('GSAP equivalence: evenly-spaced input reproduces linear array interpolation', () => {
    const f = interpolate([0, 0.5, 1], [0, 10, 30]);
    // reference: piecewise-linear across [0,10,30] over progress [0,1]
    const refArr = (p: number): number => {
      if (p <= 0) return 0;
      if (p >= 1) return 30;
      if (p < 0.5) return refLerp(0, 10, p / 0.5);
      return refLerp(10, 30, (p - 0.5) / 0.5);
    };
    for (let p = 0; p <= 1; p += 0.05) {
      expect(f(p)).toBeCloseTo(refArr(p), 9);
    }
  });
});

describe('utils differential — pipe', () => {
  it('left-to-right composition: pipe(+1,*3,-2)(4)=13', () => {
    expect(pipe((x: number) => x + 1, (x: number) => x * 3, (x: number) => x - 2)(4)).toBe(13);
  });
  it('order pin: pipe(+1,*10)(0)=10 (not 1)', () => {
    expect(pipe((x: number) => x + 1, (x: number) => x * 10)(0)).toBe(10);
  });
  it('pipe() is identity', () => {
    expect(pipe<number>()(42)).toBe(42);
  });
  it('composes utils primitives: pipe(clamp(0,1), snap(0.25))(0.6)=0.5', () => {
    expect(pipe(clamp(0, 1), snap(0.25))(0.6)).toBe(0.5);
  });
  it('heterogeneous stage types (number → string)', () => {
    const f = pipe(
      (x: number) => x * 2,
      (x: number) => `v=${x}`,
    );
    expect(f(3)).toBe('v=6');
  });
});
