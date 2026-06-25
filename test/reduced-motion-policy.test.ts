import { describe, expect, it, vi } from 'vitest';
import { drive } from '../src/index.js';

/**
 * Test: reduced-motion policy both states + node
 * Class: unit
 * Invariant 4 — reduced-motion honoured at the API boundary, always.
 *
 * Strategy: inject a fake `matchMedia` into the drive() call so the test is
 * hermetic — no real browser globals required, no DOM, SSR-safe.
 *
 * The `drive()` API accepts an options object with an injected `matchMedia`
 * factory so tests can control the policy without touching globals.
 *
 * RED proof:
 *   `drive` is not exported from the placeholder. Import gives undefined →
 *   calling it throws TypeError → RED for the right reason.
 *
 * Mutation proof (for when implemented):
 *   Remove the matchMedia check in the driver → the reduce=true test fails
 *   because the driver runs the full loop instead of short-circuiting.
 *   Or hard-code `reduce = false` → both injection tests fail.
 */

/** Minimal matchMedia stub that returns a fixed `matches` value. */
function stubMatchMedia(matches: boolean): (query: string) => MediaQueryList {
  return (_query: string): MediaQueryList => ({
    matches,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

describe('reduced-motion policy (invariant 4)', () => {
  it('resolve to final value immediately when matchMedia reports prefers-reduced-motion: reduce', async () => {
    const solverSpy = vi.fn();

    await drive({
      from: 0,
      to: 100,
      matchMedia: stubMatchMedia(true), // prefers-reduced-motion: reduce
      onStep: solverSpy,
      spring: { mass: 1, stiffness: 100, damping: 10 },
    });

    // With reduce active, we expect 0 or 1 step call (final value, no loop).
    // The solver loop must NOT be entered for multiple frames.
    expect(solverSpy.mock.calls.length).toBeLessThanOrEqual(1);

    // The only call (if any) must deliver the final `to` value.
    if (solverSpy.mock.calls.length === 1) {
      const [value] = solverSpy.mock.calls[0] as [number];
      expect(value).toBe(100);
    }
  });

  it('enters multi-frame animation when matchMedia reports no preference (matches=false)', async () => {
    const stepValues: number[] = [];

    // Use a non-draining step clock (returns 0 without invoking its callback).
    // The driver detects handle=0 at the bootstrap and switches to a setTimeout(0)
    // fallback, which runs the animation to completion autonomously.
    const stepClock = (_cb: () => void): number => 0;

    // Await the completed animation — the setTimeout fallback resolves it.
    await drive({
      from: 0,
      to: 100,
      matchMedia: stubMatchMedia(false), // no reduced-motion preference
      onStep: (v) => stepValues.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: stepClock,
    });

    // Key assertion: multi-frame animation was entered (not short-circuited like reduce=true).
    // settle() emits the final `to` value; intermediate frames emit intermediate values.
    // At minimum 2 steps: at least one intermediate + the final settle() call.
    expect(stepValues.length).toBeGreaterThanOrEqual(2);
  }, 5000);

  it('does NOT throw in node / no-matchMedia environment (SSR fault safety)', () => {
    // Pass matchMedia: undefined — the driver must degrade gracefully (treat as reduce=false,
    // but since we have no requestFrame, the driver must not throw synchronously).
    expect(() => {
      void drive({
        from: 0,
        to: 100,
        matchMedia: undefined,
        onStep: () => {},
        spring: { mass: 1, stiffness: 100, damping: 10 },
        // Also no requestFrame — the driver must return a Promise without throwing.
        requestFrame: (_cb: () => void) => 0,
      });
    }).not.toThrow();
  });
});
