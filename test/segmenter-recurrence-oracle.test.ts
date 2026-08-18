import { describe, expect, it } from 'vitest';
import { makeSpringValueSampler } from '../src/internal/solver.js';
import type { SpringParams } from '../src/spring.js';

/**
 * RED-оракул #227 (шаг 1-2 из issue): root-matched recurrence обязана
 * воспроизводить аналитическую сетку с дрейфом на порядки ниже бюджета
 * реконструкции (tolerance/2). Референс НЕ использует production-коэффициенты:
 * S и P выводятся здесь независимо из полюсов (q₁+q₂, q₁q₂), а сравнение идёт
 * против makeSpringValueSampler — двух независимых форм одной ОДУ.
 */
const SWEEP: readonly [label: string, p: SpringParams, v0: number][] = [
  ['underdamped wobbly', { mass: 1, stiffness: 180, damping: 12 }, 0],
  ['underdamped v0=3', { mass: 1, stiffness: 180, damping: 12 }, 3],
  ['near-critical снизу', { mass: 1, stiffness: 100, damping: 19.99 }, 0],
  ['critical', { mass: 1, stiffness: 100, damping: 20 }, 1.5],
  ['near-critical сверху', { mass: 1, stiffness: 100, damping: 20.01 }, 0],
  ['overdamped ζ=2', { mass: 1, stiffness: 100, damping: 40 }, -2],
  ['stiff', { mass: 1, stiffness: 210, damping: 20 }, 0],
];

function recurrenceGrid(p: SpringParams, v0: number, T: number, n: number): number[] {
  const omega0 = Math.sqrt(p.stiffness / p.mass);
  const zeta = p.damping / (2 * p.mass * omega0);
  const h = T / n;
  let S: number;
  let P: number;
  if (zeta < 1) {
    const zw = zeta * omega0;
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    S = 2 * Math.exp(-zw * h) * Math.cos(omegaD * h);
    P = Math.exp(-2 * zw * h);
  } else if (zeta === 1) {
    const q = Math.exp(-omega0 * h);
    S = 2 * q;
    P = q * q;
  } else {
    const sqrtTerm = Math.sqrt(zeta * zeta - 1);
    const r2 = -omega0 * (zeta + sqrtTerm);
    const r1 = (omega0 * omega0) / r2;
    const q1 = Math.exp(r1 * h);
    const q2 = Math.exp(r2 * h);
    S = q1 + q2;
    P = q1 * q2;
  }
  const sample = makeSpringValueSampler(p, v0);
  const ys = new Array<number>(n + 1);
  ys[0] = 0;
  ys[1] = sample(h);
  // y = x − 1 удовлетворяет однородной ОДУ ⇒ рекуррентность точна для y.
  let prev = ys[0]! - 1;
  let curr = ys[1]! - 1;
  for (let i = 2; i <= n; i++) {
    const next = S * curr - P * prev;
    prev = curr;
    curr = next;
    ys[i] = 1 + next;
  }
  return ys;
}

describe('root-matched recurrence — независимый оракул против аналитики (#227)', () => {
  for (const [label, p, v0] of SWEEP) {
    it(`${label}: дрейф на сетках 256/1024/4096 << tolerance/2`, () => {
      const omega0 = Math.sqrt(p.stiffness / p.mass);
      const zeta = p.damping / (2 * p.mass * omega0);
      const slow = zeta >= 1 ? zeta - Math.sqrt(zeta * zeta - 1) : zeta;
      const T = Math.log(100) / (omega0 * Math.max(slow, 1e-6));
      const sample = makeSpringValueSampler(p, v0);
      for (const n of [256, 1024, 4096]) {
        const ys = recurrenceGrid(p, v0, T, n);
        let worst = 0;
        for (let i = 0; i <= n; i++) {
          const exact = sample((i / n) * T);
          const err = Math.abs(ys[i]! - exact);
          if (err > worst) worst = err;
        }
        // Бюджет реконструкции ≥ 1/400/2 = 1.25e-3; требуем запас ≥ 4 порядка.
        expect(worst).toBeLessThan(1e-7);
      }
    });
  }
});
