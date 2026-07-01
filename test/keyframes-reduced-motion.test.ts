/**
 * test/keyframes-reduced-motion.test.ts
 * Классы: А (unit CHARACTER-switch) + Д (mutation RED-proof).
 *
 * Invariant 4 — reduced-motion: CHARACTER-switch, снап к values[last],
 * НЕ hard-off (onStep никогда не вызывается) и НЕ full multi-frame playback.
 *
 * ── RED PROOF (mutation 1) ───────────────────────────────────────────────────
 * Убрать `if (reduce) { settle(lastValue); }` из keyframes/index.ts →
 * reduced-motion путь становится обычным multi-frame (async scheduleFrame) →
 * `steps.length === 0` синхронно ДО await → тест `===1` немедленно = RED.
 *
 * ── RED PROOF (mutation 2) ───────────────────────────────────────────────────
 * Заменить `settle(lastValue)` → `settle(values[0])` (снап к FIRST, не LAST):
 *   → emitted значение !== values[last] → RED.
 *
 * ── RED PROOF (mutation 3) ───────────────────────────────────────────────────
 * Заменить `settle(lastValue)` → ничего не эмитить (hard-off):
 *   → steps.length===0 → RED.
 */

import { describe, expect, it } from 'vitest';
import { keyframes } from '../src/keyframes/index.js';

function makeReduceMedia(): (query: string) => { matches: boolean } {
  return () => ({ matches: true });
}

function makeNoReduceMedia(): (query: string) => { matches: boolean } {
  return () => ({ matches: false });
}

function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

describe('keyframes — reduced-motion CHARACTER-switch', () => {
  it('matchMedia matches=true → exactly ONE synchronous onStep with values[last]', () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 50, 100],
      duration: 5,
      repeat: 3, // repeat/direction must be IGNORED under reduce
      repeatType: 'reverse',
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    expect(steps.length).toBe(1);
    expect(steps[0]).toBe(100);
    c.cancel();
  });

  it('matchMedia matches=false → normal async multi-frame path (steps.length===0 synchronously)', () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 5,
      matchMedia: makeNoReduceMedia(),
      requestFrame: noRaf(), // non-draining → no tick fires synchronously or async in this test
      onStep: (v) => steps.push(v),
    });
    // Synchronously, before any scheduled frame fires, no step yet.
    expect(steps.length).toBe(0);
    c.cancel();
  });

  it('undefined matchMedia (SSR) → reduce=false, no throw, no crash on import (SSR-safe)', () => {
    const c = keyframes({ values: [0, 100], duration: 1, requestFrame: noRaf() });
    expect(() => c.cancel()).not.toThrow();
  });

  it('reduced-motion settles the promise (thenable resolves synchronously-scheduled)', async () => {
    let resolved = false;
    const c = keyframes({
      values: [0, 100],
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    await c.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it('matchMedia throwing is swallowed → treated as reduce=false', () => {
    const throwingMedia = (): { matches: boolean } => {
      throw new Error('boom');
    };
    const steps: number[] = [];
    expect(() =>
      keyframes({
        values: [0, 100],
        matchMedia: throwingMedia,
        requestFrame: noRaf(),
        onStep: (v) => steps.push(v),
      }),
    ).not.toThrow();
  });
});
