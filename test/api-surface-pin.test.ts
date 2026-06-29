import { describe, expect, it } from 'vitest';
import * as motionModule from '../src/index.js';

/**
 * Test: public API surface pin
 * Class: contract
 * Invariant 6 — exact set of exported names asserted; add/remove/rename fails CI.
 *
 * This is a CHARACTERIZATION / PIN test for the PLANNED API surface.
 * The test is deliberately RED at birth because the current placeholder only
 * exports `PACKAGE_NAME` — not the motion engine exports.
 *
 * RED proof (current):
 *   The `expect(exported).toContain('spring')` etc. assertions fail because
 *   src/index.ts only exports `PACKAGE_NAME`. RED for the right reason.
 *
 * Mutation proof (for when implemented — how="mutation"):
 *   Delete the `export { tween }` line from src/index.ts:
 *   → The `toContain('tween')` assertion fails → CI fails.
 *   Rename `MotionParamError` to `MotionError`:
 *   → The `toContain('MotionParamError')` assertion fails → CI fails.
 *   Add an undocumented export `internalHelper`:
 *   → The exact-set `toEqual` assertion fails → CI fails.
 *
 * The exact set below is the PLANNED public API. It is RED until the
 * implementation ships all four names.
 */

const EXPECTED_EXPORTS = new Set([
  'spring',
  'tween',
  'MotionParamError',
  'drive',
  // Exported so callers can validate spring params eagerly before calling drive().
  // Also closes Finding 1: boundary validation is now the single canonical site.
  'validateSpringParams',
  // ch02-s1: headless reactive value (spring + smooth velocity pickup on retarget).
  // RequestFrameFn and MotionValueOptions are type-only exports (erased at runtime).
  'MotionValue',
]);

describe('public API surface pin (invariant 6)', () => {
  it('exports exactly the contracted names — no more, no less', () => {
    const exported = new Set(Object.keys(motionModule));

    // Every contracted name must be present.
    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Missing exports: ${missing.join(', ')}`).toHaveLength(0);

    // No uncontracted names may be added silently.
    // (Remove PACKAGE_NAME if the placeholder still re-exports it — it is not
    // part of the public motion engine contract.)
    const extra = [...exported].filter(
      (name) => !EXPECTED_EXPORTS.has(name) && name !== 'PACKAGE_NAME',
    );
    expect(extra, `Unexpected new exports: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('spring is a function', () => {
    expect(typeof motionModule.spring).toBe('function');
  });

  it('tween is a function', () => {
    expect(typeof motionModule.tween).toBe('function');
  });

  it('drive is a function', () => {
    expect(typeof motionModule.drive).toBe('function');
  });

  it('MotionParamError is a constructor (class)', () => {
    expect(typeof motionModule.MotionParamError).toBe('function');
    // Must be instantiable.
    expect(() => new motionModule.MotionParamError('test')).not.toThrow();
  });

  it('validateSpringParams is a function', () => {
    expect(typeof motionModule.validateSpringParams).toBe('function');
  });
});
