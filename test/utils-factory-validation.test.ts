/**
 * utils-factory-validation.test.ts — contract (eager validation boundary)
 *
 * Every CONFIG boundary that must reject invalid input throws MotionParamError
 * synchronously (mirrors easing power/steps/cubicBezier). The trailing VALUE
 * argument NEVER throws — it is hardened by clampFinite instead.
 *
 * clamp is the deliberate exception: it accepts ±Infinity bounds (one-sided
 * clamp idiom) and throws ONLY on NaN bounds.
 *
 * Mutation proof: flip any `throw` to a silent return → the matching
 * `.toThrow(MotionParamError)` case goes RED. Widen a guard (e.g. accept
 * increment===0) → the control case that must throw goes RED.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { clamp, wrap, snap, mapRange, interpolate } from '../src/utils/index.js';

describe('@labpics/motion/utils factory validation', () => {
  // Anti-theater: the error class must exist before asserting anything throws it.
  it('MotionParamError is constructable — prerequisite guard', () => {
    expect(typeof MotionParamError).toBe('function');
    expect(new MotionParamError('x')).toBeInstanceOf(Error);
  });

  // ── clamp: NaN bounds throw; ±Infinity bounds allowed ──────────────────────
  it('clamp(NaN, 1) throws MotionParamError (/NaN/i)', () => {
    expect(() => clamp(Number.NaN, 1)).toThrow(MotionParamError);
    expect(() => clamp(Number.NaN, 1)).toThrow(/nan/i);
  });
  it('clamp(0, NaN) throws MotionParamError (/NaN/i)', () => {
    expect(() => clamp(0, Number.NaN)).toThrow(MotionParamError);
  });
  it('clamp(0, Infinity) does NOT throw (one-sided clamp idiom)', () => {
    expect(() => clamp(0, Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => clamp(0, Number.POSITIVE_INFINITY, 5)).not.toThrow();
  });
  it('clamp(-Infinity, Infinity) does NOT throw', () => {
    expect(() => clamp(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)).not.toThrow();
  });
  it('clamp never throws on the value argument', () => {
    expect(() => clamp(0, 1, Number.NaN)).not.toThrow();
    expect(() => clamp(0, 1, Number.POSITIVE_INFINITY)).not.toThrow();
  });

  // ── wrap: all non-finite bounds throw (/finite/i) ──────────────────────────
  it('wrap(NaN, 1) throws MotionParamError (/finite/i)', () => {
    expect(() => wrap(Number.NaN, 1)).toThrow(MotionParamError);
    expect(() => wrap(Number.NaN, 1)).toThrow(/finite/i);
  });
  it('wrap(0, Infinity) throws MotionParamError (non-finite bound)', () => {
    expect(() => wrap(0, Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
  });
  it('wrap(-Infinity, 0) throws MotionParamError', () => {
    expect(() => wrap(Number.NEGATIVE_INFINITY, 0)).toThrow(MotionParamError);
  });
  it('wrap(0, 360) does NOT throw; never throws on value', () => {
    expect(() => wrap(0, 360)).not.toThrow();
    expect(() => wrap(0, 360, Number.NaN)).not.toThrow();
  });

  // ── snap: increment 0 / non-finite / empty targets / non-finite element ────
  it('snap(0) throws MotionParamError (/zero/i)', () => {
    expect(() => snap(0)).toThrow(MotionParamError);
    expect(() => snap(0)).toThrow(/zero/i);
  });
  it('snap(NaN) throws MotionParamError (/finite/i)', () => {
    expect(() => snap(Number.NaN)).toThrow(MotionParamError);
    expect(() => snap(Number.NaN)).toThrow(/finite/i);
  });
  it('snap(Infinity) throws MotionParamError (/finite/i)', () => {
    expect(() => snap(Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
  });
  it('snap([]) throws MotionParamError (/empty/i)', () => {
    expect(() => snap([])).toThrow(MotionParamError);
    expect(() => snap([])).toThrow(/empty/i);
  });
  it('snap([0, NaN, 1]) throws MotionParamError (/finite/i)', () => {
    expect(() => snap([0, Number.NaN, 1])).toThrow(MotionParamError);
    expect(() => snap([0, Number.NaN, 1])).toThrow(/finite/i);
  });
  it('snap(-5) does NOT throw (negative increment legal — same lattice as |increment|)', () => {
    expect(() => snap(-5)).not.toThrow();
    expect(() => snap(-5, 12)).not.toThrow();
  });
  it('snap never throws on the value argument', () => {
    expect(() => snap(10, Number.NaN)).not.toThrow();
    expect(() => snap([0, 1], Number.POSITIVE_INFINITY)).not.toThrow();
  });

  // ── mapRange: any non-finite bound throws (/finite/i) ──────────────────────
  it('mapRange(0, Infinity, 0, 1) throws MotionParamError (/finite/i)', () => {
    expect(() => mapRange(0, Number.POSITIVE_INFINITY, 0, 1)).toThrow(MotionParamError);
    expect(() => mapRange(0, Number.POSITIVE_INFINITY, 0, 1)).toThrow(/finite/i);
  });
  it('mapRange(NaN, 1, 0, 1) throws MotionParamError', () => {
    expect(() => mapRange(Number.NaN, 1, 0, 1)).toThrow(MotionParamError);
  });
  it('mapRange(0, 1, 0, Infinity) throws MotionParamError (output bound)', () => {
    expect(() => mapRange(0, 1, 0, Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
  });
  it('mapRange(0, 100, 0, 1) does NOT throw; never throws on value', () => {
    expect(() => mapRange(0, 100, 0, 1)).not.toThrow();
    expect(() => mapRange(0, 100, 0, 1, Number.NaN)).not.toThrow();
  });

  // ── interpolate: eager factory validation ──────────────────────────────────
  it('interpolate([0], [0]) throws (needs >= 2 stops, /length/i)', () => {
    expect(() => interpolate([0], [0])).toThrow(MotionParamError);
    expect(() => interpolate([0], [0])).toThrow(/length/i);
  });
  it('interpolate([0,1], [0]) throws (length mismatch, /length/i)', () => {
    expect(() => interpolate([0, 1], [0])).toThrow(MotionParamError);
    expect(() => interpolate([0, 1], [0])).toThrow(/length/i);
  });
  it('interpolate([1,0], [0,1]) throws (not ascending, /ascend|increasing/i)', () => {
    expect(() => interpolate([1, 0], [0, 1])).toThrow(MotionParamError);
    expect(() => interpolate([1, 0], [0, 1])).toThrow(/ascend|increasing/i);
  });
  it('interpolate([0,0], [0,1]) throws (zero-width segment, /ascend|increasing/i)', () => {
    expect(() => interpolate([0, 0], [0, 1])).toThrow(MotionParamError);
  });
  it('interpolate([0, Infinity], [0,1]) throws (non-finite input, /finite/i)', () => {
    expect(() => interpolate([0, Number.POSITIVE_INFINITY], [0, 1])).toThrow(MotionParamError);
    expect(() => interpolate([0, Number.POSITIVE_INFINITY], [0, 1])).toThrow(/finite/i);
  });
  it('interpolate([0,1], [0, NaN]) throws (non-finite numeric output, /finite/i)', () => {
    expect(() => interpolate([0, 1], [0, Number.NaN])).toThrow(MotionParamError);
    expect(() => interpolate([0, 1], [0, Number.NaN])).toThrow(/finite/i);
  });
  it('interpolate ease-array of wrong length throws (/ease|length/i)', () => {
    expect(() => interpolate([0, 0.5, 1], [0, 10, 20], { ease: [(t: number) => t] })).toThrow(
      MotionParamError,
    );
    expect(() => interpolate([0, 0.5, 1], [0, 10, 20], { ease: [(t: number) => t] })).toThrow(
      /ease|length/i,
    );
  });
  it('interpolate valid numeric config does NOT throw', () => {
    expect(() => interpolate([0, 1], [0, 1])).not.toThrow();
    expect(() => interpolate([0, 0.5, 1], [0, 10, 20], { clamp: false })).not.toThrow();
  });
  it('interpolate with mixer leaves output values UNVALIDATED (opaque T)', () => {
    // A string mixer path never validates output finiteness — arbitrary T allowed.
    expect(() =>
      interpolate([0, 1], ['a', 'b'], { mixer: (f: string) => f }),
    ).not.toThrow();
  });
});
