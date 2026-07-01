/**
 * test/lit-reconnect.test.ts
 * Класс: А (unit — Lit ReactiveController lifecycle) + Б (regression: reconnect
 * must not permanently freeze the MotionValue).
 *
 * Bug (s18): hostDisconnected() called `this._mv.destroy()`, which sets the
 * MotionValue's internal `_destroyed = true` PERMANENTLY. Since the same
 * MotionValue instance is reused across reconnects (created once, in the
 * constructor), a host that disconnects then reconnects (common in Lit —
 * e.g. moved within a keyed list, or a parent Suspense boundary re-renders
 * it) resumes `hostConnected()` (re-subscribes onChange) but `setTarget()` is
 * now a permanent no-op forever: the spring is dead, only `destroy()`'s
 * terminal state remains.
 *
 * ── RED PROOF ──────────────────────────────────────────────────────────────
 * On current PR #18 HEAD, hostDisconnected() calls `this._mv.destroy()`.
 * disconnect → reconnect → setTarget(10) → drain the virtual clock queue:
 * the value never leaves its pre-disconnect starting point (0) because
 * `MotionValue.setTarget` early-returns on `this._destroyed`. This test's
 * final assertion (`value` moved past the reconnect starting point toward 10)
 * FAILS on that HEAD — RED for the correct reason (frozen animation, not a
 * missing/broken assertion).
 *
 * After the fix (hostDisconnected() calls `this._mv.stop()` instead of
 * `destroy()`), the same MotionValue instance keeps `_destroyed === false`,
 * so setTarget() after reconnect resumes animating normally → GREEN.
 */

import { describe, expect, it } from 'vitest';
import { MotionController } from '../src/lit/controller.js';

const STD_SPRING = { mass: 1, stiffness: 200, damping: 20 };

function makeVirtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length; // non-zero handle → stays in requestFrame path, no setTimeout fallback
  };
  const drainAll = (max = 3000): void => {
    let i = 0;
    while (queue.length > 0 && i++ < max) {
      const cb = queue.shift()!;
      clock += 1000 / 60;
      cb(clock);
    }
  };
  return { requestFrame, drainAll, pending: () => queue.length };
}

function makeFakeHost() {
  let updates = 0;
  return {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {
      updates++;
    },
    updateComplete: Promise.resolve(true),
    get updates() {
      return updates;
    },
  };
}

describe('MotionController: hostDisconnected → hostConnected reconnect (s18)', () => {
  it('resumes animating toward a new target after disconnect + reconnect', () => {
    const clock = makeVirtualClock();
    const host = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
    });

    controller.hostConnected();
    controller.hostDisconnected();

    // Reconnect: a real Lit host calls hostConnected() again when the element
    // re-enters the DOM.
    controller.hostConnected();

    controller.setTarget(10);
    clock.drainAll();

    // Frozen-bug behavior would leave value at 0 forever (setTarget is a
    // destroyed-instance no-op). The fix must actually approach 10.
    expect(controller.value).toBeGreaterThan(0);
    expect(controller.value).toBeCloseTo(10, 1);
  });

  it('the reconnected subscription fires requestUpdate exactly once per emitted frame (no duplicate listener)', () => {
    const clock = makeVirtualClock();
    const host = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
    });

    controller.hostConnected();
    controller.hostDisconnected();
    controller.hostConnected();

    controller.setTarget(1);
    const before = host.updates;
    // Drain exactly one queued frame: if the old (pre-disconnect) listener
    // were still attached alongside the new one, this single emission would
    // fire requestUpdate twice.
    clock.drainAll(1);
    const delta = host.updates - before;

    expect(delta).toBe(1);
  });

  it('survives multiple disconnect/reconnect cycles (closes the CLASS, not one instance)', () => {
    const clock = makeVirtualClock();
    const host = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
    });

    for (let cycle = 0; cycle < 3; cycle++) {
      controller.hostConnected();
      controller.hostDisconnected();
    }
    controller.hostConnected();

    controller.setTarget(20);
    clock.drainAll();

    expect(controller.value).toBeCloseTo(20, 1);
  });
});
