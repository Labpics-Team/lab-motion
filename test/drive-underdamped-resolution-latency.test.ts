import { describe, expect, it } from 'vitest';
import { drive } from '../src/index.js';

/**
 * Test: drive() Promise resolves promptly after underdamped spring visually finishes
 * Class: regression (correctness + contract — High severity)
 *
 * Bug: drive() Promise resolved ~3.9s after the animation visually completed for
 * accepted underdamped springs. Root cause: isConverged() gated both a position term
 * (using CLAMPED computeValue()) and a velocity term (using UNCLAMPED springUnchecked()
 * velocity). Once the spring overshoots and the clamped position is frozen at `to`, the
 * position term is trivially satisfied (abs(to - to) / absRange == 0) but the velocity
 * term kept reading the raw physics velocity tail — which for an accepted underdamped spring
 * at the documented floor (zeta=0.2, omega0=2.0: mass=1, stiffness=4, damping=0.8) stays
 * above the 0.5% threshold for ~234 additional frames / ~3.9s after visual completion.
 *
 * Fix: isConverged() early-exits when maxEmittedToward === to. Once the monotone emitter
 * has committed the visual to `to`, no velocity tail — however large — can produce new
 * visual values. The invisible velocity tail must not gate the Promise.
 *
 * RED proof (mutation targets — any of these reverts the class fix):
 *   - Remove the `if (maxEmittedToward === to) return true` guard from isConverged() →
 *     "resolves within N frames of first emitting to" assertion fails (Promise resolves
 *     ~234 frames after `to` was first emitted, not within 2).
 *   - Restore the old isConverged() body that only checks position+velocity without the
 *     early-exit → same failure.
 *   - Change `maxEmittedToward === to` to `maxEmittedToward > to + 1` → early-exit never
 *     fires, reverts to unclamped-velocity gate, same failure.
 *
 * Mutation proof:
 *   The frame-count assertions anchor resolution to within 2 frames of first `to` emission,
 *   far tighter than the ~234 frame tail. Any regression widens this gap beyond the bound.
 *
 * Class closed by: isConverged() visual-saturation early-exit (drive.ts).
 */

/** Stub matchMedia: no reduced-motion preference. */
function noReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * Step clock that drains on demand, returns non-zero handle so no setTimeout fallback.
 * Tracks exactly which frame the Promise resolves relative to first `to` emission.
 */
function makeCountingClock(): {
  clock: (cb: (ts: number) => void) => number;
  drainUntilDone: (maxFrames: number, done: Promise<void>) => Promise<number>;
} {
  const queue: Array<(ts: number) => void> = [];
  let ts = 0;
  let handle = 0;
  return {
    clock: (cb) => {
      queue.push(cb);
      return ++handle; // always ≥ 1 → no setTimeout fallback
    },
    drainUntilDone: async (maxFrames, done) => {
      let framesAfterDoneFlag = 0;
      let resolved = false;
      void done.then(() => {
        resolved = true;
      });
      for (let i = 0; i < maxFrames; i++) {
        if (resolved) return i;
        if (queue.length === 0) {
          // Give microtask queue a chance to resolve the Promise.
          await Promise.resolve();
          if (resolved) return i;
          break;
        }
        ts += 16; // 60fps
        const cb = queue.shift();
        cb?.(ts);
        framesAfterDoneFlag++;
        // Yield between frames so Promise.then can fire.
        await Promise.resolve();
        if (resolved) return framesAfterDoneFlag;
      }
      return Infinity;
    },
  };
}

describe('drive() Promise resolves promptly when underdamped spring visually finishes (regression lock)', () => {
  /**
   * Core regression test: documented-floor underdamped spring.
   * Spring params: mass=1, stiffness=4, damping=0.8 → omega0=2.0 rad/s, zeta=0.2.
   * This is the EXACT worst case from the confirmed finding.
   *
   * Before fix: Promise resolved at frame ~289 while `to` was first emitted at frame ~55
   *   → 234 frames of dead latency.
   * After fix: Promise resolves within 2 frames of first emitting `to`.
   */
  it('floor underdamped spring (zeta=0.2, omega0=2.0) — Promise resolves within 2 frames of first emitting to', async () => {
    const values: number[] = [];
    let firstToFrame = -1;
    let resolveFrame = -1;
    let frameCount = 0;

    const frameQueue: Array<(ts: number) => void> = [];
    let ts = 0;
    let handle = 0;
    const clock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return ++handle;
    };

    const done = drive({
      from: 0,
      to: 100,
      // omega0=sqrt(4/1)=2.0, zeta=0.8/(2*sqrt(4*1))=0.8/4=0.2 — documented floor
      spring: { mass: 1, stiffness: 4, damping: 0.8 },
      onStep: (v) => {
        values.push(v);
        if (v === 100 && firstToFrame === -1) firstToFrame = frameCount;
      },
      matchMedia: noReduceMedia(),
      requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
    });

    let resolved = false;
    void done.then(() => {
      resolved = true;
      resolveFrame = frameCount;
    });

    // Drain up to 400 frames to cover both the old (289) and new (≤57) convergence frames.
    for (let i = 0; i < 400; i++) {
      if (resolved && resolveFrame !== -1) break;
      if (frameQueue.length === 0) {
        await Promise.resolve();
        if (resolved && resolveFrame !== -1) break;
        continue;
      }
      ts += 16;
      frameCount++;
      const cb = frameQueue.shift();
      cb?.(ts);
      // Yield microtask queue so Promise.then can fire.
      await Promise.resolve();
    }

    await done; // ensure settled

    // The animation must have found `to` before resolving.
    expect(firstToFrame, 'spring must reach `to` before resolving').toBeGreaterThan(0);

    // Core assertion: Promise resolves within 2 frames of first emitting `to`.
    // Before fix: resolveFrame was ~289, firstToFrame was ~55 → diff ~234.
    // After fix: resolveFrame === firstToFrame + 1 (one more tick executes isConverged and resolves).
    const lag = resolveFrame - firstToFrame;
    expect(
      lag,
      `Promise resolved ${lag} frames after first emitting \`to\` (firstToFrame=${firstToFrame}, resolveFrame=${resolveFrame}). ` +
        `Before fix this was ~234 frames. The visual-saturation early-exit in isConverged() must close this gap to ≤2.`,
    ).toBeLessThanOrEqual(2);

    // Terminal value emitted by settle() must be exactly `to`.
    expect(values[values.length - 1]).toBe(100);

    // Monotonic sequence (regression: monotone emitter must not be broken by fix).
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]! - 1e-10);
    }
  }, 10000);

  /**
   * Variant: mid-range underdamped spring (zeta=0.4, omega0=10).
   * Typical UI spring that still undershoots slightly — verifies fix applies broadly,
   * not just at the documented floor.
   */
  it('typical underdamped UI spring (zeta=0.4, omega0=10) — Promise resolves within 2 frames of to', async () => {
    const values: number[] = [];
    let firstToFrame = -1;
    let resolveFrame = -1;
    let frameCount = 0;

    const frameQueue: Array<(ts: number) => void> = [];
    let ts = 0;
    let handle = 0;
    const clock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return ++handle;
    };

    const done = drive({
      from: 0,
      to: 200,
      // omega0=sqrt(100/1)=10, zeta=8/(2*sqrt(100))=8/20=0.4
      spring: { mass: 1, stiffness: 100, damping: 8 },
      onStep: (v) => {
        values.push(v);
        if (v === 200 && firstToFrame === -1) firstToFrame = frameCount;
      },
      matchMedia: noReduceMedia(),
      requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
    });

    let resolved = false;
    void done.then(() => {
      resolved = true;
      resolveFrame = frameCount;
    });

    for (let i = 0; i < 400; i++) {
      if (resolved && resolveFrame !== -1) break;
      if (frameQueue.length === 0) {
        await Promise.resolve();
        if (resolved && resolveFrame !== -1) break;
        continue;
      }
      ts += 16;
      frameCount++;
      const cb = frameQueue.shift();
      cb?.(ts);
      await Promise.resolve();
    }

    await done;

    expect(firstToFrame, 'spring must emit `to` before resolving').toBeGreaterThan(0);
    const lag = resolveFrame - firstToFrame;
    expect(
      lag,
      `Lag=${lag} frames. Visual-saturation early-exit must close this to ≤2.`,
    ).toBeLessThanOrEqual(2);
    expect(values[values.length - 1]).toBe(200);
  }, 10000);

  /**
   * Negative range: from=100 to=0 underdamped — ensures fix works for both directions.
   * The maxEmittedToward logic uses min() for negative ranges; early-exit compares === to.
   */
  it('negative range underdamped spring (from=100 to=0) — Promise resolves within 2 frames of first emitting to', async () => {
    const values: number[] = [];
    let firstToFrame = -1;
    let resolveFrame = -1;
    let frameCount = 0;

    const frameQueue: Array<(ts: number) => void> = [];
    let ts = 0;
    let handle = 0;
    const clock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return ++handle;
    };

    const done = drive({
      from: 100,
      to: 0,
      spring: { mass: 1, stiffness: 100, damping: 8 },
      onStep: (v) => {
        values.push(v);
        if (v === 0 && firstToFrame === -1) firstToFrame = frameCount;
      },
      matchMedia: noReduceMedia(),
      requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
    });

    let resolved = false;
    void done.then(() => {
      resolved = true;
      resolveFrame = frameCount;
    });

    for (let i = 0; i < 400; i++) {
      if (resolved && resolveFrame !== -1) break;
      if (frameQueue.length === 0) {
        await Promise.resolve();
        if (resolved && resolveFrame !== -1) break;
        continue;
      }
      ts += 16;
      frameCount++;
      const cb = frameQueue.shift();
      cb?.(ts);
      await Promise.resolve();
    }

    await done;

    expect(firstToFrame, 'spring must emit `to` before resolving').toBeGreaterThan(0);
    const lag = resolveFrame - firstToFrame;
    expect(lag, `Lag=${lag} frames for negative range.`).toBeLessThanOrEqual(2);
    expect(values[values.length - 1]).toBe(0);

    // Monotonically NON-INCREASING toward 0 for negative range.
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]! + 1e-10);
    }
  }, 10000);

  /**
   * Critically-damped spring — verifies fix does not break the normal convergence path.
   * For critically-damped springs, the raw velocity and the clamped position both converge
   * simultaneously (no overshoot), so the early-exit fires at the same frame as the old
   * velocity gate would have. Frame count must remain consistent.
   */
  it('critically-damped spring still converges correctly — fix does not weaken normal path', async () => {
    const values: number[] = [];
    const frameQueue: Array<(ts: number) => void> = [];
    let ts = 0;
    let handle = 0;
    const clock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return ++handle;
    };

    const done = drive({
      from: 0,
      to: 100,
      // omega0=sqrt(170)≈13.04, zeta=26/(2*sqrt(170))≈0.997 — near-critical
      spring: { mass: 1, stiffness: 170, damping: 26 },
      onStep: (v) => values.push(v),
      matchMedia: noReduceMedia(),
      requestFrame: clock as unknown as (cb: (ts?: number) => void) => number,
    });

    for (let i = 0; i < 300 && frameQueue.length > 0; i++) {
      ts += 16;
      const cb = frameQueue.shift();
      cb?.(ts);
    }
    await done;

    // Must converge — terminal value is exactly `to`.
    expect(values[values.length - 1]).toBe(100);
    // Must converge well before MAX_FRAMES (300 drain cap is far under 2000).
    expect(values.length).toBeLessThan(300);
    expect(values.length).toBeGreaterThanOrEqual(5);
  }, 5000);
});
