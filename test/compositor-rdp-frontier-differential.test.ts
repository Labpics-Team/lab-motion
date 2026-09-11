import { describe, expect, it } from 'vitest';
import { douglasPeuckerVertical } from '../src/compositor/segmenter.js';
import { solveSpring } from '../src/internal/solver.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';

/**
 * До рефакторинга на монотонный фронтир RDP отмечал сохранённые индексы bitmap,
 * хранил обе границы каждого отложенного интервала и в конце сканировал всю
 * исходную сетку. Это независимый эталон смены представления состояния:
 * формула отклонения намеренно оставлена прежней.
 */
function bitmapReference(
  xs: readonly number[],
  ys: readonly number[],
  eps: number,
  protectedIndex = -1,
): number[] {
  const n = xs.length;
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const hasProtected = protectedIndex > 0 && protectedIndex < n - 1;
  if (hasProtected) keep[protectedIndex] = 1;
  const stack = hasProtected
    ? [0, protectedIndex, protectedIndex, n - 1]
    : [0, n - 1];

  while (stack.length > 0) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j <= i + 1) continue;
    const xi = xs[i]!;
    const yi = ys[i]!;
    const slope = (ys[j]! - yi) / (xs[j]! - xi);
    let maxDev = -1;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const lineY = yi + slope * (xs[k]! - xi);
      const dev = Math.abs(ys[k]! - lineY);
      if (dev > maxDev) {
        maxDev = dev;
        idx = k;
      }
    }
    if (maxDev > eps) {
      keep[idx] = 1;
      stack.push(i, idx, idx, j);
    }
  }

  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k] === 1) out.push(k);
  return out;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('RDP композитора: монотонный фронтир эквивалентен bitmap', () => {
  it('защищённая касательная обязательна даже на идеально прямой кривой', () => {
    const xs = [0, 0.25, 0.5, 0.75, 1];
    const ys = xs.map((x) => 1 + 2 * x);
    expect(douglasPeuckerVertical(xs, ys, 1e-12, 2)).toEqual([0, 2, 4]);
    expect(douglasPeuckerVertical(xs, ys, 1e-12)).toEqual([0, 4]);
  });

  it('детерминированный неравномерный корпус сохраняет точные индексы с защищённым узлом и без него', () => {
    const random = rng(0x52d0_2026);
    let checks = 0;
    for (let caseIndex = 0; caseIndex < 1800; caseIndex++) {
      const n = 3 + Math.floor(random() * 254);
      const xs = new Array<number>(n);
      const ys = new Array<number>(n);
      let x = 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) x += 1e-4 + random() * 2;
        xs[i] = x;
        const phase = x * (0.05 + (caseIndex % 11) * 0.03);
        ys[i] = Math.sin(phase) * (0.2 + random() * 2)
          + 0.001 * x * x
          + (random() - 0.5) * 0.02;
      }
      const eps = 10 ** (-5 + random() * 3.3);
      const protectedIndex = caseIndex % 3 === 0
        ? -1
        : 1 + Math.floor(random() * (n - 2));
      expect(douglasPeuckerVertical(xs, ys, eps, protectedIndex)).toEqual(
        bitmapReference(xs, ys, eps, protectedIndex),
      );
      checks++;
    }
    expect(checks).toBe(1800);
  });

  it('производственные пружинные сетки с промежуточной опорой остаются точными', () => {
    const random = rng(0x228_2026);
    let checks = 0;
    for (let caseIndex = 0; caseIndex < 240; caseIndex++) {
      const params: SpringParams = {
        mass: 0.2 + random() * 4.8,
        stiffness: 5 + random() * 850,
        damping: 0.5 + random() * 100,
      };
      const v0 = (random() - 0.5) * 30;
      const horizon = settleTimeUpperBound(params, v0);
      if (!Number.isFinite(horizon) || horizon <= 0) continue;
      const intervals = [32, 64, 128, 256][caseIndex % 4]!;
      const xs = new Array<number>(intervals + 2);
      const ys = new Array<number>(intervals + 2);
      xs[0] = ys[0] = 0;
      const tangentTau = 0.5 / intervals;
      xs[1] = tangentTau;
      ys[1] = v0 * (tangentTau * horizon);
      for (let i = 1; i <= intervals; i++) {
        const tau = i / intervals;
        xs[i + 1] = tau;
        const value = solveSpring(params, tau * horizon, v0).value;
        ys[i + 1] = Number.isFinite(value) ? value : 1;
      }
      const eps = [0.000125, 0.0005, 0.00125, 0.0025][caseIndex % 4]!;
      expect(douglasPeuckerVertical(xs, ys, eps, 1)).toEqual(
        bitmapReference(xs, ys, eps, 1),
      );
      checks++;
    }
    expect(checks).toBeGreaterThan(200);
  });

  it('n≤2 сохраняет прежний контракт', () => {
    for (const [xs, ys] of [
      [[], []],
      [[0], [1]],
      [[0, 1], [0, 1]],
    ] as const) {
      expect(douglasPeuckerVertical(xs, ys, 1e-3, 1)).toEqual(
        bitmapReference(xs, ys, 1e-3, 1),
      );
    }
  });
});