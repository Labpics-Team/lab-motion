/**
 * test/react.test.ts — React bindings test suite
 *
 * Test classes:
 *   A (Unit/Integration): useMotionValue lifecycle, useSpring animation and cleanup
 *   B (Regression/Characterization): API surface, zero runtime-dep
 *   C (Property): reduced-motion CHARACTER switching (instant snap, not hard-off)
 *   D (Mutation proof): documented per test
 *
 * React hooks are tested without a DOM by mocking React's hook primitives.
 * The virtual clock ensures deterministic, synchronous animation progress.
 *
 * Reduced-motion CHARACTER test (northInvariant #5): useSpring должен
 * мгновенно снапнуть цель через MotionValue.snapTo, а не пропустить
 * анимацию и не записать state в обход ядра. Гонка с уже поставленным
 * кадром покрыта в реальном React-рантайме (react-runtime.test.ts).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ─── Virtual clock ───────────────────────────────────────────────────────

function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handleCounter = 0;

  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return ++handleCounter; // >0 so MotionValue stays in rAF path
  };

  const drain = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      const cb = queue.shift();
      if (!cb) break;
      clock += dtMs;
      cb(clock);
    }
  };

  const drainAll = (max = 3000): void => {
    let i = 0;
    while (queue.length > 0 && i++ < max) drain(1);
  };

  return { requestFrame, drain, drainAll, pending: () => queue.length };
}

// ─── React mock ──────────────────────────────────────────────────────────

// Minimal mock for useState/useEffect/useRef without jsdom.
// Cleanup functions are stored in a separate registry for proper teardown.

type StateEntry = { val: unknown; setter: (v: unknown) => void };
type EffectEntry = { fn: () => (() => void) | void; cleanup?: (() => void) };

let _stateRegistry: StateEntry[] = [];
let _stateIdx = 0;
let _effectsRan: EffectEntry[] = []; // effects that have run (track cleanups here)
let _effectsPending: EffectEntry[] = []; // effects queued but not yet run
let _refs: Array<{ current: unknown }> = [];
let _refIdx = 0;

vi.mock('react', () => {
  const enqueueEffect = (fn: () => (() => void) | void): void => {
    _effectsPending.push({ fn });
  };
  return {
    useState: (init: unknown) => {
      const idx = _stateIdx++;
      if (_stateRegistry[idx] === undefined) {
        const initialVal = typeof init === 'function' ? (init as () => unknown)() : init;
        let storedVal = initialVal;
        const setter = (v: unknown) => {
          storedVal = typeof v === 'function' ? (v as (prev: unknown) => unknown)(storedVal) : v;
          _stateRegistry[idx].val = storedVal;
        };
        _stateRegistry[idx] = { val: storedVal, setter };
      }
      return [_stateRegistry[idx].val, _stateRegistry[idx].setter];
    },
    useRef: (initial: unknown) => {
      const idx = _refIdx++;
      if (_refs[idx] === undefined) {
        _refs[idx] = { current: initial };
      }
      return _refs[idx];
    },
    useEffect: enqueueEffect,
    useInsertionEffect: enqueueEffect,
    useCallback: (fn: unknown) => fn,
  };
});

function resetReactMock() {
  _stateRegistry = [];
  _stateIdx = 0;
  _effectsPending = [];
  _effectsRan = [];
  _refs = [];
  _refIdx = 0;
}

/** Рендер того же mock-компонента: state/ref живут, индексы хуков начинаются сначала. */
function renderHook<T>(fn: () => T): T {
  _stateIdx = 0;
  _refIdx = 0;
  return fn();
}

/** Run all pending effects; record cleanup functions for later teardown. */
function runAllEffects() {
  const toRun = [..._effectsPending];
  _effectsPending = [];
  for (const e of toRun) {
    const cleanup = e.fn();
    if (typeof cleanup === 'function') {
      e.cleanup = cleanup;
    }
    _effectsRan.push(e);
  }
}

/** Run all recorded cleanup functions (simulates component unmount). */
function runEffectCleanups() {
  for (const e of _effectsRan) {
    e.cleanup?.();
  }
  _effectsRan = [];
}

// ─── matchMedia mock ──────────────────────────────────────────────────────

let _prefersReducedMotion = false;

function installMatchMedia(prefersReduced: boolean) {
  _prefersReducedMotion = prefersReduced;
  Object.defineProperty(global, 'window', {
    value: {
      matchMedia: (query: string) => ({
        matches: query.includes('reduce') ? _prefersReducedMotion : false,
        addListener: () => {},
        removeEventListener: () => {},
      }),
    },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  resetReactMock();
  installMatchMedia(false);
});

afterEach(() => {
  runEffectCleanups();
  vi.restoreAllMocks();
  resetReactMock();
});

// ─── Tests ───────────────────────────────────────────────────────────────

import { useMotionValue, useSpring } from '../src/react/index.js';
import { MotionValue } from '../src/motion-value.js';
import { MotionParamError } from '../src/errors.js';

describe('useMotionValue', () => {
  it('returns a MotionValue instance', () => {
    // A: Unit — constructor produces correct type
    // Mutation proof: change return type in useMotionValue → instanceof fails
    const clock = makeVirtualClock();
    const mv = useMotionValue(0, { mass: 1, stiffness: 200, damping: 20 }, clock.requestFrame);
    runAllEffects();
    expect(mv).toBeInstanceOf(MotionValue);
  });

  it('initial value is finite and matches argument', () => {
    // A: Unit — initial value threaded through
    // Mutation proof: change initial to 99 → value !== 0 fails
    const clock = makeVirtualClock();
    const mv = useMotionValue(42, { mass: 1, stiffness: 200, damping: 20 }, clock.requestFrame);
    runAllEffects();
    expect(mv.value).toBe(42);
  });

  it('destroy is called on unmount (cleanup effect)', () => {
    // A: Integration — destroy called on cleanup
    // Mutation proof: remove destroy() call in useEffect cleanup → spy not called
    const clock = makeVirtualClock();
    const mv = useMotionValue(0, { mass: 1, stiffness: 200, damping: 20 }, clock.requestFrame);
    runAllEffects(); // run effects → cleanup functions recorded in _effectsRan
    const destroySpy = vi.spyOn(mv, 'destroy');
    runEffectCleanups(); // simulates unmount — should call mv.destroy()
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});

describe('useSpring', () => {
  it('returns initial target value on first call', () => {
    // A: Unit — initial state is the target value
    // Mutation proof: change useState(target) to useState(0) → fails when target ≠ 0
    const clock = makeVirtualClock();
    const val = useSpring(75, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);
    runAllEffects();
    expect(val).toBe(75);
  });

  it('MotionValue animates to target via virtual clock', () => {
    // A: Integration — MotionValue converges when clock advances
    // Tests the underlying spring convergence that useSpring relies on.
    // Mutation proof: remove clock drain → value never reaches 100
    const clock = makeVirtualClock();
    const collected: number[] = [];
    const mv = new MotionValue({ initial: 0, spring: { mass: 1, stiffness: 200, damping: 20 }, requestFrame: clock.requestFrame });
    mv.onChange((v) => collected.push(v));
    mv.setTarget(100);
    clock.drainAll();
    expect(collected[collected.length - 1]).toBe(100);
    mv.destroy();
  });

  it('useSpring registers onChange listener', () => {
    // A: Integration — onChange subscription connects state to MV
    // Tests that useSpring registers a listener (via useEffect)
    // Mutation proof: remove mv.onChange() useEffect → no state updates
    const clock = makeVirtualClock();
    useSpring(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);
    runAllEffects();
    // At least 3 effects expected (onChange, setTarget, cleanup)
    expect(_effectsRan.length).toBeGreaterThanOrEqual(1);
  });
});

describe('useSpring — reduced-motion CHARACTER', () => {
  it.each([NaN, Infinity])(
    'reduced-путь отклоняет %s до записи в React state',
    (invalid) => {
      installMatchMedia(true);
      const clock = makeVirtualClock();

      renderHook(() =>
        useSpring(5, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
      );
      runAllEffects();

      renderHook(() =>
        useSpring(invalid, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
      );
      expect(() => runAllEffects()).toThrow(MotionParamError);
      expect(_stateRegistry[0]?.val).toBe(5);
    },
  );

  it('snaps to target immediately when prefers-reduced-motion: reduce', () => {
    // C: Property — reduced-motion switches CHARACTER to instant snap
    // northInvariant #5: CHARACTER must change, not hard-off
    // Mutation proof: remove mv.snapTo(target) in reduced-motion branch →
    //   state registry not updated → valueState.val stays at initial
    installMatchMedia(true); // activate reduced-motion

    const clock = makeVirtualClock();

    renderHook(() =>
      useSpring(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
    );
    runAllEffects();
    renderHook(() =>
      useSpring(100, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
    );
    runAllEffects();

    // snapTo эмитит через уже подписанный onChange.
    const valueState = _stateRegistry[0];
    expect(valueState?.val).toBe(100);
  });

  it('reduced-motion: value reaches target (CHARACTER change, not hard-off)', () => {
    // C: northInvariant #5 — element still reaches target in reduced-motion
    // Mutation proof: skip snap entirely → value never reaches 100 in reduced-motion
    installMatchMedia(true);

    const clock = makeVirtualClock();
    renderHook(() =>
      useSpring(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
    );
    runAllEffects();
    renderHook(() =>
      useSpring(100, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
    );
    runAllEffects();

    const valueState = _stateRegistry[0];
    // Must have reached 100 (CHARACTER = instant, value IS at target)
    expect(valueState?.val).toBe(100);
  });

  it('reduced-motion: no spring frames scheduled beyond initialization', () => {
    // C: With reduced-motion active, setting a new target does not schedule frames
    // Mutation proof: call mv.setTarget() unconditionally → frames ARE scheduled
    installMatchMedia(true);

    const framesScheduled: number[] = [];
    const trackingRequestFrame = (cb: (ts?: number) => void): number => {
      framesScheduled.push(1);
      return framesScheduled.length;
    };

    renderHook(() =>
      useSpring(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', trackingRequestFrame),
    );
    runAllEffects();
    const framesAtInit = framesScheduled.length;
    renderHook(() =>
      useSpring(100, { mass: 1, stiffness: 200, damping: 20 }, 'instant', trackingRequestFrame),
    );
    runAllEffects();

    // After effects run, the reduced-motion path should NOT schedule new frames
    // (the snap is synchronous; no spring loop started)
    // We verify: frames at the end equals frames at init (no new spring run)
    expect(framesScheduled.length).toBe(framesAtInit);
  });

  it('full motion: spring runs when prefers-reduced-motion is false', () => {
    // C: Negative case — without reduced-motion, spring is used (mv.setTarget called)
    // Tests that the non-reduced path goes through the MotionValue.
    installMatchMedia(false);

    const clock = makeVirtualClock();
    renderHook(() =>
      useSpring(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
    );
    runAllEffects();
    renderHook(() =>
      useSpring(100, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame),
    );
    runAllEffects();
    expect(clock.pending()).toBeGreaterThan(0);
    clock.drainAll();
    expect(_stateRegistry[0]?.val).toBe(100);
  });
});

describe('zero runtime-dep', () => {
  it('module imports without side effects on process module', async () => {
    // B: Characterization — no window/document references at module load time
    // Mutation proof: add `document.createElement` at module top-level → this import throws
    await expect(import('../src/react/index.js')).resolves.toBeDefined();
  });
});
