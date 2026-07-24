import { describe, expect, it } from 'vitest';
import { compileSpringLinear, compileSpringPlan } from '../src/compositor/index.js';
import {
  BASE_GRID_MAX,
  baseGridSize,
  buildSpringNodes,
  fitsSpringCurveBudget,
} from '../src/compositor/segmenter.js';
import { CONVERGENCE_THRESHOLD } from '../src/internal/constants.js';
import { solveSpring } from '../src/internal/solver.js';
import {
  settleTimeAtRestUpperBound,
  settleTimeUpperBound,
  type SpringParams,
} from '../src/spring.js';
import { MotionParamError } from '../src/errors.js';

const UNDER = { mass: 1, stiffness: 100, damping: 10 };
const CRITICAL = { mass: 1, stiffness: 100, damping: 20 };
const OVER = { mass: 1, stiffness: 100, damping: 30 };
const SMALL_SCALE = { mass: 0.001, stiffness: 0.00165, damping: 0.00205 };
const NEAR_CRITICAL_UNDER = { mass: 3, stiffness: 71, damping: 29 };
const NEAR_CRITICAL_OVER = { mass: 3, stiffness: 71, damping: 30 };
const CURVE_REGIMES = [
  UNDER,
  CRITICAL,
  OVER,
  SMALL_SCALE,
  NEAR_CRITICAL_UNDER,
  NEAR_CRITICAL_OVER,
] as const;

function parseLinear(linear: string): { progress: number; percent: number }[] {
  return linear.slice(7, -1).split(', ').map((stop) => {
    const [progress, percent] = stop.split(' ');
    return {
      progress: Number(progress),
      percent: Number(percent!.slice(0, -1)),
    };
  });
}

function firstPhysicalSlope(
  nodes: readonly { progress: number; percent: number }[],
  durationSeconds: number,
): number {
  const first = nodes[0]!;
  const second = nodes[1]!;
  return (second.progress - first.progress)
    / (((second.percent - first.percent) / 100) * durationSeconds);
}

// ЗАМОРОЖЕННЫЕ значения rest-бюджета (секунды) для шести режимов корпуса.
//
// Раньше здесь жила РЕПЛИКА производственной формулы (`legacyRestBound`). Такой
// пин тавтологичен: он повторял тот же расчёт и потому не мог поймать изменение
// закона — только изменение маршрутизации. Заменён на два независимых пина:
// (1) маршрут — через производственный seam `settleTimeAtRestUpperBound`;
// (2) значение — замороженными литералами. Литерал не дрейфует вместе с
// реализацией: любое изменение закона становится видимым намеренным диффом.
//
// Хронология значений:
//   2026-07-24 — канонизация ζ = (c/m)/(2ω₀) вместо c/(2·m·ω₀) (#239): формы
//   различаются на ≤1 ulp при массе ≠ 1 (SMALL_SCALE: …067 → …065), зато бюджет
//   стал бит-инвариантным по масс-эквивалентности — предпосылка exact-ключа кэша.
const FROZEN_REST_BOUND_S = new Map<SpringParams, number>([
  [UNDER, 1.5489486991535946],
  [CRITICAL, 1.051957473113693],
  [OVER, 2.0312297233075087],
  [SMALL_SCALE, 5.907342996227065],
  [NEAR_CRITICAL_UNDER, 1.8734889905689867],
  [NEAR_CRITICAL_OVER, 2.0442046523205253],
]);

function frozenRestBound(p: SpringParams): number {
  const value = FROZEN_REST_BOUND_S.get(p);
  if (value === undefined) throw new Error('режим без замороженного значения');
  return value;
}

function slowRate(p: SpringParams): number {
  const omega = Math.sqrt(p.stiffness / p.mass);
  const alpha = p.damping / (2 * p.mass);
  return alpha <= omega ? alpha : (omega * omega) / (alpha + Math.sqrt(alpha * alpha - omega * omega));
}

describe('compositor: v0 входит в доказанный горизонт и бюджет сетки', () => {
  it('v0=0 делегирует к rest-закону и держит замороженные значения', () => {
    for (const p of CURVE_REGIMES) {
      // Маршрут: обе нулевые формы уходят в тот же производственный seam.
      expect(settleTimeUpperBound(p, 0)).toBe(settleTimeAtRestUpperBound(p));
      expect(settleTimeUpperBound(p, -0)).toBe(settleTimeAtRestUpperBound(p));
      // Значение: независимый пин литералом (не реплика формулы).
      expect(settleTimeUpperBound(p, 0)).toBe(frozenRestBound(p));
    }
  });

  it('WAAPI-план использует тот же v0-зависимый горизонт', () => {
    for (const v0 of [-1, 1]) {
      const plan = compileSpringPlan({
        spring: UNDER,
        property: 'opacity',
        from: 0,
        to: 1,
        v0,
      });
      expect(plan.duration).toBe(settleTimeUpperBound(UNDER, v0) * 1000);
    }
  });

  it('первый сегмент WebKit-nodes и Chromium linear() сохраняет v0', () => {
    const tolerance = 0.0025;
    for (const p of CURVE_REGIMES) {
      for (const v0 of [-10, -1, 0, 1, 10]) {
        const duration = settleTimeUpperBound(p, v0);
        const nodeSlope = firstPhysicalSlope(
          buildSpringNodes(p, v0, tolerance),
          duration,
        );
        const cssSlope = firstPhysicalSlope(
          parseLinear(compileSpringLinear(p, { v0, tolerance })),
          duration,
        );
        const machineBudget = Number.EPSILON * Math.max(1, Math.abs(v0)) * 4;
        expect(Math.abs(nodeSlope - v0), `nodes damping=${p.damping}, v0=${v0}`)
          .toBeLessThanOrEqual(machineBudget);
        expect(Math.abs(cssSlope - v0), `css damping=${p.damping}, v0=${v0}`)
          .toBeLessThanOrEqual(machineBudget);
      }
    }
  });

  it('после горизонта позиция и скорость остаются внутри порога во всех режимах', () => {
    for (const p of [UNDER, CRITICAL, OVER]) {
      const rate = slowRate(p);
      for (const v0 of [-100, -1, 1, 100]) {
        const horizon = settleTimeUpperBound(p, v0);
        expect(Number.isFinite(horizon)).toBe(true);
        for (let i = 0; i <= 128; i++) {
          const r = solveSpring(p, horizon + (10 * i) / (128 * rate), v0);
          expect(Math.abs(r.value - 1)).toBeLessThanOrEqual(CONVERGENCE_THRESHOLD * (1 + 1e-12));
          expect(Math.abs(r.velocity)).toBeLessThanOrEqual(CONVERGENCE_THRESHOLD * (1 + 1e-12));
        }
      }
    }
  });

  it('последний принудительный узел не скрывает скачок больше порога', () => {
    for (const p of [UNDER, CRITICAL, OVER]) {
      for (const v0 of [-1, 1]) {
        const nodes = buildSpringNodes(p, v0, 0.02);
        const truth = solveSpring(p, settleTimeUpperBound(p, v0), v0);
        expect(nodes.at(-1)).toEqual({ progress: 1, percent: 100 });
        expect(Math.abs(truth.value - 1)).toBeLessThanOrEqual(CONVERGENCE_THRESHOLD);
      }
    }
  });

  it('доказанный interior-error держится для переносимой скорости во всех режимах', () => {
    const tolerance = 0.0025;
    const reconstruct = (nodes: ReturnType<typeof buildSpringNodes>, tau: number): number => {
      const percent = tau * 100;
      let hi = 1;
      while (hi < nodes.length && percent > nodes[hi]!.percent) hi++;
      const a = nodes[hi - 1]!;
      const b = nodes[Math.min(hi, nodes.length - 1)]!;
      const width = b.percent - a.percent;
      return width === 0
        ? a.progress
        : a.progress + ((b.progress - a.progress) * (percent - a.percent)) / width;
    };

    for (const p of CURVE_REGIMES) {
      for (const v0 of [-10, -1, 0, 1, 10]) {
        if (!fitsSpringCurveBudget(p, v0, tolerance)) continue;
        const nodes = buildSpringNodes(p, v0, tolerance);
        const horizon = settleTimeUpperBound(p, v0);
        const interior = nodes.at(-2)!.percent / 100;
        let maxError = 0;
        for (let i = 0; i <= 4096; i++) {
          const tau = (interior * i) / 4096;
          const truth = solveSpring(p, tau * horizon, v0).value;
          maxError = Math.max(maxError, Math.abs(reconstruct(nodes, tau) - truth));
        }
        // Защищённая стартовая касательная не может прятать
        // локальное превышение между точками общего скана.
        const localEnd = nodes[Math.min(2, nodes.length - 1)]!.percent / 100;
        for (let i = 0; i <= 256; i++) {
          const tau = (localEnd * i) / 256;
          const truth = solveSpring(p, tau * horizon, v0).value;
          maxError = Math.max(maxError, Math.abs(reconstruct(nodes, tau) - truth));
        }
        expect(maxError, `damping=${p.damping}, v0=${v0}`).toBeLessThanOrEqual(tolerance);
      }
    }
  });

  it('adaptive CSS-точность не расходует tolerance на большом early-slope', () => {
    const physics = { mass: 1, stiffness: 0.09, damping: 0.54 };
    const v0 = -20;
    const tolerance = 0.0025;
    const nodes = parseLinear(compileSpringLinear(physics, { v0, tolerance }));
    const horizon = settleTimeUpperBound(physics, v0);
    const interior = nodes.at(-2)!.percent / 100;
    let hi = 1;
    let maxError = 0;
    for (let i = 0; i <= 32_768; i++) {
      const tau = (interior * i) / 32_768;
      const percent = tau * 100;
      while (hi < nodes.length && percent > nodes[hi]!.percent) hi++;
      const a = nodes[hi - 1]!;
      const b = nodes[Math.min(hi, nodes.length - 1)]!;
      const progress = a.progress
        + ((b.progress - a.progress) * (percent - a.percent)) / (b.percent - a.percent);
      maxError = Math.max(
        maxError,
        Math.abs(progress - solveSpring(physics, tau * horizon, v0).value),
      );
    }
    expect(maxError).toBeLessThanOrEqual(tolerance);
  });

  it('малые коэффициенты не квантуются: nodes, duration и raw-физика имеют один SSOT', () => {
    const physics = { mass: 0.001, stiffness: 0.00165, damping: 0.00205 };
    const v0 = 50;
    const tolerance = 0.0025;
    const tau = 0.0791;
    const plan = compileSpringPlan({
      spring: physics,
      property: 'opacity',
      from: 0,
      to: 1,
      v0,
      tolerance,
    });
    expect(plan.duration).toBe(settleTimeUpperBound(physics, v0) * 1000);
    let i = 1;
    while (tau * 100 > plan.nodes[i]!.percent) i++;
    const a = plan.nodes[i - 1]!;
    const b = plan.nodes[i]!;
    const k = (tau * 100 - a.percent) / (b.percent - a.percent);
    const reconstructed = a.progress + (b.progress - a.progress) * k;
    const raw = solveSpring(physics, tau * plan.duration / 1000, v0).value;
    expect(Math.abs(reconstructed - raw)).toBeLessThanOrEqual(tolerance);
  });

  it('#228: скорость, над которой global grid over-cap-ился, теперь компилируема', () => {
    // Production до #228 отвергал v0=10⁴ (worst-case сетка по СТАРТОВОЙ
    // кривизне на всём горизонте); локальная энергетическая сетка ставит
    // плотные узлы только в начале и влезает в тот же BASE_GRID_MAX.
    const v0 = 10_000;
    expect(fitsSpringCurveBudget(UNDER, v0, 0.0025)).toBe(true);
    const nodes = buildSpringNodes(UNDER, v0, 0.0025);
    expect(nodes.at(-1)).toEqual({ progress: 1, percent: 100 });
  });

  it('сетка больше физического капа отвергается fail-closed и не отравляет кэш', () => {
    const v0 = 1_000_000;
    expect(fitsSpringCurveBudget(UNDER, v0, 0.0025)).toBe(false);
    expect(() => baseGridSize(UNDER, settleTimeUpperBound(UNDER, v0), 0.0025, v0))
      .toThrow(MotionParamError);
    expect(() => buildSpringNodes(UNDER, v0, 0.0025)).toThrow('LM016');
    expect(() => compileSpringLinear(UNDER, { v0 })).toThrow(MotionParamError);
    expect(() => compileSpringPlan({
      spring: UNDER,
      property: 'opacity',
      from: 0,
      to: 1,
      v0,
    })).toThrow(MotionParamError);

    const after = compileSpringLinear(UNDER);
    expect(after).toBe(compileSpringLinear(UNDER));
    expect(baseGridSize(UNDER, settleTimeUpperBound(UNDER), 0.0025)).toBeLessThanOrEqual(BASE_GRID_MAX);
  });

  it('MAX_VALUE не приводит к скрытому clamp или аллокации гигантского массива', () => {
    expect(settleTimeUpperBound(UNDER, Number.MAX_VALUE)).toBe(Infinity);
    expect(fitsSpringCurveBudget(UNDER, Number.MAX_VALUE, 0.02)).toBe(false);
    expect(() => buildSpringNodes(UNDER, Number.MAX_VALUE, 0.02)).toThrow(MotionParamError);
  });
});
