import { describe, expect, it } from 'vitest';
import { clamp01, finite, lerp1 } from '../src/projection/geometry.js';

function normalizedCandidate(
  first: number,
  last: number,
  p: number,
  normalizedCorrection: number,
  q: number,
): number {
  return lerp1(first, last, clamp01(p + normalizedCorrection * q));
}

function inClosedInterval(value: number, a: number, b: number): boolean {
  const lo = Math.min(finite(a), finite(b));
  const hi = Math.max(finite(a), finite(b));
  return value >= lo && value <= hi;
}

describe('normalized clamp IEEE-754 contract', () => {
  it('anchors saturated progress to the physical endpoint bit-exactly', () => {
    const endpoints = [
      [100, Number.MIN_VALUE],
      [Number.MIN_VALUE, 100],
      [-100, -Number.MIN_VALUE],
      [-Number.MIN_VALUE, -100],
      [1e300, 1e-300],
      [1e-300, 1e300],
    ] as const;

    for (const [first, last] of endpoints) {
      expect(normalizedCandidate(first, last, 0.5, 1, 1)).toBe(finite(last) + 0);
      expect(normalizedCandidate(first, last, 0.5, -1, 1)).toBe(finite(first) + 0);
    }
  });

  it('never escapes the finite [first,last] envelope on hostile finite ranges', () => {
    const large = [1e2, 1e10, 1e50, 1e100, 1e200, 1e300];
    const tiny = [Number.MIN_VALUE, 2 ** -1000, 1e-300, 1e-200, 1e-100, 1e-30];
    const probes = [
      { p: 0.5, correction: 1, q: 1 },
      { p: 0.75, correction: 2, q: 1 },
      { p: 0.25, correction: -2, q: 1 },
      { p: 0.5, correction: 1, q: 4 },
      { p: 0.25, correction: 0.125, q: 1 },
      { p: 0.75, correction: -0.125, q: 1 },
    ];
    const violations: Array<Record<string, number>> = [];

    for (const sign of [1, -1]) {
      for (const a of large) {
        for (const b of tiny) {
          for (const probe of probes) {
            for (const [first0, last0] of [[a, b], [b, a]] as const) {
              const first = sign * first0;
              const last = sign * last0;
              const range = last - first;
              if (!Number.isFinite(range) || range === 0) continue;
              const value = normalizedCandidate(first, last, probe.p, probe.correction, probe.q);
              if (!inClosedInterval(value, first, last)) {
                violations.push({ first, last, range, value, ...probe });
              }
            }
          }
        }
      }
    }

    expect(violations, JSON.stringify(violations.slice(0, 8), null, 2)).toEqual([]);
  });

  it('keeps exact endpoint semantics for signed zero and finite hostile endpoints', () => {
    expect(Object.is(lerp1(-0, 7, 0), 0)).toBe(true);
    expect(lerp1(7, Number.MIN_VALUE, 1)).toBe(Number.MIN_VALUE);
    expect(lerp1(-7, -Number.MIN_VALUE, 1)).toBe(-Number.MIN_VALUE);
  });
});
