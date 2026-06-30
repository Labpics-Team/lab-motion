/**
 * test/animate-overflow-finiteness-fuzz.test.ts — property/fuzz
 * Class: property (В — closes the CLASS, not one input)
 *
 * Invariant 3 — NaN/∞-safe: the engine NEVER emits NaN or ±Infinity on ANY
 * emit path when |from|+|to|>Number.MAX_VALUE, causing range=to−from→±∞.
 *
 * Prior gap: existing fuzz covered spring solver params and easing inputs but NOT
 * the output-scaling step where `from + normPos * range` with range=±∞ produces:
 *   • NaN  — when normPos=0 at t=0 and range=±∞  (0*∞ = NaN in IEEE-754)
 *   • ±∞   — when normPos>0 and range=±∞ (before clamp absorbs it)
 * This test closes that gap for the tween() and drive() animate contours.
 * MotionValue is already protected by its `!Number.isFinite(range)` convergence guard.
 *
 * ── RED PROOF ──────────────────────────────────────────────────────────────────
 *
 * tween RED: remove `if (!Number.isFinite(raw))` guard from src/tween.ts.
 *   tween(MAX_VALUE, -MAX_VALUE, 0.5):
 *     raw = MAX_VALUE + (-MAX_VALUE - MAX_VALUE) * 0.5
 *         = MAX_VALUE + (-Infinity) * 0.5
 *         = MAX_VALUE + (-Infinity)
 *         = -Infinity
 *   Number.isFinite(-Infinity) = false → RED for the right reason (behavior missing,
 *   not a compile error). Restore → GREEN.
 *
 * drive RED: remove `if (!Number.isFinite(range))` guard from src/drive.ts.
 *   drive(1e308, -1e308, …) with a non-zero-handle clock delivering ts=0 first frame:
 *     range = -1e308 - 1e308 = -2e308 = -Infinity
 *     springUnchecked(params, 0).value = 0   (spring at rest at t=0)
 *     raw = 1e308 + 0 * (-Infinity) = 1e308 + NaN = NaN   (0 * ∞ = NaN, IEEE-754)
 *     clamp(NaN, lo, hi) = NaN
 *     onStep(NaN) → Number.isFinite(NaN) = false → RED.
 *   Restore → GREEN.
 *
 * ── STRATEGY ──────────────────────────────────────────────────────────────────
 *
 * • Seeded LCG (Park-Miller, zero deps, reproducible) — 10 000+ (from, to, t) triples
 *   drawn from the overflow region where |from|+|to| > Number.MAX_VALUE.
 * • Enumerated IEEE-754 overflow edge pairs for direct coverage.
 * • drive() tested via injectable requestFrame seam (virtual-time clock) for
 *   determinism. Two clock modes:
 *     1. handle=0 (non-draining) → setTimeout fallback path (t > 0 always)
 *     2. handle>0 + ts=0 first frame → the NaN-producing t=0 edge case (RED proof)
 * • All assertions: Number.isFinite(result) for EVERY emit.
 */

import { describe, expect, it } from 'vitest';
import { tween } from '../src/index.js';
import { drive } from '../src/index.js';
import type { SpringParams } from '../src/index.js';

// ─── LCG ─────────────────────────────────────────────────────────────────────

/** Park-Miller LCG — seeded, reproducible, zero dependencies. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1; // force 32-bit unsigned, non-zero
  return () => {
    s = (Math.imul(48271, s) + 0) & 0x7fffffff;
    return s / 0x7fffffff; // [0, 1)
  };
}

/** Map LCG output to [min, max]. */
function lerp(u: number, min: number, max: number): number {
  return min + u * (max - min);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX = Number.MAX_VALUE; // ≈ 1.7976931348623157e+308

/**
 * Spring params that pass validateSpringParams().
 * ω₀ = sqrt(100/1) = 10 rad/s > MIN=2; ζ = 20/(2*sqrt(100)) = 1.0 (critical).
 */
const STD_SPRING: SpringParams = { mass: 1, stiffness: 100, damping: 20 };

/** Stub matchMedia — no reduced-motion preference. */
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
 * Overflow (from, to) pairs: |from|+|to|>MAX_VALUE so to-from overflows to ±Infinity.
 * We also include a "normal large" pair (range = finite MAX) as a regression guard
 * to ensure the guard doesn't break the non-overflow path.
 */
const OVERFLOW_PAIRS: Array<{ from: number; to: number; label: string }> = [
  { from: MAX, to: -MAX, label: 'MAX → -MAX' },
  { from: -MAX, to: MAX, label: '-MAX → MAX' },
  { from: 1e308, to: -1e308, label: '1e308 → -1e308 (sum=2e308>MAX)' },
  { from: -1e308, to: 1e308, label: '-1e308 → 1e308' },
  { from: MAX * 0.6, to: -MAX * 0.6, label: '0.6*MAX → -0.6*MAX' },
  { from: -MAX * 0.6, to: MAX * 0.6, label: '-0.6*MAX → 0.6*MAX' },
  { from: MAX * 0.9, to: -MAX * 0.9, label: '0.9*MAX → -0.9*MAX' },
  { from: 9e307, to: -9e307, label: '9e307 → -9e307 (sum=1.8e308>MAX)' },
  // non-overflow guard: range = -MAX is finite → must animate normally
  { from: MAX, to: 0, label: 'MAX → 0 (finite range, regression guard)' },
  { from: 0, to: MAX, label: '0 → MAX (finite range, regression guard)' },
];

// ─── Prerequisites ───────────────────────────────────────────────────────────

describe('animate-overflow-finiteness: prerequisites', () => {
  it('tween is callable — anti-theater guard (RED if engine absent)', () => {
    expect(typeof tween).toBe('function');
  });
  it('drive is callable — anti-theater guard (RED if engine absent)', () => {
    expect(typeof drive).toBe('function');
  });
});

// ─── tween: overflow fuzz ─────────────────────────────────────────────────────

describe('tween() — overflow-edge finiteness fuzz (invariant 3)', () => {
  /**
   * Direct overflow edge pairs — HIGH priority: these are the exact cases that
   * break the naive `from + (to-from)*t` formula.
   *
   * RED proof: remove the `!Number.isFinite(raw)` guard in tween.ts and this test
   * fails immediately on the first t=0.5 sample with the MAX→-MAX pair.
   */
  it('direct overflow pairs — all t ∈ {0, 0.001, 0.1, 0.5, 0.9, 0.999, 1} produce finite output', () => {
    const T_SAMPLES = [0, 0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 1];
    const failures: string[] = [];

    for (const { from, to, label } of OVERFLOW_PAIRS) {
      for (const t of T_SAMPLES) {
        const result = tween(from, to, t);
        if (!Number.isFinite(result)) {
          failures.push(`tween(${label}, t=${t}) = ${result}`);
        }
      }
    }

    expect(
      failures,
      `Invariant 3 violated — non-finite tween output:\n${failures.join('\n')}`,
    ).toHaveLength(0);
  });

  /**
   * t=0 and t=1 boundary correctness: must return `from` and `to` exactly,
   * even for overflow pairs (the t≤0 / t≥1 early-exits handle this before the
   * overflow path is reached, so these are unchanged by the guard).
   */
  it('tween(from, to, 0) === from and tween(from, to, 1) === to for overflow pairs', () => {
    for (const { from, to, label } of OVERFLOW_PAIRS) {
      expect(tween(from, to, 0), `t=0 should return from for ${label}`).toBe(from);
      expect(tween(from, to, 1), `t=1 should return to for ${label}`).toBe(to);
    }
  });

  /**
   * Seeded property fuzz — 10 000+ (from, to, t) triples drawn from the overflow region.
   * |from| ∈ [0.5*MAX, MAX], |to| ∈ [0.5*MAX, MAX], signs opposite → |from|+|to|>MAX.
   * Also interleaves normal-range pairs as a regression guard.
   *
   * Mutation proof: removing the finiteness guard causes ~50% of mid-t samples to return
   * ±Infinity (from + (-Infinity)*t = -Infinity for t>0), failing this assertion.
   */
  it('seeded LCG fuzz ≥10 000 samples — all outputs finite (invariant 3)', () => {
    const rand = lcg(0xcafe_babe);
    const SAMPLES = 10_000;
    const failures: string[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      let from: number;
      let to: number;
      let t: number;

      const kind = i % 4;
      if (kind === 0) {
        // Overflow: from positive, to negative
        from = lerp(rand(), 0.5 * MAX, MAX);
        to = -lerp(rand(), 0.5 * MAX, MAX);
        t = rand();
      } else if (kind === 1) {
        // Overflow: from negative, to positive
        from = -lerp(rand(), 0.5 * MAX, MAX);
        to = lerp(rand(), 0.5 * MAX, MAX);
        t = rand();
      } else if (kind === 2) {
        // Normal range (regression guard): both near MAX, same sign
        from = lerp(rand(), 0, MAX);
        to = lerp(rand(), 0, MAX);
        t = rand();
      } else {
        // Overflow: near-overflow threshold (sum just over MAX)
        from = lerp(rand(), 0.9 * MAX, MAX);
        to = -lerp(rand(), 0.9 * MAX, MAX);
        t = rand();
      }

      const result = tween(from, to, t);
      if (!Number.isFinite(result)) {
        failures.push(
          `sample ${i}: tween(${from}, ${to}, ${t}) = ${result}`,
        );
        if (failures.length >= 20) break; // cap output
      }
    }

    expect(
      failures,
      `Invariant 3 (tween) — non-finite outputs:\n${failures.join('\n')}`,
    ).toHaveLength(0);
  });

  /**
   * Two-point form fallback correctness: when range overflows, the fallback
   * `from*(1-t)+to*t` must equal the correct interpolated value (for t=0.5,
   * the midpoint of MAX and -MAX is exactly 0).
   */
  it('tween(MAX_VALUE, -MAX_VALUE, 0.5) === 0 — two-point form gives exact midpoint', () => {
    // Midpoint of MAX and -MAX is 0. The two-point form:
    //   MAX * (1 - 0.5) + (-MAX) * 0.5 = MAX*0.5 - MAX*0.5 = 0
    // The standard form would overflow: MAX + (-2*MAX)*0.5 = MAX - Infinity = -Infinity.
    const result = tween(MAX, -MAX, 0.5);
    expect(result).toBe(0);
  });

  it('tween(-MAX_VALUE, MAX_VALUE, 0.5) === 0 — symmetric case', () => {
    const result = tween(-MAX, MAX, 0.5);
    expect(result).toBe(0);
  });
});

// ─── drive: overflow fuzz (async, virtual-time) ───────────────────────────────

describe('drive() — overflow-edge finiteness fuzz (invariant 3, virtual-time)', () => {
  /**
   * Handle=0 path (setTimeout fallback): t is always >0 (elapsedSeconds += FIXED_DT_S).
   * The spring produces a small positive normPos, overflow range clamps to ±MAX,
   * and the animation settles in 2 frames via the `maxEmittedToward === to` gate.
   *
   * Also tests: after the fix, drive() with overflow range resolves via early-exit
   * synchronously (no frames scheduled at all), so the setTimeout fallback never fires.
   */
  it('drive() overflow pairs — handle=0 (setTimeout fallback): all emitted values finite and promise resolves', async () => {
    // Only test true overflow pairs (regression guards are non-overflow, test separately)
    const overflowOnly = OVERFLOW_PAIRS.filter(
      ({ from, to }) => !Number.isFinite(to - from),
    );

    for (const { from, to, label } of overflowOnly) {
      const emitted: number[] = [];
      await drive({
        from,
        to,
        spring: STD_SPRING,
        matchMedia: noReduceMedia(),
        onStep: (v) => emitted.push(v),
        requestFrame: (_cb) => 0, // non-draining → setTimeout fallback
      });

      for (const v of emitted) {
        expect(
          Number.isFinite(v),
          `drive(${label}) emitted non-finite value: ${v}`,
        ).toBe(true);
      }

      // Must have emitted at least `to` (the settle value)
      expect(emitted.length, `drive(${label}) must emit at least once`).toBeGreaterThanOrEqual(1);
      expect(emitted[emitted.length - 1], `drive(${label}) terminal value must be 'to'`).toBe(to);
    }
  }, 5000 /* timeout: 5s for all pairs via setTimeout */);

  /**
   * Timestamp clock, ts=0 first frame — the NaN-producing edge case.
   *
   * RED proof: remove `if (!Number.isFinite(range))` from drive.ts.
   *   range = to - from = -Infinity
   *   Frame 1 at ts=0: startTs=0, elapsedSeconds=0
   *     springUnchecked(params, 0).value = 0 (spring at rest at t=0)
   *     raw = from + 0 * (-Infinity) = from + NaN = NaN  (0*∞=NaN, IEEE-754)
   *     clamp(NaN, lo, hi) = NaN
   *     onStep(NaN) → Number.isFinite(NaN) = false → RED
   *   Restore → GREEN (drive exits before scheduling any frames).
   *
   * After the fix: drive() detects !isFinite(range) before constructing the Promise
   * and returns synchronously. Queue stays empty. `await p` resolves immediately.
   * emitted = [to] (from the early-exit onStep(to) call). All finite.
   */
  it('drive() overflow — timestamp clock (ts=0 first frame, the t=0 NaN edge): all emitted finite', async () => {
    // Queue-based draining clock: non-zero handles, delivers ts=0 on first frame
    const queue: Array<(ts?: number) => void> = [];
    let handle = 0;
    let callCount = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      queue.push(cb);
      return ++handle; // always >0: stays in requestFrame path (no setTimeout fallback)
    };

    const emitted: number[] = [];
    const p = drive({
      from: 1e308,
      to: -1e308,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame,
    });

    // Drain up to 5 frames: first is ts=0 (t=0 edge), subsequent advance by 16ms.
    // With fix: queue is empty (drive exited before scheduling), loop is a no-op.
    // Without fix: first frame fires with ts=0 → NaN → assertion below fails immediately.
    for (let i = 0; i < 5 && queue.length > 0; i++) {
      const cb = queue.shift()!;
      cb(callCount * 16); // ts: 0, 16, 32, ... — first is 0
      callCount++;
    }

    // Assert BEFORE await so the test fails fast in the broken (no-fix) case.
    // Without fix: emitted[0]=NaN → assertion throws → test fails without hanging.
    // With fix: emitted=[to=-1e308], all finite → continues to await.
    for (const v of emitted) {
      expect(
        Number.isFinite(v),
        `drive(1e308 → -1e308) emitted non-finite value: ${v}`,
      ).toBe(true);
    }

    // Await with a safety race: with fix p is already resolved; without fix the
    // assertion above already failed so this line is never reached.
    await Promise.race([p, new Promise<void>((r) => setTimeout(r, 500))]);

    expect(emitted.length, 'must have emitted at least one value').toBeGreaterThanOrEqual(1);
    expect(emitted[emitted.length - 1], 'terminal value must be `to`').toBe(-1e308);
  }, 1000 /* aggressive timeout: with fix resolves in <1ms */);

  /**
   * Same ts=0-first-frame test for the reverse direction (from=-1e308, to=1e308).
   */
  it('drive() overflow reverse direction (ts=0 first frame): all emitted finite', async () => {
    const queue: Array<(ts?: number) => void> = [];
    let handle = 0;
    let callCount = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      queue.push(cb);
      return ++handle;
    };

    const emitted: number[] = [];
    const p = drive({
      from: -1e308,
      to: 1e308,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame,
    });

    for (let i = 0; i < 5 && queue.length > 0; i++) {
      queue.shift()!(callCount++ * 16);
    }

    for (const v of emitted) {
      expect(Number.isFinite(v), `emitted non-finite: ${v}`).toBe(true);
    }

    await Promise.race([p, new Promise<void>((r) => setTimeout(r, 500))]);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[emitted.length - 1]).toBe(1e308);
  }, 1000);

  /**
   * Seeded fuzz — 200 overflow (from, to) pairs tested via handle=0 clock.
   * Each pair: emit sequence must be finite, Promise must resolve.
   * This closes the CLASS (all overflow pairs) not just the enumerated edges.
   */
  it('seeded fuzz — 200 overflow pairs via handle=0 clock: all emitted finite, all promises resolve', async () => {
    const rand = lcg(0xfeed_f00d);
    const SAMPLES = 200;
    const failures: string[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      let from: number;
      let to: number;

      if (i % 2 === 0) {
        from = lerp(rand(), 0.5 * MAX, MAX);
        to = -lerp(rand(), 0.5 * MAX, MAX);
      } else {
        from = -lerp(rand(), 0.5 * MAX, MAX);
        to = lerp(rand(), 0.5 * MAX, MAX);
      }

      const emitted: number[] = [];
      try {
        await drive({
          from,
          to,
          spring: STD_SPRING,
          matchMedia: noReduceMedia(),
          onStep: (v) => emitted.push(v),
          requestFrame: (_cb) => 0, // handle=0 → setTimeout fallback
        });
      } catch (err) {
        failures.push(`sample ${i}: drive(${from}, ${to}) threw: ${err}`);
        continue;
      }

      for (const v of emitted) {
        if (!Number.isFinite(v)) {
          failures.push(`sample ${i}: drive(${from}, ${to}) emitted non-finite: ${v}`);
          break;
        }
      }

      if (emitted.length === 0) {
        failures.push(`sample ${i}: drive(${from}, ${to}) emitted nothing`);
      }
    }

    expect(
      failures,
      `Invariant 3 (drive) — failures:\n${failures.slice(0, 20).join('\n')}`,
    ).toHaveLength(0);
  }, 30_000 /* 200 async drives via setTimeout: up to 30s */);

  /**
   * Regression guard: finite range (non-overflow) still animates normally.
   * drive(0, MAX_VALUE, …) has range=MAX (finite) — must NOT be short-circuited
   * by the overflow guard, must animate with intermediate values, settle at MAX.
   */
  it('drive() finite range (non-overflow) is NOT short-circuited — animates normally', async () => {
    const emitted: number[] = [];
    await drive({
      from: 0,
      to: MAX,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame: (_cb) => 0, // non-draining
    });

    // Must emit more than 1 value (actual animation, not an instant snap)
    expect(emitted.length, 'must animate with multiple frames').toBeGreaterThan(1);
    expect(emitted[emitted.length - 1]).toBe(MAX);
    for (const v of emitted) {
      expect(Number.isFinite(v), `non-finite: ${v}`).toBe(true);
    }
  }, 5000);
});
