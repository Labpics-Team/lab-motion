/**
 * easing-api-surface-pin.test.ts — contract
 * Class: contract (NE6 — feature completeness; invariant 6 for ./easing subpath)
 *
 * Pins the EXACT set of exports from the ./easing subpath.
 * Any addition or removal of an export name fails CI immediately.
 *
 * Invariant NE6 — NO descoping: every name in the enumerated set must exist.
 * Extra unlisted names are also a failure (undocumented API surface leak).
 *
 * Mutation proof:
 *   Delete `export function backIn` from src/easing/index.ts:
 *   → `missing` contains 'backIn' → test RED.
 *   Add an undocumented export `_internalHelper`:
 *   → `extra` contains '_internalHelper' → test RED.
 *   Rename `cubicBezier` to `bezier`:
 *   → missing 'cubicBezier', extra 'bezier' → RED.
 *
 * RED proof (before implementation):
 *   Before named curves are added: the import would only have `normalizeEasing` and `linear`,
 *   so `missing` would contain all other names → RED immediately.
 */

import { describe, expect, it } from 'vitest';
import * as easingModule from '../src/easing/index.js';

/**
 * The EXACT contracted export set for the @labpics/motion/easing subpath (NE6).
 * Every name must be present; no uncontracted name may exist.
 */
const EXPECTED_EASING_EXPORTS = new Set([
  // Normalizer / harness
  'normalizeEasing',

  // Core linear
  'linear',

  // Ease family (cubic In/Out/InOut — ergonomic defaults)
  'easeIn',
  'easeOut',
  'easeInOut',

  // Sine family
  'sineIn',
  'sineOut',
  'sineInOut',

  // Expo family
  'expoIn',
  'expoOut',
  'expoInOut',

  // Circ family
  'circIn',
  'circOut',
  'circInOut',

  // Back family (overshooting)
  'backIn',
  'backOut',
  'backInOut',

  // Anticipate
  'anticipate',

  // Elastic
  'elastic',

  // Bounce
  'bounce',

  // Factories
  'power',
  'cubicBezier',
  'steps',
]);

describe('@labpics/motion/easing api surface pin — NE6', () => {
  it('exports exactly the contracted names — no more, no less (NE6)', () => {
    const exported = new Set(Object.keys(easingModule));

    const missing = [...EXPECTED_EASING_EXPORTS].filter((name) => !exported.has(name));
    const extra = [...exported].filter((name) => !EXPECTED_EASING_EXPORTS.has(name));

    expect(
      missing,
      `Missing exports from @labpics/motion/easing: ${missing.join(', ')}`,
    ).toHaveLength(0);

    expect(
      extra,
      `Unexpected (uncontracted) exports in @labpics/motion/easing: ${extra.join(', ')}`,
    ).toHaveLength(0);
  });

  // Individual callable assertions — ensure each is a function (not re-exported value/type)
  it('normalizeEasing is a function', () => {
    expect(typeof easingModule.normalizeEasing).toBe('function');
  });
  it('linear is a function', () => {
    expect(typeof easingModule.linear).toBe('function');
  });
  it('easeIn is a function', () => {
    expect(typeof easingModule.easeIn).toBe('function');
  });
  it('easeOut is a function', () => {
    expect(typeof easingModule.easeOut).toBe('function');
  });
  it('easeInOut is a function', () => {
    expect(typeof easingModule.easeInOut).toBe('function');
  });
  it('sineIn is a function', () => {
    expect(typeof easingModule.sineIn).toBe('function');
  });
  it('sineOut is a function', () => {
    expect(typeof easingModule.sineOut).toBe('function');
  });
  it('sineInOut is a function', () => {
    expect(typeof easingModule.sineInOut).toBe('function');
  });
  it('expoIn is a function', () => {
    expect(typeof easingModule.expoIn).toBe('function');
  });
  it('expoOut is a function', () => {
    expect(typeof easingModule.expoOut).toBe('function');
  });
  it('expoInOut is a function', () => {
    expect(typeof easingModule.expoInOut).toBe('function');
  });
  it('circIn is a function', () => {
    expect(typeof easingModule.circIn).toBe('function');
  });
  it('circOut is a function', () => {
    expect(typeof easingModule.circOut).toBe('function');
  });
  it('circInOut is a function', () => {
    expect(typeof easingModule.circInOut).toBe('function');
  });
  it('backIn is a function', () => {
    expect(typeof easingModule.backIn).toBe('function');
  });
  it('backOut is a function', () => {
    expect(typeof easingModule.backOut).toBe('function');
  });
  it('backInOut is a function', () => {
    expect(typeof easingModule.backInOut).toBe('function');
  });
  it('anticipate is a function', () => {
    expect(typeof easingModule.anticipate).toBe('function');
  });
  it('elastic is a function', () => {
    expect(typeof easingModule.elastic).toBe('function');
  });
  it('bounce is a function', () => {
    expect(typeof easingModule.bounce).toBe('function');
  });
  it('power is a function (factory)', () => {
    expect(typeof easingModule.power).toBe('function');
    // Returns a function when called with valid exponent
    expect(typeof easingModule.power(2)).toBe('function');
  });
  it('cubicBezier is a function (factory)', () => {
    expect(typeof easingModule.cubicBezier).toBe('function');
    // Returns a function when called with valid control points
    expect(typeof easingModule.cubicBezier(0.25, 0.1, 0.25, 1)).toBe('function');
  });
  it('steps is a function (factory)', () => {
    expect(typeof easingModule.steps).toBe('function');
    // Returns a function when called with valid n
    expect(typeof easingModule.steps(4, 'end')).toBe('function');
  });

  // Spot checks: each callable returns a number (smoke, not full NE1)
  it('each easing returns a number for t=0.5', () => {
    const easings: Array<(t: number) => number> = [
      easingModule.linear,
      easingModule.easeIn,
      easingModule.easeOut,
      easingModule.easeInOut,
      easingModule.sineIn,
      easingModule.sineOut,
      easingModule.sineInOut,
      easingModule.expoIn,
      easingModule.expoOut,
      easingModule.expoInOut,
      easingModule.circIn,
      easingModule.circOut,
      easingModule.circInOut,
      easingModule.backIn,
      easingModule.backOut,
      easingModule.backInOut,
      easingModule.anticipate,
      easingModule.elastic,
      easingModule.bounce,
      easingModule.power(3),
      easingModule.cubicBezier(0.25, 0.1, 0.25, 1),
      easingModule.steps(4, 'end'),
    ];
    for (const fn of easings) {
      const v = fn(0.5);
      expect(typeof v).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
