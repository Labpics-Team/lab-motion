import { describe, expect, it } from 'vitest';
import {
  baseGridSize,
  fitsSpringCurveBudget,
  tryBuildAdaptiveSpringGrid,
  tryBuildSpringNodes,
} from '../src/compositor/segmenter.js';
import { solveSpring } from '../src/internal/solver.js';
import type { SpringParams } from '../src/spring.js';

function lerpAt(xs: readonly number[], ys: readonly number[], x: number): number {
  let hi = 1;
  while (hi < xs.length - 1 && x > xs[hi]!) hi++;
  const x0 = xs[hi - 1]!;
  const x1 = xs[hi]!;
  return ys[hi - 1]! + ((ys[hi]! - ys[hi - 1]!) * (x - x0)) / (x1 - x0);
}

describe('compositor local-energy grid regression', () => {
  const zetas = [0.05, 0.3, 0.5, 1, 2, 5] as const;
  const v0s = [0, 3, -3] as const;
  const tolerances = [1 / 400, 1e-3, 2.5e-4] as const;

  it('держит собственную непрерывную ошибку сетки <= tolerance/2', () => {
    let checked = 0;
    let worstRatio = 0;
    for (const zeta of zetas) {
      const params: SpringParams = { mass: 1, stiffness: 100, damping: 20 * zeta };
      for (const v0 of v0s) {
        for (const tolerance of tolerances) {
          if (!fitsSpringCurveBudget(params, v0, tolerance)) continue;
          const built = tryBuildSpringNodes(params, v0, tolerance);
          expect(built).toBeDefined();
          const T = built![1];
          const grid = tryBuildAdaptiveSpringGrid(params, v0, tolerance, T);
          expect(grid).toBeDefined();
          const [xs, ys] = grid!;
          let worst = 0;
          for (let i = 1; i < xs.length; i++) {
            const a = xs[i - 1]!;
            const width = xs[i]! - a;
            for (const q of [0.25, 0.5, 0.75]) {
              const tau = a + width * q;
              worst = Math.max(
                worst,
                Math.abs(lerpAt(xs, ys, tau) - solveSpring(params, tau * T, v0).value),
              );
            }
          }
          expect(worst).toBeLessThanOrEqual(tolerance / 2 * (1 + 1e-9));
          worstRatio = Math.max(worstRatio, worst / (tolerance / 2));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    // Positive control против пустого/чрезмерно консервативного corpus.
    expect(worstRatio).toBeGreaterThan(0.1);
  });

  it('RDP расходует не больше 3tolerance/8 поверх adaptive grid', () => {
    let checked = 0;
    for (const zeta of zetas) {
      const params: SpringParams = { mass: 1, stiffness: 100, damping: 20 * zeta };
      for (const tolerance of tolerances) {
        if (!fitsSpringCurveBudget(params, 0, tolerance)) continue;
        const built = tryBuildSpringNodes(params, 0, tolerance);
        expect(built).toBeDefined();
        const [nodes, T] = built!;
        const [xs, ys] = tryBuildAdaptiveSpringGrid(params, 0, tolerance, T)!;
        const keptXs = nodes.map((node) => node.percent / 100);
        const keptYs = nodes.map((node, i) =>
          i === nodes.length - 1 ? ys[ys.length - 1]! : node.progress);
        let worst = 0;
        for (let i = 0; i < xs.length; i++) {
          worst = Math.max(worst, Math.abs(lerpAt(keptXs, keptYs, xs[i]!) - ys[i]!));
        }
        expect(worst).toBeLessThanOrEqual(tolerance * 3 / 8 + 1e-12);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('сокращает pre-RDP работу без расширения representability boundary', () => {
    let globalIntervals = 0;
    let adaptiveIntervals = 0;
    let checked = 0;

    for (const zeta of zetas) {
      const params: SpringParams = { mass: 1, stiffness: 100, damping: 20 * zeta };
      for (const v0 of v0s) {
        const tolerance = 1 / 400;
        if (!fitsSpringCurveBudget(params, v0, tolerance)) continue;
        const built = tryBuildSpringNodes(params, v0, tolerance)!;
        const T = built[1];
        globalIntervals += baseGridSize(params, T, tolerance, v0);
        adaptiveIntervals += tryBuildAdaptiveSpringGrid(params, v0, tolerance, T)![0].length - 2;
        checked++;
      }
    }

    expect(checked).toBeGreaterThan(5);
    expect(adaptiveIntervals).toBeLessThan(globalIntervals / 2);

    // Существующий внешний контрпример остаётся fail-closed: оптимизация sampling
    // не превращается в незаявленное расширение публичной семантики.
    const under: SpringParams = { mass: 1, stiffness: 100, damping: 10 };
    expect(fitsSpringCurveBudget(under, 10_000, 1 / 400)).toBe(false);
    expect(tryBuildSpringNodes(under, 10_000, 1 / 400)).toBeUndefined();
  });
});
