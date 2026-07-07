/**
 * utils-api-surface-pin.test.ts — contract
 * Class: contract (invariant 6 — feature completeness for ./utils subpath)
 *
 * Pins the EXACT set of runtime exports from the ./utils subpath.
 * Any addition or removal of an export name fails CI immediately.
 *
 * NO descoping: every name in the enumerated set must exist.
 * Extra unlisted names are also a failure (undocumented API surface leak).
 *
 * Mutation proof:
 *   Delete `export function clamp` from src/utils/index.ts:
 *   → `missing` contains 'clamp' → RED.
 *   Add an undocumented export `_lerp`:
 *   → `extra` contains '_lerp' → RED.
 *   Rename `mapRange` to `remap`:
 *   → missing 'mapRange', extra 'remap' → RED.
 *
 * RED proof (before implementation):
 *   The module does not exist yet → import fails → whole file RED.
 */

import { describe, expect, it } from 'vitest';
import * as utils from '../src/utils/index.js';

/** The EXACT contracted runtime export set for @labpics/motion/utils. */
const EXPECTED_UTILS_EXPORTS = new Set([
  'clamp',
  'mix',
  'wrap',
  'snap',
  'mapRange',
  'interpolate',
  'pipe',
]);

describe('@labpics/motion/utils api surface pin', () => {
  it('exports exactly the contracted names — no more, no less', () => {
    const exported = new Set(Object.keys(utils));

    const missing = [...EXPECTED_UTILS_EXPORTS].filter((name) => !exported.has(name));
    const extra = [...exported].filter((name) => !EXPECTED_UTILS_EXPORTS.has(name));

    expect(missing, `Missing exports from @labpics/motion/utils: ${missing.join(', ')}`).toHaveLength(0);
    expect(extra, `Unexpected (uncontracted) exports in @labpics/motion/utils: ${extra.join(', ')}`).toHaveLength(0);
  });

  // Anti-theater: every contracted name must be a callable function.
  it('clamp is a function', () => expect(typeof utils.clamp).toBe('function'));
  it('mix is a function', () => expect(typeof utils.mix).toBe('function'));
  it('wrap is a function', () => expect(typeof utils.wrap).toBe('function'));
  it('snap is a function', () => expect(typeof utils.snap).toBe('function'));
  it('mapRange is a function', () => expect(typeof utils.mapRange).toBe('function'));
  it('interpolate is a function', () => expect(typeof utils.interpolate).toBe('function'));
  it('pipe is a function', () => expect(typeof utils.pipe).toBe('function'));

  // Curried factories return functions when the trailing value is omitted.
  it('clamp(min,max) returns a mapper function (curry branch)', () => {
    expect(typeof utils.clamp(0, 1)).toBe('function');
  });
  it('wrap(min,max) returns a mapper function (curry branch)', () => {
    expect(typeof utils.wrap(0, 1)).toBe('function');
  });
  it('snap(increment) returns a mapper function (curry branch)', () => {
    expect(typeof utils.snap(10)).toBe('function');
  });
  it('snap(targets[]) returns a mapper function (curry branch)', () => {
    expect(typeof utils.snap([0, 1])).toBe('function');
  });
  it('mapRange(...4 bounds) returns a mapper function (curry branch)', () => {
    expect(typeof utils.mapRange(0, 1, 0, 1)).toBe('function');
  });
  it('interpolate(input,output) returns a mapper function (factory)', () => {
    expect(typeof utils.interpolate([0, 1], [0, 1])).toBe('function');
  });
  it('pipe(...fns) returns a function', () => {
    expect(typeof utils.pipe((x: number) => x)).toBe('function');
  });

  // Type-only names MUST NOT leak as runtime values.
  it('type-only names are erased (Mixer / EasingFunction / InterpolateOptions absent)', () => {
    const exported = new Set(Object.keys(utils));
    expect(exported.has('Mixer')).toBe(false);
    expect(exported.has('EasingFunction')).toBe(false);
    expect(exported.has('InterpolateOptions')).toBe(false);
  });
});
