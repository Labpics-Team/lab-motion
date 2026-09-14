import { describe, expect, it } from 'vitest';
import { clamp01, finite, lerp1 } from '../src/projection/geometry.js';

function boundReference(value: number, first: number, last: number): number {
  const lo = Math.min(finite(first), finite(last));
  const hi = Math.max(finite(first), finite(last));
  return value < lo ? lo : value > hi ? hi : value;
}

function pageSpaceReference(
  first: number,
  last: number,
  p: number,
  normalizedCorrection: number,
  q: number,
): number {
  const range = last - first;
  const pageCorrection = range * normalizedCorrection;
  return boundReference(
    finite(lerp1(first, last, p) + pageCorrection * q) + 0,
    first,
    last,
  );
}

function normalizedCandidate(
  first: number,
  last: number,
  p: number,
  normalizedCorrection: number,
  q: number,
): number {
  return lerp1(first, last, clamp01(p + normalizedCorrection * q));
}

describe('normalized clamp IEEE-754 falsifier', () => {
  it('preserves the physical endpoint when normalized progress saturates', () => {
    const first = 88339.125913;
    const last = Number.MIN_VALUE;
    const p = 0.5;
    const normalizedCorrection = 1;
    const q = 1;

    const reference = pageSpaceReference(first, last, p, normalizedCorrection, q);
    const candidate = normalizedCandidate(first, last, p, normalizedCorrection, q);

    expect(reference).toBe(last);
    expect(candidate).toBe(reference);
  });

  it('never escapes the finite [first,last] envelope on hostile finite ranges', () => {
    const large = [1e2, 1e10, 1e50, 1e100, 1e200, 1e300];
    const tiny = [Number.MIN_VALUE, 2 ** -1000, 1e-300, 1e-200, 1e-100, 1e-30];
    const probes = [
      { p: 0.5, correction: 1, q: 1 },
      { p: 0.75, correction: 2, q: 1 },
      { p: 0.25, correction: -2, q: 1 },
      { p: 0.5, correction: 1, q: 4 },
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
              const lo = Math.min(first, last);
              const hi = Math.max(first, last);
              if (!(value >= lo && value <= hi)) {
                violations.push({ first, last, range, value, ...probe });
              }
            }
          }
        }
      }
    }

    expect(violations, JSON.stringify(violations.slice(0, 8), null, 2)).toEqual([]);
  });
});
