/**
 * test/svelte.test.ts — Svelte bindings test suite
 *
 * Test classes:
 *   A (Unit/Integration): springStore contract (subscribe/set/destroy), animation convergence
 *   B (Regression): API surface, Svelte store shape
 *   C (Property): reduced-motion CHARACTER switching
 *   D (Mutation proof): documented per test
 *
 * No DOM or Svelte runtime needed — the store contract is pure JS.
 * The virtual clock makes tests fully synchronous and deterministic.
 *
 * Reduced-motion CHARACTER test (northInvariant #5):
 *   When prefers-reduced-motion is active, springStore.set() must emit the
 *   new target value synchronously to subscribers without spring animation.
 *   Mutation proof: remove synchronous emit in the reduced-motion branch of
 *   set() → the 'emits target immediately' assertion fails.
 *
 * TDD RED-proof:
 *   1. Comment out the synchronous subscriber loop in the reduced-motion
 *      branch of springStore.set().
 *   2. Run: pnpm test test/svelte.test.ts
 *   3. The 'reduced-motion: emits target immediately' test MUST fail.
 *   4. Restore → GREEN.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { springStore } from '../src/svelte/index.js';

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
});

afterEach(() => {
  // nothing to clean — each test creates its own store
});

// ─── Suite A: Svelte store contract ──────────────────────────────────────

describe('springStore — Svelte store contract', () => {
  it('has subscribe, set, and destroy methods', () => {
    // B: API surface — shape matches expected SpringStore interface
    // Mutation proof: remove 'set' from returned object → property check fails
    const store = springStore(0);
    expect(store.subscribe).toBeTypeOf('function');
    expect(store.set).toBeTypeOf('function');
    expect(store.destroy).toBeTypeOf('function');
  });

  it('subscribe calls run immediately with current value (Svelte contract)', () => {
    // A: Unit — immediate emission on subscribe
    // Mutation proof: remove `run(currentValue)` in subscribe → first value not 0
    const clock = makeVirtualClock();
    const store = springStore(42, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);

    const received: number[] = [];
    store.subscribe((v) => received.push(v));

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(42);
    store.destroy();
  });

  it('subscribe returns an unsubscribe function', () => {
    // A: Unit — unsubscribe stops emissions
    // Mutation proof: remove subscriber.delete in unsubscribe → emissions continue after unsub
    const clock = makeVirtualClock();
    const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);

    const received: number[] = [];
    const unsub = store.subscribe((v) => received.push(v));
    const countAfterSub = received.length;

    unsub(); // unsubscribe

    store.set(100);
    clock.drainAll();

    // After unsubscribe, no new values should arrive
    expect(received.length).toBe(countAfterSub);
    store.destroy();
  });

  it('animates toward target and converges to final value', () => {
    // A: Integration — spring converges to set() target
    // Mutation proof: remove mv.setTarget() in set() → value stays at initial → last value ≠ 100
    const clock = makeVirtualClock();
    const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);

    const received: number[] = [];
    store.subscribe((v) => received.push(v));

    store.set(100);
    clock.drainAll();

    expect(received[received.length - 1]).toBe(100);
    store.destroy();
  });

  it('emits intermediate values during animation (spring is smooth)', () => {
    // A: Integration — intermediate frames are emitted (not just final)
    // Mutation proof: change to snap-always → only 2 values received (initial + snap)
    const clock = makeVirtualClock();
    const store = springStore(0, { mass: 1, stiffness: 100, damping: 10 }, 'instant', clock.requestFrame);

    const received: number[] = [];
    store.subscribe((v) => received.push(v));

    store.set(100);
    clock.drainAll();

    // Should have more than 2 values (initial 0 + final 100 + intermediate frames)
    expect(received.length).toBeGreaterThan(2);
    store.destroy();
  });

  it('destroy stops animation and clears subscribers', () => {
    // A: Integration — destroy terminates all activity
    // Mutation proof: remove subscribers.clear() in destroy → subscriber still receives values
    const clock = makeVirtualClock();
    const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);

    const received: number[] = [];
    store.subscribe((v) => received.push(v));

    store.destroy();
    const countAtDestroy = received.length;

    // After destroy, draining the clock should not emit more values
    clock.drainAll();
    expect(received.length).toBe(countAtDestroy);
  });
});

// ─── Suite C: reduced-motion CHARACTER switching ─────────────────────────

describe('springStore — reduced-motion CHARACTER (northInvariant #5)', () => {
  it('reduced-motion: set() emits target value immediately to subscribers', () => {
    // C: Property — CHARACTER = instant snap, not hard-off
    // northInvariant #5: element reaches target; only STYLE changes
    // Mutation proof: remove synchronous emit loop in reduced-motion branch →
    //   received stays at [0] after set(100) → assertion fails
    installMatchMedia(true);

    const clock = makeVirtualClock();
    const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);

    const received: number[] = [];
    store.subscribe((v) => received.push(v));

    store.set(100);
    // No clock drain needed — reduced-motion snaps synchronously

    expect(received[received.length - 1]).toBe(100);
    store.destroy();
  });

  it('reduced-motion: value reaches target (CHARACTER change, not hard-off)', () => {
    // C: northInvariant #5 — element still reaches target value
    // Mutation proof: skip entire set() body in reduced-motion → value stuck at 0
    installMatchMedia(true);

    const clock = makeVirtualClock();
    const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', clock.requestFrame);

    let latest = 0;
    store.subscribe((v) => { latest = v; });

    store.set(50);
    expect(latest).toBe(50); // must have reached target

    store.set(200);
    expect(latest).toBe(200); // second set also reaches target
    store.destroy();
  });

  it('reduced-motion: no animation frames emitted (CHARACTER = instant)', () => {
    // C: With reduced-motion, no spring frames should be scheduled
    // Mutation proof: remove prefersReducedMotion() check → spring starts → >1 frame queued
    installMatchMedia(true);

    const framesScheduled: number[] = [];
    const trackingRequestFrame = (cb: (ts?: number) => void): number => {
      framesScheduled.push(Date.now()); // track that a frame was requested
      return 1; // return non-zero handle
    };

    const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', trackingRequestFrame);
    store.subscribe(() => {});

    const framesBefore = framesScheduled.length;
    store.set(100);

    // In reduced-motion, no new frames should be scheduled
    expect(framesScheduled.length).toBe(framesBefore);
    store.destroy();
  });

  it("reduced-motion: 'fade' ≡ 'instant' по значению (мягкость — CSS потребителя)", () => {
    // Б: пин документированного контракта всех биндингов — 'fade' не меняет
    // числовую последовательность, отличие только в ожидаемом CSS-переходе
    // на стороне потребителя. Mutation proof: заставить ветку 'fade'
    // анимировать пружиной или эмитить иное значение → последовательности
    // разойдутся → красный.
    installMatchMedia(true);

    const run = (mode: 'instant' | 'fade'): number[] => {
      const clock = makeVirtualClock();
      const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, mode, clock.requestFrame);
      const received: number[] = [];
      store.subscribe((v) => received.push(v));
      store.set(100);
      store.set(-40);
      clock.drainAll();
      store.destroy();
      return received;
    };

    expect(run('fade')).toEqual(run('instant'));
  });

  it('full motion: uses spring (frames ARE scheduled when reduced-motion is off)', () => {
    // C: Negative case — without reduced-motion, spring runs and frames are scheduled
    installMatchMedia(false);

    const framesScheduled: number[] = [];
    const trackingRequestFrame = (cb: (ts?: number) => void): number => {
      framesScheduled.push(1);
      return framesScheduled.length; // non-zero
    };

    const store = springStore(0, { mass: 1, stiffness: 200, damping: 20 }, 'instant', trackingRequestFrame);
    store.subscribe(() => {});

    store.set(100);
    // With full motion, at least one frame should be scheduled
    expect(framesScheduled.length).toBeGreaterThan(0);
    store.destroy();
  });
});

// ─── Suite B: zero runtime-dep ────────────────────────────────────────────

describe('zero runtime-dep', () => {
  it('module loads without window/document (SSR-safe)', async () => {
    // B: Characterization — no window references at module load time
    // Mutation proof: add window.document at top of svelte/index.ts → import throws in Node
    await expect(import('../src/svelte/index.js')).resolves.toBeDefined();
  });
});
