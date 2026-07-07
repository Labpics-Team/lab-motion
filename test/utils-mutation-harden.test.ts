/**
 * utils-mutation-harden.test.ts — mutation hardening
 *
 * Exact-value pins on every edge branch so mutants die. Each case is labelled
 * with the branch/mutant it kills. Complements the differential suite with the
 * specific hostile-input pins that pure interior sweeps would miss.
 */

import { describe, expect, it } from 'vitest';
import { clamp, mix, wrap, snap, mapRange, interpolate, pipe } from '../src/utils/index.js';

describe('utils mutation harden — clampFinite branch order (via public exports)', () => {
  // clampFinite: isFinite → x ; NaN → 0 ; +Inf → MAX_VALUE ; -Inf → -MAX_VALUE.
  // Collapsing NaN/sign branches maps NaN → -MAX_VALUE (NaN>0 === false) → these die.
  it('NaN value clamps to exactly 0 (not sign branch)', () => {
    expect(clamp(-1e9, 1e9, Number.NaN)).toBe(0);
    expect(mix(0, 0, Number.NaN)).toBe(0);
    expect(wrap(-1e9, 1e9, Number.NaN)).toBe(0);
    expect(snap(1, Number.NaN)).toBe(0);
  });
  it('+Infinity progress through mix clamps to exactly Number.MAX_VALUE', () => {
    expect(mix(0, 100, Number.POSITIVE_INFINITY)).toBe(Number.MAX_VALUE);
  });
  it('-Infinity progress through mix clamps to exactly -Number.MAX_VALUE', () => {
    expect(mix(0, 100, Number.NEGATIVE_INFINITY)).toBe(-Number.MAX_VALUE);
  });
  it('overflow (MAX_VALUE*2 → +Infinity) clamps to exactly Number.MAX_VALUE', () => {
    // mix(0, MAX_VALUE, 2) = MAX_VALUE*2 = +Infinity → clampFinite → MAX_VALUE
    expect(mix(0, Number.MAX_VALUE, 2)).toBe(Number.MAX_VALUE);
  });
});

describe('utils mutation harden — mix endpoint short-circuits', () => {
  it('mix(7,9,0) bit-exact 7 (kills p===0 → p!==0 mutant)', () => {
    expect(mix(7, 9, 0)).toBe(7);
    expect(Object.is(mix(7, 9, 0), 7)).toBe(true);
  });
  it('mix(7,9,1) bit-exact 9 (kills p===1 mutant)', () => {
    expect(mix(7, 9, 1)).toBe(9);
  });
  it('mix(10,20,NaN)=10 (NaN → clampFinite 0 → start branch)', () => {
    expect(mix(10, 20, Number.NaN)).toBe(10);
  });
  it('mix(5,5,Infinity)=5 (degenerate endpoints, 0*MAX_VALUE=0)', () => {
    expect(mix(5, 5, Number.POSITIVE_INFINITY)).toBe(5);
  });
});

describe('utils mutation harden — clamp branches + curry', () => {
  it('clamp(10,5,7)=5 (min>max → Math.min(max,·) wins; kills swapped min/max)', () => {
    expect(clamp(10, 5, 7)).toBe(5);
  });
  it('clamp(0,1,NaN)=0 (value clampFinite BEFORE min/max; kills leak)', () => {
    expect(clamp(0, 1, Number.NaN)).toBe(0);
  });
  it('curry dispatch: typeof clamp(0,1)==="function" AND clamp(0,1,2)===1', () => {
    expect(typeof clamp(0, 1)).toBe('function'); // value===undefined branch
    expect(clamp(0, 1, 2)).toBe(1); // value provided branch
  });
});

describe('utils mutation harden — wrap half-open + degenerate', () => {
  it('wrap(0,360,360)=0 (half-open top folds to min; kills off-by-range)', () => {
    expect(wrap(0, 360, 360)).toBe(0);
  });
  it('wrap(-50,50,60)=-40 (double-mod correctness for offset range)', () => {
    expect(wrap(-50, 50, 60)).toBe(-40);
  });
  it('wrap(5,5,9)=5 (range===0 short-circuit kills %0 → NaN)', () => {
    expect(wrap(5, 5, 9)).toBe(5);
  });
  it('wrap(0,360,-10)=350 (positive-modulo correction of negative dividend)', () => {
    expect(wrap(0, 360, -10)).toBe(350);
  });
});

describe('utils mutation harden — snap rounding + tie', () => {
  it('snap(5,-12.5)=-10 (Math.round(-2.5)=-2, half toward +Infinity)', () => {
    expect(snap(5, -12.5)).toBe(-10);
  });
  it('snap(10,15)=20 (Math.round(1.5)=2 not trunc)', () => {
    expect(snap(10, 15)).toBe(20);
  });
  it('snap([0,10,100],5)=0 (tie resolves to FIRST index; kills <= → <)', () => {
    expect(snap([0, 10, 100], 5)).toBe(0);
  });
  it('snap([0,10,100],7)=10 (strict nearest)', () => {
    expect(snap([0, 10, 100], 7)).toBe(10);
  });
});

describe('utils mutation harden — mapRange endpoints + degenerate + unclamped', () => {
  it('mapRange(0,100,0,1,0)=0 exact, (100)=1 exact (endpoint short-circuits)', () => {
    expect(mapRange(0, 100, 0, 1, 0)).toBe(0);
    expect(mapRange(0, 100, 0, 1, 100)).toBe(1);
  });
  it('mapRange(0,100,0,1,150)=1.5 (unclamped — kills a hidden clamp mutant)', () => {
    expect(mapRange(0, 100, 0, 1, 150)).toBe(1.5);
  });
  it('mapRange(5,5,0,1,9)=0 (d===0 → outMin; kills /0)', () => {
    expect(mapRange(5, 5, 0, 1, 9)).toBe(0);
  });
  it('mapRange(0,10,100,0,2)=80 (reversed output; kills swapped outMin/outMax)', () => {
    expect(mapRange(0, 10, 100, 0, 2)).toBe(80);
  });
});

describe('utils mutation harden — interpolate segment/clamp/ease', () => {
  it('interior breakpoint p=0 exactness: interpolate([-100,0,100],[0,50,0])(0)===50', () => {
    expect(interpolate([-100, 0, 100], [0, 50, 0])(0)).toBe(50);
  });
  it('clamp ON vs OFF at (200): 0 vs extrapolated', () => {
    expect(interpolate([-100, 0, 100], [0, 50, 0])(200)).toBe(0); // clamp default → output[last]
    // clamp:false, last segment [0..100]→[50..0], p=(200-0)/100=2 → lerp(50,0,2)=-50
    expect(interpolate([-100, 0, 100], [0, 50, 0], { clamp: false })(200)).toBe(-50);
  });
  it('eased segment: {ease:t=>t*t}(0.5)===25 (kills identity-ease mutant)', () => {
    expect(interpolate([0, 1], [0, 100], { ease: (t) => t * t })(0.5)).toBe(25);
  });
  it('descending output segment: interpolate([-100,0,100],[0,50,0])(50)===25', () => {
    expect(interpolate([-100, 0, 100], [0, 50, 0])(50)).toBe(25);
  });
});

describe('utils mutation harden — pipe order + identity', () => {
  it('pipe(+1,*10)(0)===10 (left-to-right; reversed order would give 1)', () => {
    expect(pipe((x: number) => x + 1, (x: number) => x * 10)(0)).toBe(10);
  });
  it('pipe() identity returns input unchanged', () => {
    expect(pipe<number>()(42)).toBe(42);
    expect(pipe<string>()('z')).toBe('z');
  });
});
