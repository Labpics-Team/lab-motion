/**
 * Денормализованное чтение уже валидированной пружины.
 *
 * Публичные границы проверяют params/from/to/v0/t один раз до запуска.
 * Кадровые циклы зовут этот seam, чтобы не повторять settle-расчёт на
 * каждом кадре. Финитная политика остаётся единой: сбой позиции → цель,
 * сбой скорости → покой, переполнение денормализации → цель/покой.
 */

import { solveSpring, type MutableSpringBasis } from './solver.js';
import type { SpringParams } from './types.js';

export type { MutableSpringBasis } from './solver.js';

export interface MutableSpringState {
  value: number;
  velocity: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * solveSpring пишет два поля. Отдельный модульный scratch не даёт этим
 * промежуточным нормализованным записям попасть в caller-owned accessor/Proxy
 * и сохраняет hot-path без аллокации. Солвер синхронен и после чтения params не
 * вызывает пользовательский код; перед записью наружу оба результата сняты в
 * локальные скаляры, поэтому re-entrant setter также не может их испортить.
 */
const scratch: MutableSpringState = { value: 0, velocity: 0 };

/** @internal Восстанавливает нормализованный канал из общего базиса. */
export function sampleSpringFromBasisUnchecked(
  basis: MutableSpringBasis,
  v0: number,
  out: MutableSpringState,
): MutableSpringState {
  const value = finiteOr(basis._value + v0 * basis._valueV0, 1);
  const velocity = finiteOr(basis._velocity + v0 * basis._velocityV0, 0);
  out.value = value;
  out.velocity = velocity;
  return out;
}

/** @internal Денормализует канал из общего базиса с единой finite-политикой. */
export function readSpringFromBasisUnchecked(
  basis: MutableSpringBasis,
  from: number,
  to: number,
  v0: number,
  out: MutableSpringState,
): MutableSpringState {
  const normalizedValue = finiteOr(basis._value + v0 * basis._valueV0, 1);
  const normalizedVelocity = finiteOr(basis._velocity + v0 * basis._velocityV0, 0);
  const range = to - from;
  out.value = finiteOr(from + normalizedValue * range, to);
  out.velocity = finiteOr(normalizedVelocity * range, 0);
  return out;
}

/** @internal Входы обязаны быть проверены на внешней границе. */
export function sampleSpringUnchecked(
  spring: SpringParams,
  v0: number,
  t: number,
  out?: MutableSpringState,
): MutableSpringState {
  solveSpring(spring, t, v0, scratch);
  const value = finiteOr(scratch.value, 1);
  const velocity = finiteOr(scratch.velocity, 0);
  if (out === undefined) return { value, velocity };
  const state = out;
  state.value = value;
  state.velocity = velocity;
  return state;
}

/** @internal Денормализует тот же нормализованный сэмпл без повтора политики. */
export function readSpringUnchecked(
  spring: SpringParams,
  from: number,
  to: number,
  v0: number,
  t: number,
  out?: MutableSpringState,
): MutableSpringState {
  solveSpring(spring, t, v0, scratch);
  const normalizedValue = finiteOr(scratch.value, 1);
  const normalizedVelocity = finiteOr(scratch.velocity, 0);
  const range = to - from;
  const value = finiteOr(from + normalizedValue * range, to);
  const velocity = finiteOr(normalizedVelocity * range, 0);
  if (out === undefined) return { value, velocity };
  const state = out;
  state.value = value;
  state.velocity = velocity;
  return state;
}
