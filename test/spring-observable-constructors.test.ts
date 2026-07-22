/**
 * #230 — точные observable-конструкторы: fromPeak (первый перелёт + время
 * пика) и fromOscillation (период + half-life огибающей). Не пресеты:
 * координатные преобразования одной second-order модели, сверяемые с
 * независимым солвером на всём домене.
 */

import { describe, expect, it } from 'vitest';
import { fromOscillation, fromPeak } from '../src/spring/index.js';
import { solveSpring } from '../src/internal/solver.js';
import { MotionParamError } from '../src/errors.js';
import type { SpringParams } from '../src/spring.js';

function zetaOmega(params: SpringParams): { zeta: number; omega0: number } {
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  return { zeta: params.damping / (2 * params.mass * omega0), omega0 };
}

/** Первый максимум x(t) грубым сканом + бисекция по смене знака скорости. */
function firstPeak(params: SpringParams, horizon: number): { t: number; x: number } {
  const N = 4000;
  let prev = solveSpring(params, 0, 0).velocity;
  for (let i = 1; i <= N; i++) {
    const t = (horizon * i) / N;
    const v = solveSpring(params, t, 0).velocity;
    if (prev > 0 && v <= 0) {
      let lo = (horizon * (i - 1)) / N;
      let hi = t;
      for (let k = 0; k < 80; k++) {
        const mid = (lo + hi) / 2;
        if (solveSpring(params, mid, 0).velocity > 0) lo = mid;
        else hi = mid;
      }
      const at = (lo + hi) / 2;
      return { t: at, x: solveSpring(params, at, 0).value };
    }
    prev = v;
  }
  throw new Error('пик не найден в горизонте');
}

describe('#230 fromPeak: первый перелёт и время пика точны', () => {
  it('контрольный пример issue: overshoot 0.08 / peakTime 0.22 / mass 1', () => {
    const params = fromPeak({ overshoot: 0.08, peakTime: 0.22 });
    expect(params.stiffness).toBeCloseTo(335.7212724332, 8);
    expect(params.damping).toBeCloseTo(22.9611694937, 8);
    const { zeta, omega0 } = zetaOmega(params);
    expect(zeta).toBeCloseTo(0.6265771869, 9);
    expect(omega0).toBeCloseTo(18.3226982847, 8);
  });

  it('property: солвер достигает ПЕРВОГО пика 1+M ровно при t=peakTime на домене', () => {
    for (const M of [0.01, 0.08, 0.3, 0.5, 0.9]) {
      for (const tp of [0.05, 0.22, 1, 3]) {
        const params = fromPeak({ overshoot: M, peakTime: tp });
        const peak = firstPeak(params, tp * 2.5);
        expect(peak.t, `M=${M} tp=${tp}: время пика`).toBeCloseTo(tp, 6);
        expect(peak.x, `M=${M} tp=${tp}: амплитуда пика`).toBeCloseTo(1 + M, 7);
      }
    }
  });

  it('overshoot=1 — честная незатухающая: damping=0, пик ровно 2 при tp', () => {
    const params = fromPeak({ overshoot: 1, peakTime: 0.5 });
    expect(params.damping).toBe(0);
    // x = 1−cos(ω₀t), ω₀ = π/tp ⇒ x(tp) = 2.
    expect(solveSpring(params, 0.5, 0).value).toBeCloseTo(2, 9);
  });

  it('масштабная инвариантность по mass: k и c пропорциональны, ζ/ω₀ неизменны', () => {
    const base = fromPeak({ overshoot: 0.2, peakTime: 0.4 });
    const heavy = fromPeak({ overshoot: 0.2, peakTime: 0.4, mass: 7 });
    expect(heavy.stiffness / base.stiffness).toBeCloseTo(7, 12);
    expect(heavy.damping / base.damping).toBeCloseTo(7, 12);
    const a = zetaOmega(base);
    const b = zetaOmega(heavy);
    expect(b.zeta).toBeCloseTo(a.zeta, 12);
    expect(b.omega0).toBeCloseTo(a.omega0, 12);
  });

  it('домены: overshoot вне (0,1] → LM171; peakTime вне (0,∞) → LM093', () => {
    for (const bad of [0, -0.1, 1.0000001, Number.NaN, Number.POSITIVE_INFINITY]) {
      let code = '';
      try {
        fromPeak({ overshoot: bad, peakTime: 0.2 });
      } catch (error) {
        code = (error as MotionParamError).code;
      }
      expect(code, `overshoot=${bad}`).toBe('LM171');
    }
    for (const bad of [0, -1, Number.NaN]) {
      let code = '';
      try {
        fromPeak({ overshoot: 0.1, peakTime: bad });
      } catch (error) {
        code = (error as MotionParamError).code;
      }
      expect(code, `peakTime=${bad}`).toBe('LM093');
    }
  });

  it('граничный fuzz: экстремальные, но представимые входы конечны либо MotionParamError', () => {
    for (const M of [1e-8, 1 - 1e-12]) {
      for (const tp of [1e-6, 1e6]) {
        try {
          const params = fromPeak({ overshoot: M, peakTime: tp });
          expect(Number.isFinite(params.stiffness)).toBe(true);
          expect(Number.isFinite(params.damping)).toBe(true);
          expect(params.stiffness).toBeGreaterThan(0);
        } catch (error) {
          expect(error).toBeInstanceOf(MotionParamError);
        }
      }
    }
  });
});

describe('#230 fromOscillation: период и half-life огибающей точны', () => {
  it('полюса точны: ωd = 2π/period, α = ln2/halfLife', () => {
    const params = fromOscillation({ period: 0.4, halfLife: 0.18 });
    const { zeta, omega0 } = zetaOmega(params);
    const alpha = zeta * omega0;
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    expect(alpha).toBeCloseTo(Math.LN2 / 0.18, 10);
    expect(omegaD).toBeCloseTo((2 * Math.PI) / 0.4, 10);
    expect(zeta).toBeLessThan(1); // всегда underdamped
  });

  it('property: соседние одноимённые пики отстоят на period, амплитуды падают как 2^(−P/h)', () => {
    for (const [P, h] of [[0.4, 0.18], [1, 1], [0.25, 2]] as const) {
      const params = fromOscillation({ period: P, halfLife: h });
      const first = firstPeak(params, P);
      // Второй одноимённый пик: скан от первого + период (окно ±40%).
      const shifted = {
        t: 0,
        x: 0,
      };
      {
        const start = first.t + P * 0.6;
        const N = 4000;
        let prev = solveSpring(params, start, 0).velocity;
        for (let i = 1; i <= N; i++) {
          const t = start + (P * 0.8 * i) / N;
          const v = solveSpring(params, t, 0).velocity;
          if (prev > 0 && v <= 0) {
            let lo = start + (P * 0.8 * (i - 1)) / N;
            let hi = t;
            for (let k = 0; k < 80; k++) {
              const mid = (lo + hi) / 2;
              if (solveSpring(params, mid, 0).velocity > 0) lo = mid;
              else hi = mid;
            }
            shifted.t = (lo + hi) / 2;
            shifted.x = solveSpring(params, shifted.t, 0).value;
            break;
          }
          prev = v;
        }
      }
      expect(shifted.t - first.t, `P=${P} h=${h}: период`).toBeCloseTo(P, 6);
      const ratio = (first.x - 1) / (shifted.x - 1);
      expect(ratio, `P=${P} h=${h}: затухание огибающей`).toBeCloseTo(2 ** (P / h), 4);
    }
  });

  it('домены: period/halfLife вне (0,∞) → LM093; period=∞ не критическая ветвь', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let period = '';
      try {
        fromOscillation({ period: bad, halfLife: 0.2 });
      } catch (error) {
        period = (error as MotionParamError).code;
      }
      expect(period, `period=${bad}`).toBe('LM093');
      let half = '';
      try {
        fromOscillation({ period: 0.4, halfLife: bad });
      } catch (error) {
        half = (error as MotionParamError).code;
      }
      expect(half, `halfLife=${bad}`).toBe('LM093');
    }
  });
});
