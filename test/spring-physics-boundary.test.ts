/**
 * test/spring-physics-boundary.test.ts — доказательная программа #218:
 * разделение физической валидности spring и бюджетов исполнителей.
 *
 * Закон: validateSpringPhysics — только физический домен (mass>0, stiffness>0,
 * damping≥0, все конечны); чистый spring() вычисляет ЛЮБУЮ физически валидную
 * систему. Бюджет автономного frame-loop (LM091) принадлежит исполнителям
 * (drive/MotionValue/фасад) и применяется на ИХ границе. Конструкторы
 * fromBounce/fromVisualDuration возвращают ТОЧНОЕ математическое преобразование
 * без скрытой коэрсии; bounce=1 честно означает damping=0. Finite easing —
 * отдельный исполнитель: ζ=0 не имеет конечного горизонта → LM167.
 *
 * Mutation targets: возврат budget-проверки в spring()/конструкторы; слом
 * точного закона ω₀=2π/T, ζ=1−bounce; подмена LM167 ↔ LM091.
 */

import { describe, expect, it } from 'vitest';
import {
  MotionParamError,
  MotionValue,
  spring,
  validateSpringParams,
  validateSpringPhysics,
} from '../src/index.js';
import { fromBounce, fromVisualDuration, springAsEasing } from '../src/spring/index.js';

const UNDAMPED = { mass: 1, stiffness: 100, damping: 0 };
const VERY_SLOW = fromBounce({ duration: 100, bounce: 0 });

// ─── 1. Characterization: обычный домен не изменился ─────────────────────────

describe('#218/1 characterization: обычные параметры ведут себя как прежде', () => {
  it('типовые пружины принимаются обеими границами, мусор — отвергается кодами физики', () => {
    for (const p of [
      { mass: 1, stiffness: 170, damping: 26 },
      { mass: 2, stiffness: 300, damping: 40 },
    ]) {
      expect(() => validateSpringPhysics(p)).not.toThrow();
      expect(() => validateSpringParams(p)).not.toThrow();
    }
    const codes: Array<[Record<string, number>, string]> = [
      [{ mass: 0, stiffness: 100, damping: 10 }, 'LM088'],
      [{ mass: 1, stiffness: -5, damping: 10 }, 'LM089'],
      [{ mass: 1, stiffness: 100, damping: -1 }, 'LM090'],
      [{ mass: Number.NaN, stiffness: 100, damping: 10 }, 'LM088'],
    ];
    for (const [p, code] of codes) {
      for (const validate of [validateSpringPhysics, validateSpringParams]) {
        let caught: unknown;
        try { validate(p as never); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(MotionParamError);
        expect((caught as MotionParamError).code).toBe(code);
      }
    }
  });
});

// ─── 2-3. Точный маппинг и масштаб массы ─────────────────────────────────────

describe('#218/2 точный маппинг duration/bounce → ω₀/ζ → k/c', () => {
  it('round-trip на широком конечном домене ≤ 1e-12 относительного', () => {
    for (const duration of [0.05, 0.4, 1, 7, 100, 3600]) {
      for (const bounce of [-1, -0.5, 0, 0.3, 0.9, 1]) {
        for (const mass of [1, 0.02, 12]) {
          const p = fromBounce({ duration, bounce, mass });
          const omega0 = Math.sqrt(p.stiffness / p.mass);
          const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
          expect(Math.abs(omega0 - (2 * Math.PI) / duration) / omega0).toBeLessThanOrEqual(1e-12);
          expect(Math.abs(zeta - (1 - bounce))).toBeLessThanOrEqual(1e-12);
          expect(p.mass).toBe(mass);
        }
      }
    }
  });

  it('масса масштабирует k и c линейно (степень двойки — бит-в-бит)', () => {
    const base = fromBounce({ duration: 0.8, bounce: 0.25, mass: 1 });
    const doubled = fromBounce({ duration: 0.8, bounce: 0.25, mass: 4 });
    expect(Object.is(doubled.stiffness, base.stiffness * 4)).toBe(true);
    expect(Object.is(doubled.damping, base.damping * 4)).toBe(true);
  });
});

// ─── 4. Edge: bounce=1 ⇒ damping=0 ───────────────────────────────────────────

describe('#218/4 bounce=1: честный ζ=0 и разделение границ', () => {
  it('оба конструктора возвращают damping=0 без ускорения системы', () => {
    expect(fromBounce({ duration: 1, bounce: 1 }).damping).toBe(0);
    expect(fromVisualDuration({ visualDuration: 1, bounce: 1 }).damping).toBe(0);
  });

  it('чистый spring() вычисляет незатухающую: x = 1−cos(ω₀t) (замкнутая форма)', () => {
    for (const t of [0.05, 0.31, 1.7]) {
      const { value, velocity } = spring(UNDAMPED, t);
      expect(Math.abs(value - (1 - Math.cos(10 * t)))).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(velocity - 10 * Math.sin(10 * t))).toBeLessThanOrEqual(1e-11);
    }
  });

  it('live executor fail-fast: MotionValue/validateSpringParams — LM091', () => {
    let caught: unknown;
    try { validateSpringParams(UNDAMPED); } catch (error) { caught = error; }
    expect((caught as MotionParamError).code).toBe('LM091');
    expect(() => new MotionValue({ initial: 0, spring: UNDAMPED }))
      .toThrow(MotionParamError);
  });

  it('finite easing fail-fast со СВОЕЙ причиной: LM167, не LM091', () => {
    let caught: unknown;
    try { springAsEasing(UNDAMPED); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe('LM167');
  });
});

// ─── 5. Slow spring: сэмплер доступен, frame-loop решает сам ─────────────────

describe('#218/5 медленные системы', () => {
  it('spring({1,1,1}) — доступен точный аналитический сэмплер', () => {
    const p = { mass: 1, stiffness: 1, damping: 1 };
    for (const t of [0.5, 3, 20]) {
      expect(Number.isFinite(spring(p, t).value)).toBe(true);
    }
    expect(() => validateSpringParams(p)).not.toThrow(); // оседает за ~11 c
  });

  it('за бюджетом кадра-капа: spring() вычисляет, frame-loop честно отказывает', () => {
    // duration=100 ⇒ ω₀=2π/100: оседание за пределами MAX_FRAMES·FIXED_DT.
    expect(Number.isFinite(spring(VERY_SLOW, 40).value)).toBe(true);
    expect(spring(VERY_SLOW, 400).value).toBeCloseTo(1, 3);
    let caught: unknown;
    try { validateSpringParams(VERY_SLOW); } catch (error) { caught = error; }
    expect((caught as MotionParamError).code).toBe('LM091');
  });

  it('finite easing нормализует время: медленная пружина ЛЕГАЛЬНА', () => {
    const easing = springAsEasing(VERY_SLOW);
    expect(easing(0)).toBe(0);
    expect(easing(1)).toBe(1);
    const mid = easing(0.5);
    expect(Number.isFinite(mid)).toBe(true);
    expect(mid).toBeGreaterThan(0.5); // критическая к середине горизонта уже высоко
  });
});

// ─── 6. No hidden mutation: выход = независимая формула ──────────────────────

describe('#218/6 конструктор против независимой формулы (не production-хелпера)', () => {
  it('fromBounce: k = m(2π/T)², c = 2m(1−bounce)(2π/T) напрямую', () => {
    for (const [T, b, m] of [[0.35, 0, 1], [0.5, 0.3, 1], [2, -0.4, 3]] as const) {
      const p = fromBounce({ duration: T, bounce: b, mass: m });
      const w = (2 * Math.PI) / T;
      expect(Math.abs(p.stiffness - m * w * w) / p.stiffness).toBeLessThanOrEqual(1e-15);
      expect(Math.abs(p.damping - 2 * m * (1 - b) * w) / (p.damping || 1)).toBeLessThanOrEqual(1e-15);
    }
  });

  it('fromVisualDuration ζ≥1: ω₀ = ln(100)·(ζ+√(ζ²−1))/Tv напрямую', () => {
    for (const [Tv, b] of [[0.5, 0], [1.5, -0.6], [4, -1]] as const) {
      const p = fromVisualDuration({ visualDuration: Tv, bounce: b });
      const zeta = 1 - b;
      const expected = (Math.log(100) * (zeta + Math.sqrt(Math.max(0, zeta * zeta - 1)))) / Tv;
      expect(Math.abs(Math.sqrt(p.stiffness / p.mass) - expected) / expected)
        .toBeLessThanOrEqual(1e-12);
    }
  });

  it('непредставимое точное преобразование — честная ошибка физики, не подмена', () => {
    // Абсурдная длительность: k underflow → 0 → LM089, никакого «ускорения».
    expect(() => fromBounce({ duration: 1e200, bounce: 0 })).toThrow(MotionParamError);
  });
});
