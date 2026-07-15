/** Общий аналитический базис пружины: дифференциал физики и массовый пакет. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate as animateBase } from '../src/animate/index.js';
import { withLiveEngine } from './animate-facade-helpers.js';

// Харнесс R3b: rAF-пути исполняет композируемый live-движок (см. helpers).
const animate = withLiveEngine(animateBase as never);
import {
  readSpringFromBasisUnchecked,
  sampleSpringFromBasisUnchecked,
} from '../src/internal/read-spring.js';
import {
  sampleSpringBasisUnchecked,
  type MutableSpringBasis,
} from '../src/internal/solver.js';
import { readSpringUnchecked, sampleSpringUnchecked } from '../src/internal/read-spring.js';
import type { SpringParams } from '../src/spring.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const SPRINGS: readonly SpringParams[] = [
  { mass: 1, stiffness: 170, damping: 10 },
  { mass: 1, stiffness: 170, damping: 2 * Math.sqrt(170) },
  { mass: 1, stiffness: 170, damping: 40 },
];

function basis(): MutableSpringBasis {
  return { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };
}

function close(actual: number, expected: number, context?: string): void {
  const tolerance = 1e-11 * Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected), context).toBeLessThanOrEqual(tolerance);
}

afterEach(() => vi.restoreAllMocks());

describe('shared analytic spring basis', () => {
  it('воспроизводит value/velocity всех режимов при разных v0 и t', () => {
    const state = { value: 0, velocity: 0 };
    const normalized = { value: 0, velocity: 0 };
    const shared = basis();
    for (const spring of SPRINGS) {
      for (const t of [0, Number.MIN_VALUE, 1 / 240, 0.017, 0.3, 2, 32]) {
        sampleSpringBasisUnchecked(spring, t, shared);
        for (const v0 of [-100, -3, -0, 0, 2.5, 100]) {
          const expected = sampleSpringUnchecked(spring, v0, t);
          sampleSpringFromBasisUnchecked(shared, v0, normalized);
          close(normalized.value, expected.value);
          close(normalized.velocity, expected.velocity);

          const ranged = readSpringUnchecked(spring, -120, 340, v0, t);
          readSpringFromBasisUnchecked(shared, -120, 340, v0, state);
          close(state.value, ranged.value);
          close(state.velocity, ranged.velocity);
        }
      }
    }
  });

  it('сохраняет точные начальные условия и finite-policy на IEEE-754 краях', () => {
    const shared = basis();
    const out = { value: 0, velocity: 0 };
    for (const spring of SPRINGS) {
      sampleSpringBasisUnchecked(spring, 0, shared);
      for (const v0 of [-100, -0, 0, 100]) {
        sampleSpringFromBasisUnchecked(shared, v0, out);
        expect(out.value).toBe(0);
        expect(out.velocity).toBe(v0);
      }
      for (const t of [Number.MIN_VALUE, 1 / 240, 32, Infinity, NaN]) {
        sampleSpringBasisUnchecked(spring, t, shared);
        for (const v0 of [-Number.MAX_VALUE, Number.MAX_VALUE]) {
          readSpringFromBasisUnchecked(
            shared,
            -Number.MAX_VALUE,
            Number.MAX_VALUE,
            v0,
            out,
          );
          expect(Number.isFinite(out.value)).toBe(true);
          expect(Number.isFinite(out.velocity)).toBe(true);
        }
      }
    }
  });

  it('сохраняет независимый физический предел при субнормальном времени и предельной скорости', () => {
    const shared = basis();
    const actual = { value: 0, velocity: 0 };
    for (const spring of SPRINGS) {
      for (const t of [Number.MIN_VALUE, 1e-300, 1e-200, 1e-16]) {
        sampleSpringBasisUnchecked(spring, t, shared);
        for (const v0 of [-Number.MAX_VALUE, Number.MAX_VALUE]) {
          sampleSpringFromBasisUnchecked(shared, v0, actual);
          const context = `spring=${JSON.stringify(spring)}, t=${t}, v0=${v0}`;
          expect(Number.isFinite(actual.value), `value finite: ${context}`).toBe(true);
          expect(Number.isFinite(actual.velocity), `velocity finite: ${context}`).toBe(true);
          close(actual.velocity / v0, 1, `velocity/v0: ${context}`);
          close(actual.value, v0 * t, `value≈v0*t: ${context}`);
        }
      }
    }
  });

  // @todo-R3c: main-lane: basis-шеринг SurfaceBatch мёртвого rAF-фасада; батч live-движка — R3c
  it.skip('N=1000 homogeneous main batch считает exp/sin/cos один раз на кадр', () => {
    const exp = vi.spyOn(Math, 'exp');
    const sin = vi.spyOn(Math, 'sin');
    const cos = vi.spyOn(Math, 'cos');
    const clock = makeClock();
    const controls = animate(
      Array.from({ length: 1000 }, () => fakeEl().el),
      { x: [0, 100] },
      {
        spring: SPRINGS[0],
        requestFrame: clock.requestFrame,
      },
    );

    clock.step(16); // t=0: точные начальные условия, трансцендентные функции не нужны
    exp.mockClear();
    sin.mockClear();
    cos.mockClear();
    clock.step(16);

    expect(exp).toHaveBeenCalledTimes(1);
    expect(sin).toHaveBeenCalledTimes(1);
    expect(cos).toHaveBeenCalledTimes(1);
    controls.cancel();
  });

});
