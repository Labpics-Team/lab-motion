import { describe, expect, it } from 'vitest';
import { MotionParamError, spring } from '../src/index.js';

/**
 * Test: invalid-param typed error
 * Class: unit
 * Invariant 2 boundary — no path ever returns NaN; invalid inputs throw MotionParamError.
 *
 * RED proof:
 *   Both `MotionParamError` and `spring` are missing from the placeholder.
 *   Runtime imports both as `undefined`.
 *
 *   ANTI-THEATER defense: vitest's `.toThrow(undefined)` matches ANY thrown error —
 *   meaning calling `undefined()` would pass the toThrow check trivially. To prevent
 *   theater, each test first asserts that `MotionParamError` IS a constructor. That
 *   guard fails with "expected 'undefined' to be 'function'" when the engine is
 *   absent, which is RED for the right reason and blocks the false-positive path.
 *
 * Mutation proof (for when implemented):
 *   Replace the guard with `if (false) throw new MotionParamError(...)` and the
 *   "throws" assertions flip to fail. Or remove the guard entirely and let NaN
 *   propagate — the throw assertions still fail.
 */

/** Anti-theater guard: assert MotionParamError is a real class before every test. */
function assertMotionParamErrorIsClass(): void {
  // If this fails, every test below is theater — calling undefined throws TypeError,
  // and toThrow(undefined) matches any error. This guard makes the file RED first.
  expect(
    typeof MotionParamError,
    'MotionParamError must be a class constructor (engine not shipped yet)',
  ).toBe('function');
}

/** Anti-theater guard: assert spring is a callable function before every test. */
function assertSpringIsFunction(): void {
  expect(typeof spring, 'spring must be a function (engine not shipped yet)').toBe('function');
}

describe('invalid-param typed error (invariant 2 boundary)', () => {
  describe('negative mass', () => {
    it('throws MotionParamError for mass = -1', () => {
      assertMotionParamErrorIsClass();
      assertSpringIsFunction();
      expect(() => spring({ mass: -1, stiffness: 100, damping: 10 }, 0)).toThrow(MotionParamError);
    });

    it('throws MotionParamError for mass = 0', () => {
      assertMotionParamErrorIsClass();
      assertSpringIsFunction();
      expect(() => spring({ mass: 0, stiffness: 100, damping: 10 }, 0)).toThrow(MotionParamError);
    });

    it('throws MotionParamError for mass = -Infinity', () => {
      assertMotionParamErrorIsClass();
      assertSpringIsFunction();
      expect(() =>
        spring({ mass: Number.NEGATIVE_INFINITY, stiffness: 100, damping: 10 }, 0),
      ).toThrow(MotionParamError);
    });
  });

  describe('non-finite stiffness', () => {
    it('throws MotionParamError for stiffness = Infinity', () => {
      assertMotionParamErrorIsClass();
      assertSpringIsFunction();
      expect(() =>
        spring({ mass: 1, stiffness: Number.POSITIVE_INFINITY, damping: 10 }, 0),
      ).toThrow(MotionParamError);
    });

    it('throws MotionParamError for stiffness = NaN', () => {
      assertMotionParamErrorIsClass();
      assertSpringIsFunction();
      expect(() => spring({ mass: 1, stiffness: Number.NaN, damping: 10 }, 0)).toThrow(
        MotionParamError,
      );
    });

    it('throws MotionParamError for stiffness = -Infinity', () => {
      assertMotionParamErrorIsClass();
      assertSpringIsFunction();
      expect(() =>
        spring({ mass: 1, stiffness: Number.NEGATIVE_INFINITY, damping: 10 }, 0),
      ).toThrow(MotionParamError);
    });

    it('throws MotionParamError for stiffness = 0', () => {
      assertMotionParamErrorIsClass();
      assertSpringIsFunction();
      expect(() => spring({ mass: 1, stiffness: 0, damping: 10 }, 0)).toThrow(MotionParamError);
    });
  });

  it('does NOT throw for valid params (positive finite mass + stiffness)', () => {
    assertMotionParamErrorIsClass();
    assertSpringIsFunction();
    expect(() => spring({ mass: 1, stiffness: 100, damping: 10 }, 0)).not.toThrow();
  });

  it('MotionParamError is an instance of Error', () => {
    assertMotionParamErrorIsClass();
    assertSpringIsFunction();
    try {
      spring({ mass: 0, stiffness: 100, damping: 10 }, 0);
      // Should not reach here
      expect.fail('Expected MotionParamError to be thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(MotionParamError);
    }
  });
});
