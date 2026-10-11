/**
 * Денормализованное чтение уже валидированной пружины.
 *
 * Публичные границы проверяют params/from/to/v0/t один раз до запуска.
 * Кадровые циклы зовут этот seam, чтобы не повторять settle-расчёт на
 * каждом кадре. Финитная политика остаётся единой: сбой позиции → цель,
 * сбой скорости → покой, переполнение денормализации → цель/покой.
 */

import { solveSpring, sampleSpringBasisUnchecked, type MutableSpringBasis } from './solver.js';
import { finiteOr } from './finite.js';
import type { SpringParams } from './types.js';

export interface MutableSpringState {
  value: number;
  velocity: number;
}

/**
 * solveSpring пишет два поля. Отдельный модульный scratch не даёт этим
 * промежуточным нормализованным записям попасть в caller-owned accessor/Proxy
 * и сохраняет hot-path без аллокации. Солвер синхронен и после чтения params не
 * вызывает пользовательский код; перед записью наружу оба результата сняты в
 * локальные скаляры, поэтому re-entrant setter также не может их испортить.
 */
const scratch: MutableSpringState = { value: 0, velocity: 0 };

/** @internal Заимствованный результат действителен до следующего вызова этого модуля. */
export function sampleSpringFromBasisUnchecked(
  basis: Readonly<MutableSpringBasis>,
  v0: number,
): Readonly<MutableSpringState> {
  const value = finiteOr(basis._value + v0 * basis._valueV0, 1);
  const velocity = finiteOr(basis._velocity + v0 * basis._velocityV0, 0);
  scratch.value = value;
  scratch.velocity = velocity;
  return scratch;
}

/** @internal Та же finite-политика; заимствованный результат потребляется до host-call. */
export function readSpringFromBasisUnchecked(
  basis: Readonly<MutableSpringBasis>,
  from: number,
  to: number,
  v0: number,
): Readonly<MutableSpringState> {
  sampleSpringFromBasisUnchecked(basis, v0);
  const range = to - from;
  scratch.value = finiteOr(from + scratch.value * range, to);
  scratch.velocity = finiteOr(scratch.velocity * range, 0);
  return scratch;
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

interface Projection extends MutableSpringBasis {
  _mass?: number;
  _stiffness?: number;
  _damping?: number;
  _time?: number;
}
const projections = new WeakMap<object, Projection>();

/** Ключ снимает физические параметры; вызывающий не может изменить кэш задним числом. */
export function springBasis(owner: object, spring: SpringParams, time: number): Readonly<MutableSpringBasis> {
  let state = projections.get(owner);
  if (!state) {
    state = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };
    projections.set(owner, state);
  }
  const { mass, stiffness, damping } = spring;
  if (time !== state._time || mass !== state._mass || stiffness !== state._stiffness || damping !== state._damping) {
    sampleSpringBasisUnchecked(spring, time, state);
    state._mass = mass; state._stiffness = stiffness; state._damping = damping; state._time = time;
  }
  return state;
}
