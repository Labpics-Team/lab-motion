/**
 * test/spring-easing-c1-horizon.test.ts — доказательная программа #219:
 * C¹-конечная springAsEasing без endpoint-прыжка и повторной валидации.
 *
 * Классы:
 *   R. Exact critical RED — старая шкала T=ln(100)/(ω₀·slow) на критической
 *      (1,100,20) прыгала слева на ≈5.6% (lim t→1− = 1−(1+ln100)/100) с
 *      нормализованным наклоном ≈0.212; новый путь: g(1)=1, g′(1)=0.
 *   S. Символьный оракул — четыре endpoint-инварианта коррекции и точные
 *      константы границ: max|3t²−2t³|=1 (t=1), max|t³−t²|=4/27 (t=2/3).
 *   P. Property — широкая сетка under/critical/over: эндпоинты точны, конечно,
 *      |g−f| ≤ |1−f₁| + (4/27)|s₁| ≤ tolerance (differential против реплики
 *      формулы горизонта из шапки — прецедент canonicalSettle).
 *   I. Scale invariance — (m,k,c) и (λm,λk,λc) дают одну кривую бит-в-бит
 *      для степеней двойки.
 *   F. Shape preservation — overshoot НЕ клампится; отличие от raw spring
 *      ограничено заявленным допуском.
 *   Z. Non-settling — ζ=0 не получает скрытый damping: LM167.
 *
 * Mutation targets: удаление/знак коррекции (R, P); слом Horner (P);
 * подмена горизонта (P-реплика); ζ=0 → LM091/принятие (Z).
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError, spring } from '../src/index.js';
import { springAsEasing } from '../src/spring/index.js';
import { CONVERGENCE_THRESHOLD } from '../src/internal/constants.js';
import type { SpringParams } from '../src/spring.js';

const CRITICAL: SpringParams = { mass: 1, stiffness: 100, damping: 20 };

/** Реплика normalizedSpringHorizon из шапки src/spring/index.ts (не импорт!). */
function horizonReplica(zeta: number, tolerance: number): number {
  let envelope: (u: number) => number;
  if (zeta < 1) {
    const omegaDHat = Math.sqrt(1 - zeta * zeta);
    envelope = (u) => (Math.exp(-zeta * u) / omegaDHat) * (1 + (4 / 27) * u);
  } else if (zeta === 1) {
    envelope = (u) => Math.exp(-u) * (1 + u + (4 / 27) * u * u);
  } else {
    const d = Math.sqrt(zeta * zeta - 1);
    const slowHat = 1 / (zeta + d);
    const ampX = (zeta + d + slowHat) / (2 * d);
    const ampV = 1 / d;
    envelope = (u) => Math.exp(-slowHat * u) * (ampX + (4 / 27) * u * ampV);
  }
  let hi = 1;
  let guard = 0;
  while (envelope(hi) > tolerance && guard++ < 64) hi *= 2;
  let lo = hi / 2;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (envelope(mid) <= tolerance) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Params из (ω₀, ζ) при mass=1 — воронка тестов пакета. */
const paramsOf = (w: number, z: number): SpringParams =>
  ({ mass: 1, stiffness: w * w, damping: 2 * z * w });

// ─── R. Exact critical RED ───────────────────────────────────────────────────

describe('R: критическая пружина приходит в (1, 0) без прыжка', () => {
  it('левый предел t→1− равен 1 (старая шкала прыгала на ≈5.6%)', () => {
    const easing = springAsEasing(CRITICAL);
    // Число старого дефекта — для протокола: (1+ln100)/100 ≈ 0.0560517.
    expect((1 + Math.log(100)) / 100).toBeCloseTo(0.0560517019, 9);
    for (const h of [1e-3, 1e-5, 1e-7]) {
      expect(Math.abs(easing(1 - h) - 1)).toBeLessThanOrEqual(0.05 * h + 1e-9);
    }
    expect(easing(1)).toBe(1);
  });

  it('нормализованный наклон у t=1 → 0 (старый ≈0.212)', () => {
    const easing = springAsEasing(CRITICAL);
    const h = 1e-3;
    const slope = (easing(1) - easing(1 - h)) / h;
    // g′(1)=0 точно; остаток — O(h·|g″|). Старая шкала давала ≈0.212.
    expect(Math.abs(slope)).toBeLessThanOrEqual(1e-3);
  });

  it('вход в ноль тоже C¹: g(0)=0 и g′(0)=0', () => {
    const easing = springAsEasing(CRITICAL);
    expect(easing(0)).toBe(0);
    const h = 1e-4;
    expect(Math.abs(easing(h) / h)).toBeLessThanOrEqual(1e-2);
  });
});

// ─── S. Символьный оракул коррекции ──────────────────────────────────────────

describe('S: инварианты Hermite-коррекции и точные константы границ', () => {
  it('P(t) = (1−f₁)(3t²−2t³) − s₁(t³−t²): P(0)=0, P(1)=1−f₁, P′(0)=0, P′(1)=−s₁', () => {
    for (const [f1, s1] of [[0.94, 0.21], [1.02, -0.03], [0.999, 0.0001]] as const) {
      const P = (t: number): number => (1 - f1) * (3 * t * t - 2 * t ** 3) - s1 * (t ** 3 - t * t);
      const dP = (t: number): number => (1 - f1) * (6 * t - 6 * t * t) - s1 * (3 * t * t - 2 * t);
      expect(P(0)).toBe(0);
      expect(P(1)).toBeCloseTo(1 - f1, 15);
      expect(dP(0)).toBe(0);
      expect(dP(1)).toBeCloseTo(-s1, 15);
    }
  });

  it('max|3t²−2t³| = 1 (t=1) и max|t³−t²| = 4/27 (t=2/3) на плотной сетке', () => {
    let maxA = 0;
    let maxB = 0;
    for (let i = 0; i <= 10_000; i++) {
      const t = i / 10_000;
      maxA = Math.max(maxA, Math.abs(3 * t * t - 2 * t ** 3));
      maxB = Math.max(maxB, Math.abs(t ** 3 - t * t));
    }
    expect(maxA).toBe(1);
    // Сетка не содержит t=2/3 точно: пик зажат с двух сторон, а точное
    // значение в t=2/3 равно 4/27 аналитически.
    expect(maxB).toBeLessThanOrEqual(4 / 27);
    expect(maxB).toBeGreaterThan(4 / 27 - 1e-8);
    expect(Math.abs(((2 / 3) ** 3) - ((2 / 3) ** 2))).toBeCloseTo(4 / 27, 15);
  });
});

// ─── P. Property: bound на широкой сетке (differential против реплики) ───────

describe('P: |g−f| ограничен и не превышает допуска пакета', () => {
  it('under/critical/over: эндпоинты точны, коррекция ≤ CONVERGENCE_THRESHOLD', () => {
    for (const w of [0.5, 8, 120]) {
      for (const z of [0.15, 0.6, 0.95, 1, 1.4, 6]) {
        const params = paramsOf(w, z);
        const easing = springAsEasing(params);
        const T = horizonReplica(z, CONVERGENCE_THRESHOLD) / w;
        expect(easing(0)).toBe(0);
        expect(easing(1)).toBe(1);
        for (let i = 1; i < 60; i++) {
          const t = i / 60;
          const g = easing(t);
          const f = spring(params, t * T).value;
          expect(Number.isFinite(g), `finite ω₀=${w} ζ=${z} t=${t}`).toBe(true);
          expect(
            Math.abs(g - f),
            `bound ω₀=${w} ζ=${z} t=${t}`,
          ).toBeLessThanOrEqual(CONVERGENCE_THRESHOLD * (1 + 1e-9));
        }
      }
    }
  });

  it('горизонт удовлетворяет критерию: |1−f₁| + (4/27)|s₁| ≤ tolerance', () => {
    for (const w of [1, 40]) {
      for (const z of [0.3, 1, 2.5]) {
        const params = paramsOf(w, z);
        const T = horizonReplica(z, CONVERGENCE_THRESHOLD) / w;
        const at = spring(params, T);
        const criterion = Math.abs(1 - at.value) + (4 / 27) * Math.abs(T * at.velocity);
        expect(criterion, `ω₀=${w} ζ=${z}`).toBeLessThanOrEqual(CONVERGENCE_THRESHOLD);
      }
    }
  });
});

// ─── I. Scale invariance ─────────────────────────────────────────────────────

describe('I: scale-equivalent параметры дают одну кривую', () => {
  it('бит-в-бит для степеней двойки, включая крайние масштабы', () => {
    const base = paramsOf(11, 0.7);
    for (const lambda of [2 ** -40, 8, 2 ** 300]) {
      const scaled: SpringParams = {
        mass: base.mass * lambda,
        stiffness: base.stiffness * lambda,
        damping: base.damping * lambda,
      };
      const a = springAsEasing(base);
      const b = springAsEasing(scaled);
      for (let i = 0; i <= 40; i++) {
        expect(Object.is(a(i / 40), b(i / 40)), `λ=${lambda} t=${i / 40}`).toBe(true);
      }
    }
  });
});

// ─── F. Shape preservation ───────────────────────────────────────────────────

describe('F: форма пружины сохранена', () => {
  it('overshoot упругой пружины НЕ клампится и совпадает с raw в допуске', () => {
    const params = paramsOf(10, 0.35);
    const easing = springAsEasing(params);
    let maxG = 0;
    for (let i = 1; i < 400; i++) maxG = Math.max(maxG, easing(i / 400));
    // Raw-пик первого overshoot: 1 + e^(−ζπ/√(1−ζ²)).
    const rawPeak = 1 + Math.exp((-0.35 * Math.PI) / Math.sqrt(1 - 0.35 * 0.35));
    expect(maxG).toBeGreaterThan(1.05);
    expect(Math.abs(maxG - rawPeak)).toBeLessThanOrEqual(CONVERGENCE_THRESHOLD + 1e-3);
  });
});

// ─── Z. Non-settling ─────────────────────────────────────────────────────────

describe('Z: незатухающая система не получает скрытый damping', () => {
  it('ζ=0 → LM167 (граница finite-easing, не LM091 и не приём)', () => {
    let caught: unknown;
    try { springAsEasing({ mass: 1, stiffness: 100, damping: 0 }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe('LM167');
  });

  it('субнормальный ζ>0 легален: горизонт конечен, эндпоинты точны', () => {
    const easing = springAsEasing({ mass: 1, stiffness: 100, damping: 1e-4 });
    expect(easing(0)).toBe(0);
    expect(easing(1)).toBe(1);
    expect(Number.isFinite(easing(0.37))).toBe(true);
  });
});
