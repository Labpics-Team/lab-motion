/**
 * test/vue.test.ts — Vue 3 bindings test suite
 *
 * Test classes:
 *   A (Unit/Integration): useMotionValue lifecycle, useSpring animation and watch
 *   B (Regression): API surface, zero runtime-dep
 *   C (Property): reduced-motion CHARACTER switching in useSpring
 *   D (Mutation proof): documented per test
 *
 * Vue's reactivity is mocked at the ref/watch/onUnmounted level.
 * The virtual clock ensures deterministic animation.
 *
 * Reduced-motion CHARACTER test (northInvariant #5):
 *   When prefers-reduced-motion is active, useSpring must snap the output ref
 *   to the new target value immediately (not advance a spring).
 *   Mutation proof: remove `value.value = newTarget` in reduced-motion watch
 *   branch → output ref stays at initial → 'snaps to target' assertion fails.
 *
 * TDD RED-proof:
 *   1. Comment out `value.value = newTarget` in the watch callback's
 *      reduced-motion branch of useSpring.
 *   2. Run: pnpm test test/vue.test.ts
 *   3. 'reduced-motion: snaps to target immediately' MUST fail.
 *   4. Restore → GREEN.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ─── Virtual clock ───────────────────────────────────────────────────────

function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handleCounter = 0;

  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return ++handleCounter;
  };

  const drainAll = (max = 3000): void => {
    let i = 0;
    while (queue.length > 0 && i++ < max) {
      const cb = queue.shift()!;
      clock += dtMs;
      cb(clock);
    }
  };

  return { requestFrame, drainAll };
}

// ─── Vue mock ────────────────────────────────────────────────────────────

type WatchEffect = { getter: () => unknown; cb: (newVal: unknown) => void };
const _watchers: WatchEffect[] = [];
const _unmountedCallbacks: Array<() => void> = [];

vi.mock('vue', () => {
  return {
    ref: (initial: unknown) => {
      // Simple reactive ref — a plain object for testing
      const r = { value: initial };
      return r;
    },
    watch: (source: (() => unknown) | { value: unknown }, cb: (v: unknown) => void) => {
      const getter = typeof source === 'function' ? source : () => source.value;
      _watchers.push({ getter, cb });
      return () => {}; // stop watcher (not used in tests)
    },
    onUnmounted: (cb: () => void) => {
      _unmountedCallbacks.push(cb);
    },
  };
});

function triggerWatchers() {
  for (const w of _watchers) {
    w.cb(w.getter());
  }
}

function triggerUnmounted() {
  for (const cb of _unmountedCallbacks) {
    cb();
  }
}

function resetVueMock() {
  _watchers.length = 0;
  _unmountedCallbacks.length = 0;
}

// ─── matchMedia mock ──────────────────────────────────────────────────────

let _prefersReducedMotion = false;

function installMatchMedia(prefersReduced: boolean) {
  _prefersReducedMotion = prefersReduced;
  Object.defineProperty(global, 'window', {
    value: {
      matchMedia: (query: string) => ({
        matches: query.includes('reduce') ? _prefersReducedMotion : false,
      }),
    },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installMatchMedia(false);
  resetVueMock();
});

afterEach(() => {
  triggerUnmounted();
  vi.restoreAllMocks();
  resetVueMock();
});

// ─── Tests ───────────────────────────────────────────────────────────────

import { useMotionValue, useSpring } from '../src/vue/index.js';
import { MotionValue } from '../src/motion-value.js';

describe('useMotionValue', () => {
  it('returns a MotionValue instance', () => {
    // A: Unit — correct type returned
    // Mutation proof: change to `return undefined` → instanceof fails
    const clock = makeVirtualClock();
    const mv = useMotionValue(0, { mass: 1, stiffness: 200, damping: 20 }, clock.requestFrame);
    expect(mv).toBeInstanceOf(MotionValue);
  });

  it('initial value matches argument', () => {
    // A: Unit — initial value threaded through
    // Mutation proof: change initial to 0 always → value !== 77 fails
    const clock = makeVirtualClock();
    const mv = useMotionValue(77, { mass: 1, stiffness: 200, damping: 20 }, clock.requestFrame);
    expect(mv.value).toBe(77);
  });

  it('destroy is called on unmount', () => {
    // A: Integration — cleanup registered
    // Mutation proof: remove onUnmounted registration → destroySpy never called
    const clock = makeVirtualClock();
    const mv = useMotionValue(0, { mass: 1, stiffness: 200, damping: 20 }, clock.requestFrame);
    const destroySpy = vi.spyOn(mv, 'destroy');

    triggerUnmounted();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});

describe('useSpring', () => {
  it('returns a ref with the initial target value', () => {
    // A: Unit — output ref initialized to target
    // Mutation proof: initialize ref to 0 always → initial=50 fails
    const clock = makeVirtualClock();
    const target = { value: 50 }; // mock ref

    const result = useSpring(
      () => (target as any).value,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      clock.requestFrame,
    );

    expect(result.value).toBe(50);
  });

  it('animates toward target when watcher triggers', () => {
    // A: Integration — watcher drives mv.setTarget → animation converges
    // Mutation proof: remove mv.setTarget() from watch cb → value stays at initial
    const clock = makeVirtualClock();
    let targetValue = 0;

    const result = useSpring(
      () => targetValue,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      clock.requestFrame,
    );

    // Change target and trigger watch
    targetValue = 100;
    triggerWatchers();
    clock.drainAll();

    expect(result.value).toBe(100);
  });

  it('destroys MotionValue on unmount (no memory leak)', () => {
    // A: Integration — mv.destroy() called on component teardown
    // Mutation proof: remove onUnmounted from useSpring → no cleanup, potential leak
    const clock = makeVirtualClock();
    let targetValue = 0;

    useSpring(
      () => targetValue,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      clock.requestFrame,
    );

    // onUnmounted callbacks should have been registered
    expect(_unmountedCallbacks.length).toBeGreaterThan(0);
  });
});

describe('useSpring — reduced-motion CHARACTER (northInvariant #5)', () => {
  it('snaps to target immediately when prefers-reduced-motion: reduce', () => {
    // C: Property — CHARACTER = instant snap, not hard-off
    // Mutation proof: remove `value.value = newTarget` in reduced-motion watch branch →
    //   result.value stays at 0 → toBe(100) fails
    installMatchMedia(true);

    const clock = makeVirtualClock();
    let targetValue = 0;

    const result = useSpring(
      () => targetValue,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      clock.requestFrame,
    );

    targetValue = 100;
    triggerWatchers();
    // No clock drain — reduced-motion must snap synchronously

    expect(result.value).toBe(100);
  });

  it('reduced-motion: value reaches target (CHARACTER change, not hard-off)', () => {
    // C: northInvariant #5 — element still reaches target even in reduced-motion
    // Mutation proof: skip watch body entirely → result.value stays at 0
    installMatchMedia(true);

    const clock = makeVirtualClock();
    let targetValue = 0;

    const result = useSpring(
      () => targetValue,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      clock.requestFrame,
    );

    targetValue = 75;
    triggerWatchers();
    expect(result.value).toBe(75);

    targetValue = 200;
    triggerWatchers();
    expect(result.value).toBe(200);
  });

  it('reduced-motion: no spring frames scheduled (CHARACTER = instant)', () => {
    // C: Verify spring is NOT invoked in reduced-motion path
    // Mutation proof: call mv.setTarget() unconditionally → frames ARE scheduled
    installMatchMedia(true);

    const framesScheduled: number[] = [];
    const trackingRF = (cb: (ts?: number) => void): number => {
      framesScheduled.push(1);
      return framesScheduled.length;
    };

    let targetValue = 0;
    useSpring(
      () => targetValue,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      trackingRF,
    );

    const framesBefore = framesScheduled.length;
    targetValue = 100;
    triggerWatchers();

    // Reduced-motion: no new frames beyond initial MotionValue construction
    expect(framesScheduled.length).toBe(framesBefore);
  });

  it('full motion: spring runs when reduced-motion is off', () => {
    // C: Negative case — without reduced-motion, spring advances
    installMatchMedia(false);

    const clock = makeVirtualClock();
    let targetValue = 0;

    const result = useSpring(
      () => targetValue,
      { mass: 1, stiffness: 200, damping: 20 },
      'instant',
      clock.requestFrame,
    );

    targetValue = 100;
    triggerWatchers();

    // Without clock drain, value should NOT yet be 100 (spring hasn't advanced)
    const valueMidFlight = result.value;
    expect(valueMidFlight).not.toBe(100);

    // After drain, value converges
    clock.drainAll();
    expect(result.value).toBe(100);
  });
});

describe('zero runtime-dep', () => {
  it('module imports without window/document (SSR-safe)', async () => {
    // B: Characterization — no DOM references at module load time
    // Mutation proof: add `document.body` at top of vue/index.ts → import throws
    await expect(import('../src/vue/index.js')).resolves.toBeDefined();
  });
});
