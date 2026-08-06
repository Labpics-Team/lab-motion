import { describe, expect, it } from 'vitest';

import { makeSpringValueSampler, solveSpring } from '../src/internal/solver.js';
import { settleTimeAtRestUpperBound, validateSpringParams } from '../src/spring.js';

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

  it('совпадает с модальным решением, построенным по корням Виета', () => {
    // Умеренное ζ = 2.5: здесь классическая формула корней устойчива, поэтому
    // годится как независимый оракул. Решение с x(0)=0, x'(0)=0, x(∞)=1:
    //   x(t) = 1 + (r_slow·e^{r_fast t} − r_fast·e^{r_slow t}) / (r_fast − r_slow)
    for (const exp of [-12, -6, 0, 6, 12]) {
      const lambda = Math.pow(10, exp);
      const p = { mass: lambda, stiffness: lambda * 4, damping: lambda * 10 };
      const alpha = p.damping / (2 * p.mass);
      const w2 = p.stiffness / p.mass;
      const split = Math.sqrt(alpha * alpha - w2);
      const rSlow = -(alpha - split);
      const rFast = -(alpha + split);
      // Тождества Виета — самостоятельная проверка корней оракула.
      expect(rSlow * rFast).toBeCloseTo(w2, 10);
      expect(rSlow + rFast).toBeCloseTo(-p.damping / p.mass, 10);

      for (const t of [0.5, 2, 8]) {
        const expected =
          1 + (rSlow * Math.exp(rFast * t) - rFast * Math.exp(rSlow * t)) / (rFast - rSlow);
        expect(solveSpring(p, t, 0).value).toBeCloseTo(expected, 10);
      }
    }
  });

  it('переход монотонно доходит до цели на всём диапазоне ζ', () => {
    // Сетка без разрывов вокруг порога вырождения 1/√ε ≈ 6.7e7: именно там
    // прямая разность ζ−√(ζ²−1) теряет все значащие цифры, и дыра в покрытии
    // между 1e6 и 1e8 оставила бы класс дефекта непришпиленным.
    for (const zeta of [2, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 6.7e7, 1e8, 1e9, 1e10, 1e12]) {
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

/**
 * Пользовательская часть #226: бюджет оседания считался тем же нестабильным
 * вычитанием, поэтому валидатор отвергал физически корректную пружину.
 */
describe('бюджет оседания и валидатор согласованы с солвером', () => {
  const params = { mass: 1, stiffness: 1e18, damping: 2e17 };

  it('бюджет конечен и отвечает медленной моде', () => {
    // Медленный полюс −k/c = −5 ⇒ время оседания порядка единиц секунд,
    // а не бесконечность, как давала выродившаяся разность.
    const budget = settleTimeAtRestUpperBound(params);
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(1);
    expect(budget).toBeLessThan(10);
  });

  it('публичная валидация принимает эту пружину', () => {
    expect(() => validateSpringParams(params)).not.toThrow();
  });

  it('прежние отказы остаются отказами', () => {
    for (const bad of [
      { mass: 100, stiffness: 100, damping: 2 },
      { mass: 0.25, stiffness: 0.01, damping: 0.11 },
      { mass: 1, stiffness: 1, damping: 0 },
    ]) {
      expect(() => validateSpringParams(bad)).toThrow();
    }
  });
});

/**
 * Граница домена. За ζ² > MAX_VALUE (ζ ≳ 1.34e154) и α² > MAX_VALUE полюса
 * вырождаются в любой из форм. Страховать это в горячем пути дорого по байтам
 * и незачем: такие параметры не проходят публичную валидацию. Тест закрепляет
 * именно fail-closed поведение, чтобы граница не съехала молча в «тихо неверно».
 */
describe('за границей домена валидация закрывается, а не врёт', () => {
  it('отвергает параметры, где ζ² или α² выходят за double', () => {
    for (const outOfDomain of [
      { mass: 1, stiffness: 1e-100, damping: 2e106 }, // ζ² > MAX_VALUE
      { mass: 1, stiffness: 1, damping: 4e154 }, // α² > MAX_VALUE
      { mass: 1e308, stiffness: 1e308, damping: 1e308 }, // 2·m > MAX_VALUE
    ]) {
      expect(settleTimeAtRestUpperBound(outOfDomain)).toBe(Infinity);
      expect(() => validateSpringParams(outOfDomain)).toThrow();
    }
  });
});

/**
 * Значение медленного корня, а не только его ненулевость. Без этого диверсия
 * вида 1/(ζ+d) → 2/(ζ+d) переживала весь прогон: бюджет оставался конечным,
 * и ни один тест не отличал верную ставку от вдвое завышенной.
 */
describe('медленная ставка пришпилена по величине', () => {
  const params = { mass: 1, stiffness: 1e18, damping: 2e17 };

  it('бюджет оседания отвечает физической ставке k/c', () => {
    // Независимый вывод: при ζ→∞ медленный полюс равен k/c, амплитудный член
    // стремится к 1, значит бюджет = ln(1/0.005) + ln(ω₀) делить на k/c.
    const omega0 = Math.sqrt(params.stiffness / params.mass);
    const expected = (Math.log(1 / 0.005) + Math.log(omega0)) / (params.stiffness / params.damping);
    expect(settleTimeAtRestUpperBound(params)).toBeCloseTo(expected, 6);
  });

  it('springAsEasing строит кривую по истинной, а не полу́ченной ставке', async () => {
    const { springAsEasing } = await import('../src/spring/index.js');
    const easing = springAsEasing(params);
    // Пол 1e-6 давал шкалу времени в двести раз короче истинной: кривая
    // мгновенно упиралась в единицу и теряла всю форму перехода.
    expect(easing(0)).toBe(0);
    expect(easing(1)).toBeCloseTo(1, 6);
    expect(easing(0.25)).toBeGreaterThan(0.05);
    expect(easing(0.25)).toBeLessThan(0.95);
  });
});
