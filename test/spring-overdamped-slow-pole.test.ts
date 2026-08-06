import { describe, expect, it } from 'vitest';

import { makeSpringValueSampler, solveSpring } from '../src/internal/solver.js';

/**
 * Issue #226. При ζ > 1/√ε (≈6.7e7) выражение √(ζ²−1) округляется ровно в ζ,
 * поэтому r_slow = −ω₀(ζ−√(ζ²−1)) вырождается в −0: медленный полюс исчезает,
 * и переход застывает на нуле вместо того, чтобы прийти в цель.
 *
 * Оракул здесь намеренно другой алгебры, а не та же формула в другой записи:
 * при ζ→∞ инерцией можно пренебречь, и c·ẋ + k·x = k даёт первый порядок
 * x(t) = 1 − e^{−(k/c)·t}. Относительная погрешность этого приближения
 * порядка r_slow/r_fast ≈ 1/(4ζ²), то есть 2.5e-17 на используемых входах —
 * заведомо ниже требуемой точности.
 */
describe('overdamped: медленный полюс не теряется на экстремальном ζ', () => {
  // ω₀ = 1e9, ζ = 1e8, k/c = 5 → t=0.1 это ровно половина постоянной времени.
  const params = { mass: 1, stiffness: 1e18, damping: 2e17 };
  const firstOrder = (t: number) => -Math.expm1(-(params.stiffness / params.damping) * t);

  it('solveSpring попадает в первопорядковый предел', () => {
    for (const t of [0.02, 0.1, 0.5, 1]) {
      const { value } = solveSpring(params, t, 0);
      expect(value).toBeCloseTo(firstOrder(t), 9);
    }
  });

  it('makeSpringValueSampler согласован с solveSpring', () => {
    const sample = makeSpringValueSampler(params, 0);
    for (const t of [0.02, 0.1, 0.5, 1]) {
      expect(sample(t)).toBeCloseTo(firstOrder(t), 9);
    }
  });

  it('скорость конечна и совпадает с производной предела', () => {
    const { velocity } = solveSpring(params, 0.1, 0);
    const expected = (params.stiffness / params.damping) * Math.exp(-0.5);
    expect(Number.isFinite(velocity)).toBe(true);
    expect(velocity).toBeCloseTo(expected, 6);
  });

  it('масштабная инвариантность: (λm, λk, λc) даёт ту же траекторию', () => {
    const reference = solveSpring(params, 0.1, 0).value;
    for (const lambda of [1e-12, 1e-6, 1, 1e6, 1e12]) {
      const scaled = {
        mass: lambda * params.mass,
        stiffness: lambda * params.stiffness,
        damping: lambda * params.damping,
      };
      expect(solveSpring(scaled, 0.1, 0).value).toBeCloseTo(reference, 12);
    }
  });

  it('переход монотонно доходит до цели на всём диапазоне ζ', () => {
    for (const zeta of [2, 1e3, 1e6, 1e8, 1e10, 1e12]) {
      // ω₀ = 1 при m=k=1, тогда c = 2ζ и постоянная времени k/c = 1/(2ζ).
      const p = { mass: 1, stiffness: 1, damping: 2 * zeta };
      const tau = (2 * zeta) / 1;
      const early = solveSpring(p, tau * 0.5, 0).value;
      const late = solveSpring(p, tau * 5, 0).value;
      expect(early).toBeGreaterThan(0.3);
      expect(late).toBeGreaterThan(0.99);
      expect(late).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});
