/**
 * compositor/segmenter.ts — сертифицированное преобразование пружины в CSS linear().
 *
 * Представимость остаётся прежним O(1)-контрактом по глобальной оценке худшего
 * случая: он решает, может ли compositor принять spring до supersede. Внутри
 * уже принятого бюджета фактическая сетка строится локальным сертифицированным
 * шагом, чтобы не пересэмплировать спокойный хвост по стартовой кривизне.
 */

import { MotionParamError } from '../errors.js';
import { CONVERGENCE_THRESHOLD } from '../internal/constants.js';
import { solveSpring } from '../internal/solver.js';
import {
  settleTimeUpperBound,
  type SpringParams,
} from '../spring.js';

export interface SpringNode {
  readonly progress: number;
  readonly percent: number;
}

const BASE_GRID_FLOOR = 24;
const BASE_GRID_MIN = 32;
export const BASE_GRID_MAX = 4096;
const gridSample = { value: 0, velocity: 0 };

/** Канонический горизонт текущего main; локальная сетка его не меняет. */
function springCompileHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
): number {
  const settle = settleTimeUpperBound(params, v0);
  const omega2 = params.stiffness / params.mass;
  const alpha = params.damping / (2 * params.mass);
  const delta = omega2 - alpha * alpha;
  const rate = delta >= 0 ? alpha : omega2 / (alpha + Math.sqrt(-delta));
  return settle + Math.max(0, Math.log(CONVERGENCE_THRESHOLD * 16 / tolerance)) / rate;
}

/**
 * Существующая предварительная fail-closed проверка. Это граница наблюдаемого
 * поведения, а не число узлов адаптивной сетки: оптимизация sampling не имеет
 * права незаметно расширять допустимую поверхность compositor.
 */
function requiredGridSize(
  params: SpringParams,
  settle: number,
  tolerance: number,
  v0: number,
): number {
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const curvature = settle * settle
    * (omega0 + params.damping / params.mass)
    * Math.hypot(v0, omega0);
  const raw = Math.sqrt(curvature / (2 * tolerance));
  return Math.max(BASE_GRID_MIN, Math.ceil(raw) + BASE_GRID_FLOOR);
}

/**
 * Строит сетку с переменным шагом и собственной ошибкой линейной интерполяции
 * <= tolerance/2. Вызывается только после прежней O(1)-границы представимости.
 *
 * u=ω₀t, y=x−1, w=dy/du. E=(y²+w²)/2 невозрастает, поэтому
 * sqrt(1+4ζ²)·hypot(y,w) ограничивает будущую |y''|. Для ζ>=1 используются
 * более тесные сертифицированные границы. Шаг выводится из M·h²/8 <= tolerance/2.
 */
export function tryBuildAdaptiveSpringGrid(
  params: SpringParams,
  v0: number,
  tolerance: number,
  settle: number,
): [xs: number[], ys: number[]] | undefined {
  if (!Number.isFinite(settle) || settle <= 0) return undefined;

  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const alpha = params.damping / (2 * params.mass);
  const zeta = alpha / omega0;
  const delta = omega0 * omega0 - alpha * alpha;
  const kappa = Math.sqrt(1 + 4 * zeta * zeta);
  const lambdaF = zeta + Math.sqrt(Math.max(0, zeta * zeta - 1));
  const lambdaS = 1 / lambdaF;
  const poleGap = lambdaF - lambdaS;
  const omegaT = omega0 * settle;
  const capTau = 1 / BASE_GRID_MIN;

  if (
    !Number.isFinite(omega0)
    || !(omega0 > 0)
    || !Number.isFinite(zeta)
    || !Number.isFinite(kappa)
    || !Number.isFinite(omegaT)
    || !(omegaT > 0)
  ) return undefined;

  const xs: number[] = [0];
  const ys: number[] = [0];
  let tau = 0;
  let y = -1;
  let w = v0 / omega0;
  if (!Number.isFinite(w)) return undefined;

  while (tau < 1) {
    let bound = kappa * Math.hypot(y, w);

    if (poleGap > 0) {
      const b = -(w + lambdaS * y) / poleGap;
      const a = y - b;
      const modal = Math.abs(a) * lambdaS * lambdaS + Math.abs(b) * lambdaF * lambdaF;
      if (!Number.isFinite(modal)) return undefined;
      bound = Math.min(bound, modal);
    } else if (delta === 0) {
      const critical = Math.abs(y + 2 * w) + Math.abs(w + y) / Math.E;
      if (!Number.isFinite(critical)) return undefined;
      bound = Math.min(bound, critical);
    }

    if (!Number.isFinite(bound) || bound < 0) return undefined;
    const step = bound > 0
      ? Math.min(capTau, 2 * Math.sqrt(tolerance / bound) / omegaT)
      : capTau;
    if (!Number.isFinite(step) || !(step > 0)) return undefined;

    if (tau === 0) {
      const anchorTau = step / 4;
      const anchor = v0 * anchorTau * settle;
      if (!Number.isFinite(anchorTau) || !Number.isFinite(anchor)) return undefined;
      xs.push(anchorTau);
      ys.push(anchor);
    }

    const next = Math.min(tau + step, 1);
    if (!Number.isFinite(next) || next === tau || xs.length > BASE_GRID_MAX) return undefined;

    const sampled = solveSpring(params, next * settle, v0, gridSample);
    if (!Number.isFinite(sampled.value) || !Number.isFinite(sampled.velocity)) return undefined;
    xs.push(next);
    ys.push(sampled.value);
    y = sampled.value - 1;
    w = sampled.velocity / omega0;
    if (!Number.isFinite(y) || !Number.isFinite(w)) return undefined;
    tau = next;
  }

  return [xs, ys];
}

/**
 * Историческое имя: возвращает бюджет представимости, а не число фактических
 * адаптивных интервалов. Это сохраняет существующий fail-closed контракт.
 */
export function baseGridSize(
  params: SpringParams,
  settle: number,
  tolerance: number,
  v0 = 0,
): number {
  const required = requiredGridSize(params, settle, tolerance, v0);
  if (!Number.isSafeInteger(required) || required > BASE_GRID_MAX) {
    throw new MotionParamError('LM016');
  }
  return required;
}

/** O(1)-проверка до supersede — поведение и стоимость текущего main сохранены. */
export function fitsSpringCurveBudget(
  params: SpringParams,
  v0: number,
  tolerance: number,
): boolean {
  const settle = springCompileHorizon(params, v0, tolerance);
  const required = requiredGridSize(params, settle, tolerance, v0);
  return Number.isSafeInteger(required) && required <= BASE_GRID_MAX;
}

export function assertSpringCurveBudget(
  params: SpringParams,
  v0: number,
  tolerance: number,
): void {
  baseGridSize(params, springCompileHorizon(params, v0, tolerance), tolerance, v0);
}

/** Вертикальный алгоритм Дугласа–Пекера для функции со строго растущими xs. */
export function douglasPeuckerVertical(
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
  const stack: number[] = hasProtected
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

export function buildSpringNodes(
  params: SpringParams,
  v0: number,
  tolerance: number,
): SpringNode[] {
  return buildSpringNodesWithHorizon(params, v0, tolerance)[0];
}

export function buildSpringNodesWithHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] {
  const built = tryBuildSpringNodes(params, v0, tolerance);
  if (built === undefined) throw new MotionParamError('LM016');
  return built;
}

export function tryBuildSpringNodes(
  params: SpringParams,
  v0: number,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] | undefined {
  const settle = springCompileHorizon(params, v0, tolerance);
  const required = requiredGridSize(params, settle, tolerance, v0);
  if (!Number.isSafeInteger(required) || required > BASE_GRID_MAX) return undefined;

  const grid = tryBuildAdaptiveSpringGrid(params, v0, tolerance, settle);
  if (grid === undefined) return undefined;

  const kept = douglasPeuckerVertical(
    grid[0],
    grid[1],
    tolerance * 3 / 8,
    1,
  );
  const xs = grid[0];
  const ys = grid[1];
  const nodes = kept.map((k, n): SpringNode => ({
    progress: n === kept.length - 1 ? 1 : ys[k]!,
    percent: xs[k]! * 100,
  }));
  return [nodes, settle];
}

export function buildRestingSpringNodesWithHorizon(
  params: SpringParams,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] {
  return buildSpringNodesWithHorizon(params, 0, tolerance);
}
