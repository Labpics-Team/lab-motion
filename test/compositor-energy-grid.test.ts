import { describe, expect, it } from 'vitest';
import {
  BASE_GRID_MAX,
  baseGridSize,
  tryBuildAdaptiveSpringGrid,
  tryBuildSpringNodes,
} from '../src/compositor/segmenter.js';
import { CONVERGENCE_THRESHOLD } from '../src/internal/constants.js';
import { solveSpring } from '../src/internal/solver.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';

function horizon(params: SpringParams, v0: number, tolerance: number): number {
  const settle = settleTimeUpperBound(params, v0);
  const omega2 = params.stiffness / params.mass;
  const alpha = params.damping / (2 * params.mass);
  const delta = omega2 - alpha * alpha;
  const rate = delta >= 0 ? alpha : omega2 / (alpha + Math.sqrt(-delta));
  return settle + Math.max(0, Math.log(CONVERGENCE_THRESHOLD * 16 / tolerance)) / rate;
}

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
    let worstRatio = 0;
    for (const zeta of zetas) {
      const params: SpringParams = { mass: 1, stiffness: 100, damping: 20 * zeta };
      for (const v0 of v0s) {
        for (const tolerance of tolerances) {
          const T = horizon(params, v0, tolerance);
          const grid = tryBuildAdaptiveSpringGrid(params, v0, tolerance, T);
          expect(grid, `ζ=${zeta} v0=${v0} tol=${tolerance}`).toBeDefined();
          const [xs, ys] = grid!;
          let worst = 0;
          for (let i = 1; i < xs.length; i++) {
            const mid = (xs[i - 1]! + xs[i]!) / 2;
            worst = Math.max(
              worst,
              Math.abs(lerpAt(xs, ys, mid) - solveSpring(params, mid * T, v0).value),
            );
          }
          expect(worst).toBeLessThanOrEqual(tolerance / 2 * (1 + 1e-9));
          worstRatio = Math.max(worstRatio, worst / (tolerance / 2));
        }
      }
    }
    expect(worstRatio).toBeGreaterThan(0.2);
  });

  it('production RDP расходует не больше 3tolerance/8', () => {
    for (const zeta of zetas) {
      const params: SpringParams = { mass: 1, stiffness: 100, damping: 20 * zeta };
      for (const tolerance of tolerances) {
        const T = horizon(params, 0, tolerance);
        const [xs, ys] = tryBuildAdaptiveSpringGrid(params, 0, tolerance, T)!;
        const nodes = tryBuildSpringNodes(params, 0, tolerance)![0];
        const keptXs = nodes.map((node) => node.percent / 100);
        const keptYs = nodes.map((node, i) =>
          i === nodes.length - 1 ? ys[ys.length - 1]! : node.progress);
        let worst = 0;
        for (let i = 0; i < xs.length; i++) {
          worst = Math.max(worst, Math.abs(lerpAt(keptXs, keptYs, xs[i]!) - ys[i]!));
        }
        expect(worst).toBeLessThanOrEqual(tolerance * 3 / 8 + 1e-12);
      }
    }
  });

  it('возвращает compositor coverage для high-velocity representable spring', () => {
    const params: SpringParams = { mass: 1, stiffness: 100, damping: 10 };
    const v0 = 10_000;
    const tolerance = 1 / 400;
    const built = tryBuildSpringNodes(params, v0, tolerance);
    expect(built).toBeDefined();
    expect(baseGridSize(params, built![1], tolerance, v0)).toBeLessThanOrEqual(BASE_GRID_MAX);
  });
});
