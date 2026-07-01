/**
 * test/motion-value.test.ts — MotionValue headless core test suite
 *
 * Test classes covered:
 *   A (Unit/Integration): constructor validation, onChange, setTarget, destroy,
 *                         animation correctness
 *   B (Regression/Characterization): API-surface pin, zero-DOM invariant
 *   C (Property/Fuzz): finiteness fuzz 10k+ inputs, bit-exact determinism,
 *                       smooth-pickup velocity continuity
 *   D (Mutation proof): documented RED-proof mutations for each key suite
 *
 * Virtual clock design:
 *   The virtual clock returns a non-zero handle (monotonically incrementing)
 *   so the MotionValue loop stays in the requestFrame path (not the setTimeout
 *   fallback path). The setTimeout fallback path is tested separately with a
 *   genuine non-draining clock (returning 0).
 *
 * Mutation proofs (each test must fail on its stated mutation):
 *   [fuzz]          Remove finiteness guard in springWithV0 → NaN/Infinity →
 *                   fuzz suite non-finite assertion fails.
 *   [determinism]   Change elapsed accumulation between instances → values diverge →
 *                   bit-exact equality assertion fails.
 *   [smooth-pickup] Set v0Normalized=0 on retarget instead of preserving velocity →
 *                   velocity drops to near-zero at retarget → continuity assertion fails.
 *   [zero-DOM]      Add document.createElement at module top-level → Node import throws →
 *                   zero-DOM import test fails.
 */

import { describe, expect, it } from 'vitest';
import { MotionValue, type MotionValueOptions } from '../src/index.js';
import { MotionParamError } from '../src/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Standard spring params used across tests. */
const STD_SPRING: MotionValueOptions['spring'] = { mass: 1, stiffness: 200, damping: 20 };

/**
 * Virtual-time step clock.
 *
 * Returns a NON-ZERO incrementing handle so the MotionValue tick loop uses
 * the requestFrame path (not the setTimeout fallback). Callbacks are queued
 * and executed manually via drain().
 *
 * Design: each requestFrame call enqueues the callback and returns the
 * queue slot index + 1 (>0). drain(n) pops and calls n callbacks, each
 * with a monotonically increasing timestamp.
 */
function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handle = 0;

  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return ++handle; // always > 0: stays in requestFrame path, no setTimeout fallback
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

  return { requestFrame, drain, drainAll, getTime: () => clock, queueLength: () => queue.length };
}

// ─── Suite A: Constructor validation ────────────────────────────────────────

describe('MotionValue constructor', () => {
  it('accepts valid initial value and spring params', () => {
    expect(() => new MotionValue({ initial: 0, spring: STD_SPRING })).not.toThrow();
  });

  it('throws MotionParamError for non-finite initial (NaN)', () => {
    expect(() => new MotionValue({ initial: NaN, spring: STD_SPRING })).toThrow(MotionParamError);
  });

  it('throws MotionParamError for non-finite initial (Infinity)', () => {
    expect(
      () => new MotionValue({ initial: Infinity, spring: STD_SPRING }),
    ).toThrow(MotionParamError);
  });

  it('throws MotionParamError for invalid spring mass', () => {
    expect(
      () => new MotionValue({ initial: 0, spring: { mass: 0, stiffness: 200, damping: 20 } }),
    ).toThrow(MotionParamError);
  });

  it('throws MotionParamError for invalid spring stiffness', () => {
    expect(
      () =>
        new MotionValue({ initial: 0, spring: { mass: 1, stiffness: -1, damping: 20 } }),
    ).toThrow(MotionParamError);
  });

  it('throws MotionParamError for negative damping', () => {
    expect(
      () =>
        new MotionValue({ initial: 0, spring: { mass: 1, stiffness: 200, damping: -1 } }),
    ).toThrow(MotionParamError);
  });

  it('initial value is readable via .value', () => {
    const mv = new MotionValue({ initial: 42, spring: STD_SPRING });
    expect(mv.value).toBe(42);
    mv.destroy();
  });
});

// ─── Suite A: onChange ───────────────────────────────────────────────────────

describe('MotionValue onChange', () => {
  it('immediately emits current value on subscribe', () => {
    const mv = new MotionValue({ initial: 7, spring: STD_SPRING });
    const received: number[] = [];
    mv.onChange((v) => received.push(v));
    expect(received).toEqual([7]);
    mv.destroy();
  });

  it('returns an unsubscribe function that stops further emissions', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const received: number[] = [];
    const unsub = mv.onChange((v) => received.push(v));
    // One immediate emission at subscribe time.
    expect(received.length).toBe(1);
    unsub();
    mv.setTarget(100);
    clock.drainAll();
    // After unsubscribe, no more values collected.
    expect(received.length).toBe(1);
    mv.destroy();
  });

  it('multiple listeners each receive emissions', () => {
    const mv = new MotionValue({ initial: 5, spring: STD_SPRING });
    const a: number[] = [];
    const b: number[] = [];
    mv.onChange((v) => a.push(v));
    mv.onChange((v) => b.push(v));
    expect(a).toEqual([5]);
    expect(b).toEqual([5]);
    mv.destroy();
  });
});

// ─── Suite A: setTarget validation ──────────────────────────────────────────

describe('MotionValue setTarget validation', () => {
  it('throws MotionParamError for NaN target', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(() => mv.setTarget(NaN)).toThrow(MotionParamError);
    mv.destroy();
  });

  it('throws MotionParamError for Infinity target', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(() => mv.setTarget(Infinity)).toThrow(MotionParamError);
    mv.destroy();
  });

  it('no-ops when already at target with zero velocity', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 5, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const received: number[] = [];
    mv.onChange((v) => received.push(v));
    mv.setTarget(5); // same as current, zero velocity
    clock.drain(10);
    // All emitted values are 5 (the initial immediate emission).
    expect(received.every((v) => v === 5)).toBe(true);
    mv.destroy();
  });
});

// ─── Suite A: destroy ────────────────────────────────────────────────────────

describe('MotionValue destroy', () => {
  it('stops the animation loop after destroy()', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const received: number[] = [];
    mv.onChange((v) => received.push(v));
    mv.setTarget(100);
    clock.drain(5);
    const countAtDestroy = received.length;
    mv.destroy();
    clock.drainAll();
    // After destroy, no more values emitted.
    expect(received.length).toBe(countAtDestroy);
  });

  it('setTarget after destroy is a no-op (does not throw)', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    mv.destroy();
    expect(() => mv.setTarget(100)).not.toThrow();
  });

  it('onChange after destroy does not throw', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    mv.destroy();
    expect(() => mv.onChange(() => {})).not.toThrow();
  });
});

// ─── Suite A: stop (s18 — Lit reconnect fix) ─────────────────────────────────
//
// stop() is the non-terminal counterpart to destroy(): it halts the running
// frame loop (same observable effect as destroy() — no further ticks fire)
// but leaves the instance alive — setTarget() afterwards resumes animating,
// and onChange listeners are NOT cleared. destroy() remains the only terminal
// operation.

describe('MotionValue stop', () => {
  it('halts the frame loop: no further onChange emissions after stop()', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const received: number[] = [];
    mv.onChange((v) => received.push(v));
    mv.setTarget(100);
    clock.drain(5);
    const countAtStop = received.length;

    mv.stop();
    // Injected virtual-time seam: drain any frame that may already have been
    // scheduled before stop() — it must be a guarded no-op, and no further
    // frame may be scheduled afterwards (the queue must stay empty).
    clock.drainAll();

    expect(received.length).toBe(countAtStop);
    expect(mv.value).not.toBe(100); // did not snap/converge — merely paused mid-flight
  });

  it('setTarget() after stop() resumes animating to the new target (non-terminal)', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.onChange(() => {});
    mv.setTarget(100);
    clock.drain(5);

    mv.stop();
    clock.drainAll(); // pending frame (if any) is a guarded no-op

    mv.setTarget(50);
    clock.drainAll();

    expect(mv.value).toBeCloseTo(50, 5);
  });

  it('onChange listeners survive stop() (not cleared, unlike destroy())', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const received: number[] = [];
    mv.onChange((v) => received.push(v));
    mv.setTarget(100);
    clock.drain(3);

    mv.stop();
    clock.drainAll();

    const countAfterStop = received.length;
    mv.setTarget(10);
    clock.drainAll();

    // The pre-existing listener keeps receiving emissions post-stop+resume.
    expect(received.length).toBeGreaterThan(countAfterStop);
  });

  it('destroy() remains terminal even after a prior stop() (setTarget stays a no-op)', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(3);
    mv.stop();
    mv.destroy();

    expect(() => mv.setTarget(50)).not.toThrow();
    clock.drainAll();
    expect(mv.value).not.toBeCloseTo(50, 0);
  });

  it('stop() on an idle (never-started) instance is a safe no-op', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(() => mv.stop()).not.toThrow();
    expect(mv.value).toBe(0);
  });

  // ── RED PROOF (stale-frame double-tick race) ───────────────────────────────
  // The requestFrame seam (RequestFrameFn) has no cancel handle, so a frame
  // scheduled BEFORE stop() cannot be pulled back out of the queue — it is
  // still sitting there when a subsequent setTarget() schedules a second,
  // fresh frame. Without a generation guard, that stale frame is
  // indistinguishable from a live one: when it fires, `_running` is already
  // true again (from the resuming setTarget()), so it proceeds as a REAL
  // tick — emits AND reschedules itself — permanently doubling the tick rate
  // (2 emissions/frame, queue length pinned at 2 forever instead of 1).
  // Revert the `gen !== this._generation` guard in MotionValue._tick() (or
  // stop `stop()`/`_scheduleFirstFrame()` from threading `gen` through) to
  // reproduce: both assertions below fail (2 emissions, queue length 2).
  it('setTarget() right after stop() (stale pending frame still queued) does not double-tick', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let emitCount = 0;
    mv.onChange(() => {
      emitCount++;
    });
    mv.setTarget(100);
    clock.drain(3); // 3 real ticks fire; each reschedules → 1 frame left pending (the 4th)
    emitCount = 0; // reset: only care about what happens from here on

    mv.stop(); // does NOT (cannot) cancel the already-queued 4th frame
    mv.setTarget(50); // resumes: schedules a fresh frame → queue now holds [stale, fresh]

    clock.drain(2); // drain exactly those two queued callbacks

    // A correct implementation treats the stale (pre-stop) frame as inert:
    // exactly one real tick (the fresh one) fires, and exactly one frame
    // remains queued afterwards (steady-state single loop).
    expect(emitCount).toBe(1);
    expect(clock.queueLength()).toBe(1);
  });
});

// ─── Suite A: Animation correctness ──────────────────────────────────────────

describe('MotionValue animation correctness', () => {
  it('converges to target value after sufficient frames', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));
    mv.setTarget(100);
    clock.drainAll(2500);
    mv.destroy();
    // Final emitted value must be exactly 100.
    expect(values[values.length - 1]).toBe(100);
  });

  it('negative range: converges from positive to negative target', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 100, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));
    mv.setTarget(-50);
    clock.drainAll(2500);
    mv.destroy();
    expect(values[values.length - 1]).toBe(-50);
  });

  it('emits values clamped within [from, target] for positive range', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));
    mv.setTarget(100);
    clock.drainAll(500);
    mv.destroy();
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0 - 1e-10);
      expect(v).toBeLessThanOrEqual(100 + 1e-10);
    }
  });

  it('emits initial value immediately on onChange subscribe', () => {
    const mv = new MotionValue({ initial: 99, spring: STD_SPRING });
    const first: number[] = [];
    mv.onChange((v) => first.push(v));
    expect(first).toEqual([99]);
    mv.destroy();
  });

  it('works with handle=0 non-draining clock via setTimeout fallback', async () => {
    // requestFrame returns 0 without invoking cb. MotionValue installs setTimeout(0) fallback.
    const nonDraining = (_cb: (ts?: number) => void): number => 0;
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: nonDraining });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));
    mv.setTarget(50);
    // Wait for the setTimeout fallback chain to run to completion.
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    mv.destroy();
    expect(values[values.length - 1]).toBe(50);
  }, 10_000);
});

// ─── Suite C: Finiteness fuzz — 10k+ random inputs ──────────────────────────

describe('MotionValue finiteness fuzz (class C property test, 10k+ inputs)', () => {
  /**
   * Mutation proof: remove the `if (!Number.isFinite(value)) value = 1` guard
   * in springWithV0 → degenerate floats produce NaN → this test catches them.
   */
  it('NEVER emits NaN or Infinity for any valid finite initial/target combination', () => {
    // LCG seeded random for determinism.
    let seed = 0xdeadbeef;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0xffffffff;
    };
    const randVal = (): number => (rng() - 0.5) * 2000;

    const springVariants = [
      { mass: 1, stiffness: 200, damping: 20 },   // underdamped (omega0≈14.1, zeta≈0.71)
      { mass: 1, stiffness: 100, damping: 20 },   // near-critically damped (omega0=10, zeta=1.0)
      { mass: 1, stiffness: 50, damping: 30 },    // overdamped (omega0≈7.1, zeta≈2.12)
      { mass: 1, stiffness: 4, damping: 0.8 },    // floor underdamped (omega0=2.0, zeta=0.2 — documented floor)
      { mass: 0.5, stiffness: 1000, damping: 40 }, // stiff (omega0≈44.7, zeta≈0.45)
    ];

    let totalChecked = 0;

    for (const springP of springVariants) {
      for (let i = 0; i < 2200; i++) {
        const initial = randVal();
        const target = randVal();
        const clock = makeVirtualClock();
        const mv = new MotionValue({ initial, spring: springP, requestFrame: clock.requestFrame });
        const emitted: number[] = [];
        mv.onChange((v) => emitted.push(v));
        mv.setTarget(target);
        clock.drainAll(500);
        mv.destroy();

        for (const v of emitted) {
          if (!Number.isFinite(v)) {
            throw new Error(
              `Non-finite value emitted: ${v} for initial=${initial}, target=${target}, spring=${JSON.stringify(springP)}`,
            );
          }
          totalChecked++;
        }
      }
    }

    // Sanity: must have checked at least 10k values total.
    expect(totalChecked).toBeGreaterThan(10_000);
  }, 60_000);

  it('handles degenerate AND overflow ranges without NaN/Infinity (tiny, huge, MAX_VALUE span)', () => {
    const cases: Array<{ initial: number; target: number }> = [
      { initial: 0, target: 0 },
      { initial: 1e-12, target: 2e-12 },
      { initial: -1e12, target: 1e12 },
      { initial: 0, target: 1e-15 },
      { initial: 1000, target: 1000 },
      { initial: -0, target: 0 },
      // Overflow class: |from| + |target| > MAX_VALUE → range = target − from is
      // ±Infinity, and from + normPos*range yields NaN (0*Inf). Each arg is finite
      // and passes the public validate gate; the overflow is in the subtraction.
      // The finiteness guard must snap to the (finite) target instead of emitting NaN.
      { initial: Number.MAX_VALUE, target: -Number.MAX_VALUE },
      { initial: -Number.MAX_VALUE, target: Number.MAX_VALUE },
      { initial: 8.9e307, target: -8.9e307 },
      { initial: Number.MAX_VALUE, target: Number.MAX_VALUE },
    ];
    for (const { initial, target } of cases) {
      const clock = makeVirtualClock();
      const mv = new MotionValue({ initial, spring: STD_SPRING, requestFrame: clock.requestFrame });
      const emitted: number[] = [];
      mv.onChange((v) => emitted.push(v));
      mv.setTarget(target);
      clock.drainAll(200);
      mv.destroy();
      for (const v of emitted) {
        expect(
          Number.isFinite(v),
          `non-finite for case ${JSON.stringify({ initial, target })}: ${v}`,
        ).toBe(true);
      }
    }
  });
});

// ─── Suite C: Determinism via virtual-time ───────────────────────────────────

describe('MotionValue determinism (class C bit-exact)', () => {
  /**
   * Mutation proof: change elapsed accumulation to differ between instances
   * → values diverge → bit-exact equality assertion fails.
   */
  it('two instances with identical params and clock produce identical emissions', () => {
    const initial = 10;
    const target = 80;

    const run = (): number[] => {
      const clock = makeVirtualClock(1000 / 60);
      const mv = new MotionValue({ initial, spring: STD_SPRING, requestFrame: clock.requestFrame });
      const values: number[] = [];
      mv.onChange((v) => values.push(v));
      mv.setTarget(target);
      clock.drainAll(300);
      mv.destroy();
      return values;
    };

    const a = run();
    const b = run();

    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  it('re-targeting mid-flight produces deterministic results across runs', () => {
    const run = (): number[] => {
      const clock = makeVirtualClock();
      const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
      const values: number[] = [];
      mv.onChange((v) => values.push(v));
      mv.setTarget(100);
      clock.drain(10);
      mv.setTarget(50); // retarget mid-flight
      clock.drainAll(400);
      mv.destroy();
      return values;
    };

    const a = run();
    const b = run();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });
});

// ─── Suite C: Smooth pickup (velocity continuity on retarget) ────────────────

describe('MotionValue smooth-pickup (class C, invariant 4)', () => {
  /**
   * When setTarget() is called mid-flight, the value at the retarget moment
   * must not jump (continuous output sequence).
   *
   * Mutation proof: snap value to target on setTarget() → valueBefore !== valueAtRetarget
   * → continuity assertion fails.
   */
  it('value is continuous at the retarget moment (no instantaneous jump)', () => {
    const clock = makeVirtualClock(1000 / 60);
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));
    mv.setTarget(100);

    // Advance enough frames to build up velocity but stay well in the transient.
    // STD_SPRING {m:1,k:200,d:20}: omega0≈14.1, zeta≈0.71 (underdamped).
    // At 5 frames (~83ms) we're well before convergence.
    clock.drain(5);
    const valueBefore = mv.value;

    // Retarget — the value must not jump instantaneously.
    mv.setTarget(50);
    const valueAtRetarget = mv.value;

    expect(valueAtRetarget).toBe(valueBefore);

    mv.destroy();
  });

  /**
   * Stronger continuity: measure approximate velocity (Δvalue/Δt) immediately
   * before and after retarget. With smooth pickup, the post-retarget velocity
   * must be close to the pre-retarget velocity in magnitude (velocity is
   * inherited as initial condition, not reset to zero).
   *
   * Mutation proof: set v0Normalized=0 on retarget (reset velocity to zero) →
   * post-retarget spring starts from rest → first-frame velocity ≈ 0 << pre-retarget
   * velocity → the magnitude ratio assertion fails.
   */
  it('velocity magnitude is approximately continuous across retarget (smooth pickup bite test)', () => {
    // Use a fine timestep for better velocity measurement.
    const dtMs = 1000 / 120; // 120fps
    const clock = makeVirtualClock(dtMs);
    const dtS = dtMs / 1000;

    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));

    mv.setTarget(100);
    // Drain 8 frames: well into the transient phase.
    // STD_SPRING {m:1,k:200,d:20}: omega0≈14.1, zeta≈0.71 (underdamped).
    // At 8 frames (~67ms at 120fps), position ≈ 50-70% of target with good velocity.
    clock.drain(8);

    // Compute velocity just before retarget using the last two emitted values.
    // values[0] is the immediate emission at subscribe time (no frame yet).
    // values[1..N] are frame emissions. After drain(8) we have 9 total values (idx=8).
    const idxBefore = values.length - 1;
    expect(idxBefore).toBeGreaterThanOrEqual(2);
    const velBefore = (values[idxBefore] - values[idxBefore - 1]) / dtS;

    // Spring must be actively moving at frame 8 (transient).
    expect(Math.abs(velBefore)).toBeGreaterThan(0.1);

    // Retarget to 200. After this call, _startTs is reset to undefined and _elapsed=0.
    // The NEXT tick (drain 1) will set _startTs = currentTs, elapsed=0 → position unchanged.
    // The tick AFTER THAT (drain 2 total) will have elapsed=dt → shows actual movement.
    mv.setTarget(200);

    // Drain frame N+1: this tick sets _startTs, has elapsed=0, emits _from (unchanged).
    clock.drain(1);

    // Drain frame N+2: this tick has elapsed=dt from the new run → actual spring movement.
    clock.drain(1);
    const idxAfter = values.length - 1;
    // Velocity = delta between frame N+2 and N+1 (both post-retarget frames).
    const velAfter = (values[idxAfter] - values[idxAfter - 1]) / dtS;

    expect(Number.isFinite(velAfter)).toBe(true);

    // With smooth pickup (v0 inherited), velocity at the second post-retarget frame
    // must be at least 65% of the velocity just before retarget in magnitude.
    //
    // Without smooth pickup (v0=0 reset), the spring starts from rest. At elapsed=dt
    // the normalized velocity = d/dt[springWithV0(t, v0=0)] at t=dt.
    // For STD_SPRING: omega0≈14.1, zeta≈0.71, range=200-current_value≈100:
    //   first active frame velocity from rest ≈ omega0 * dt * range ≈ 14.1*0.0083*100 ≈ 12 units/s
    // velBefore at frame 8 is typically 300-600 units/s → 65% threshold (≈195-390) >> 12.
    // So the threshold robustly separates smooth-pickup from reset-to-zero.
    const magBefore = Math.abs(velBefore);
    const magAfter = Math.abs(velAfter);
    expect(magAfter).toBeGreaterThan(magBefore * 0.65);

    mv.destroy();
  });

  /**
   * After retarget, the value must eventually converge to the NEW target.
   */
  it('converges to the new target after retarget mid-flight', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));

    mv.setTarget(100);
    clock.drain(10); // build up velocity
    mv.setTarget(50); // retarget
    clock.drainAll(2500); // run to convergence
    mv.destroy();

    expect(values[values.length - 1]).toBe(50);
  });

  /**
   * Multiple retargets: each must produce a smooth, finite output sequence.
   */
  it('handles multiple sequential retargets without NaN/Infinity', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));

    mv.setTarget(100);
    clock.drain(8);
    mv.setTarget(30);
    clock.drain(8);
    mv.setTarget(80);
    clock.drain(8);
    mv.setTarget(0);
    clock.drainAll(2500);
    mv.destroy();

    for (const v of values) {
      expect(Number.isFinite(v), `non-finite: ${v}`).toBe(true);
    }
    expect(values[values.length - 1]).toBe(0);
  });
});

// ─── Suite B: Zero-DOM invariant ─────────────────────────────────────────────

describe('MotionValue zero-DOM invariant (class B)', () => {
  /**
   * The module must be importable in Node (no DOM globals) without throwing.
   *
   * Mutation proof: add `const _el = document.createElement('div')` at module
   * top-level → import throws ReferenceError → this test fails.
   */
  it('MotionValue is constructable in a DOM-free Node environment', () => {
    expect(typeof MotionValue).toBe('function');
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(mv.value).toBe(0);
    mv.destroy();
  });

  it('setTarget and animation run without any DOM globals', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const values: number[] = [];
    mv.onChange((v) => values.push(v));
    mv.setTarget(42);
    clock.drainAll(2500);
    mv.destroy();
    // Final value must be 42 — animation ran to completion without DOM.
    expect(values[values.length - 1]).toBe(42);
  });

  it('src directory contains no DOM references in non-comment code (grep guard)', async () => {
    // This test reads src/motion-value.ts and checks that no executable code lines
    // reference DOM globals. Comment lines (starting with * or //) are excluded —
    // they may describe what the module does NOT use.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, '..', 'src', 'motion-value.ts');
    const src = readFileSync(srcPath, 'utf8');
    // Strip single-line comments and JSDoc lines before checking.
    const codeLines = src
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('/*')
        );
      })
      .join('\n');
    const domPatterns = [
      /\bdocument\s*\./,
      /\bwindow\s*\./,
      /querySelector/,
      /getElementById/,
      /_mockElement/,
      /new\s+Element\b/,
    ];
    for (const pat of domPatterns) {
      expect(pat.test(codeLines), `DOM reference found in motion-value.ts code: ${pat}`).toBe(false);
    }
  });
});

// ─── Suite B: API surface pin ─────────────────────────────────────────────────

describe('MotionValue API surface pin (class B)', () => {
  it('MotionValue is exported from top-level index', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.MotionValue).toBe('function');
  });

  it('MotionValue exposes expected instance interface', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(typeof mv.value).toBe('number');
    expect(typeof mv.onChange).toBe('function');
    expect(typeof mv.setTarget).toBe('function');
    expect(typeof mv.destroy).toBe('function');
    // stop/snapTo — часть контракта lifecycle-биндингов (Lit hostDisconnected /
    // reduced-motion snap). RED PROOF: переименовать snapTo → snap → RED.
    expect(typeof mv.stop).toBe('function');
    expect(typeof mv.snapTo).toBe('function');
    mv.destroy();
  });
});

// ─── Suite: stop()/snapTo() hardening (ноты арх-ревью PR #18) ────────────────

describe('MotionValue snapTo: валидация и идемпотентность', () => {
  it('snapTo(NaN/±Infinity) → MotionParamError (страж конечности)', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: () => 1 });
    // Mutation-proof: убрать Number.isFinite-guard из snapTo → RED здесь.
    expect(() => mv.snapTo(NaN)).toThrow(MotionParamError);
    expect(() => mv.snapTo(Infinity)).toThrow(MotionParamError);
    expect(() => mv.snapTo(-Infinity)).toThrow(MotionParamError);
    mv.destroy();
  });

  // Примечание: onChange эмитит текущее значение сразу при подписке — все
  // счётчики ниже считают ДЕЛЬТЫ после этого начального вызова.
  it('повторный snapTo в тот же target — ровно один emit (идемпотентность)', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let emits = 0;
    mv.onChange(() => emits++);
    const base = emits; // 1 — начальный вызов подписки
    mv.snapTo(5);
    expect(emits).toBe(base + 1);
    mv.snapTo(5); // уже покоится ровно в 5 — лишний requestUpdate потребителю не нужен
    expect(emits).toBe(base + 1);
    mv.snapTo(6); // другой target — обязан эмитить
    expect(emits).toBe(base + 2);
    mv.destroy();
  });

  it('snapTo ПРЕРЫВАЕТ живой ран в тот же target (не путать с идемпотентным no-op)', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(10);
    clock.drain(3); // пружина в полёте, value ещё не 10
    let emits = 0;
    mv.onChange(() => emits++);
    const base = emits;
    mv.snapTo(10); // target совпадает, но ран ЖИВОЙ → снап обязан сработать и эмитить
    expect(emits).toBe(base + 1);
    expect(mv.value).toBe(10);
    clock.drainAll(); // stale-кадры прежнего рана инертны: не эмитят и не двигают
    expect(mv.value).toBe(10);
    expect(emits).toBe(base + 1);
    mv.destroy();
  });
});

describe('MotionValue re-entrancy: stop()/destroy() из onChange-колбэка', () => {
  it('stop() изнутри emit → мёртвый ран НЕ перепланируется (ноль лишних кадров)', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let initial = true;
    mv.onChange(() => {
      if (initial) { initial = false; return; } // пропустить вызов-при-подписке
      mv.stop();
    });
    mv.setTarget(100); // планирует первый кадр
    const before = clock.queueLength();
    expect(before).toBe(1);
    clock.drain(1); // кадр эмитит → слушатель зовёт stop() → перепланирования быть не должно
    expect(clock.queueLength()).toBe(0);
    mv.destroy();
  });

  it('destroy() изнутри emit → не перепланируется и не бросает', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let initial = true;
    mv.onChange(() => {
      if (initial) { initial = false; return; }
      mv.destroy();
    });
    mv.setTarget(100);
    expect(clock.queueLength()).toBe(1);
    expect(() => clock.drain(1)).not.toThrow();
    expect(clock.queueLength()).toBe(0);
  });
});
