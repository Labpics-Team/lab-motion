/**
 * test/compositor-energy-grid.test.ts — #228: локальная энергетическая сетка.
 * Классы: В (независимый плотный оракул ПОСЛЕ сериализации, покомпонентные
 * бюджеты, differential к аналитике), Д (mutation-хуки бондов/шага/eps).
 *
 * ── RED PROOF (авторские мутации, каждая роняет конкретный блок) ──────────────
 * - Шаг √(4tol/M) → √(8tol/M) (фактор) → «сетка ≤ tol/2» RED (ошибка сетки → tol).
 * - κ=√(1+4ζ²) → √(1+2ζ²) (ζ-term) → «сетка ≤ tol/2» RED на underdamped+v0.
 * - Модальный бонд: λf² → λf у |b|-слагаемого → «сетка ≤ tol/2» RED на ζ≥2.
 * - eps RDP 3tol/8 → tol/2 → «RDP ≤ 3tol/8 против сетки» RED.
 * - Убрать cap 1/32 → «пол сетки ≥ 32 интервалов» RED (гладкие пружины).
 * - Вернуть ключ горизонта без #223-продления → полный оракул RED на tol=2.5e-4
 *   (хвостовой остаток превысил бы бюджет).
 *
 * Корпус повторяет спайк #228 (issue): ζ∈{0.05,0.3,0.5,1,2,5} × v0∈{0,±3} ×
 * tol∈{1/400,1e-3,2.5e-4}; ошибка меряется как исполняет CSS-парсер —
 * по сериализованным токенам (+унарный плюс), включая середины сегментов.
 */

import { describe, expect, it } from 'vitest';
import {
  BASE_GRID_MAX,
  baseGridSize,
  springCompileHorizon,
  tryBuildAdaptiveSpringGrid,
  tryBuildSpringNodes,
} from '../src/compositor/segmenter.js';
import { compileSpringLinear } from '../src/compositor/index.js';
import { solveSpring } from '../src/internal/solver.js';
import type { SpringParams } from '../src/spring.js';

// ω₀=10; c = 2·m·ω₀·ζ = 20ζ при m=1, k=100 — тот же корпус, что спайк #228.
const ZETAS = [0.05, 0.3, 0.5, 1, 2, 5] as const;
const V0S = [0, 3, -3] as const;
const TOLS = [1 / 400, 1e-3, 2.5e-4] as const;

function springOf(zeta: number): SpringParams {
  return { mass: 1, stiffness: 100, damping: 20 * zeta };
}

/** Линейная реконструкция по (xs, ys) в точке x (xs строго возрастают). */
function lerpAt(xs: readonly number[], ys: readonly number[], x: number): number {
  let hi = 1;
  while (hi < xs.length - 1 && x > xs[hi]!) hi++;
  const x0 = xs[hi - 1]!;
  const x1 = xs[hi]!;
  const w = x1 - x0;
  return w === 0 ? ys[hi - 1]! : ys[hi - 1]! + ((ys[hi]! - ys[hi - 1]!) * (x - x0)) / w;
}

describe('#228: покомпонентные certified-бюджеты (сетка и RDP по отдельности)', () => {
  it('базовая сетка: непрерывная ошибка ≤ tol/2 на всём корпусе (середины сегментов)', () => {
    for (const zeta of ZETAS) {
      const params = springOf(zeta);
      for (const v0 of V0S) {
        for (const tol of TOLS) {
          const settle = springCompileHorizon(params, v0, tol);
          const grid = tryBuildAdaptiveSpringGrid(params, v0, tol, settle);
          expect(grid, `ζ=${zeta} v0=${v0} tol=${tol}`).toBeDefined();
          const [xs, ys] = grid!;
          // Стартовое значение и anchor: индекс 0 — ноль, индекс 1 — касательная.
          expect(xs[0]).toBe(0);
          expect(ys[0]).toBe(0);
          // Худшая точка линейной ошибки — середина сегмента: проверяем ВСЕ
          // середины + сами узлы (узлы точны по построению, кроме anchor).
          let worst = 0;
          for (let i = 1; i < xs.length; i++) {
            const mid = (xs[i - 1]! + xs[i]!) / 2;
            const truth = solveSpring(params, mid * settle, v0).value;
            worst = Math.max(worst, Math.abs(lerpAt(xs, ys, mid) - truth));
          }
          expect(worst, `grid ζ=${zeta} v0=${v0} tol=${tol}`)
            .toBeLessThanOrEqual(tol / 2 * (1 + 1e-9));
        }
      }
    }
  });

  // Ревью #246: корпус выше фиксирует ω₀=10 и m=1 — единственную частоту и
  // единственную массу. Доказательство бонда от этого не зависит (оно в
  // безразмерном u=ω₀t), но ПИН зависел: худшие точки независимого скана
  // (ω₀=1000, ζ=0.01, v0=2000; tol=1e-5) в корпус не входили, то есть тест был
  // уже доказательства. Второй корпус закрывает обе оси плюс более строгий tol.
  const WIDE_SYSTEMS = [
    { omega0: 0.5, mass: 1 },
    { omega0: 1, mass: 7.5 },
    { omega0: 250, mass: 0.02 },
    { omega0: 1000, mass: 1 },
  ] as const;
  const WIDE_ZETAS = [0.01, 0.2, 1, 3, 40] as const;
  const WIDE_V0S = [0, 25, -2000] as const;
  const WIDE_TOLS = [1e-3, 1e-5] as const;

  it('широкий корпус: бонд держится при ω₀ ∈ [0.5, 1000], массе ≠ 1 и tol = 1e-5', () => {
    let compiled = 0;
    let worstRatio = 0;
    for (const { omega0, mass } of WIDE_SYSTEMS) {
      for (const zeta of WIDE_ZETAS) {
        const params: SpringParams = {
          mass,
          stiffness: mass * omega0 * omega0,
          damping: 2 * mass * omega0 * zeta,
        };
        for (const v0 of WIDE_V0S) {
          for (const tol of WIDE_TOLS) {
            const settle = springCompileHorizon(params, v0, tol);
            const grid = tryBuildAdaptiveSpringGrid(params, v0, tol, settle);
            // Отказ по капу законен (LM016 — честный маршрут в живой солвер).
            if (!grid) continue;
            compiled++;
            const [xs, ys] = grid;
            let worst = 0;
            for (let i = 1; i < xs.length; i++) {
              const mid = (xs[i - 1]! + xs[i]!) / 2;
              const truth = solveSpring(params, mid * settle, v0).value;
              worst = Math.max(worst, Math.abs(lerpAt(xs, ys, mid) - truth));
            }
            const label = `ω₀=${omega0} m=${mass} ζ=${zeta} v0=${v0} tol=${tol}`;
            expect(worst, label).toBeLessThanOrEqual(tol / 2 * (1 + 1e-9));
            worstRatio = Math.max(worstRatio, worst / (tol / 2));
          }
        }
      }
    }
    // Анти-вырожденность: корпус обязан реально компилироваться, а не весь
    // уходить в отказ (иначе «зелёный» тест ничего не проверяет), и обязан
    // подходить к бонду близко (иначе бонд не измеряется этим корпусом).
    expect(compiled).toBeGreaterThan(60);
    expect(worstRatio).toBeGreaterThan(0.2);
  });

  it('PRODUCTION-прореживание отклоняется от сетки ≤ 3tol/8 (замыкает арифметику ≤ tol)', () => {
    // Узлы берутся из production tryBuildSpringNodes (не пересчитанным в тесте
    // RDP): мутация production-eps 3tol/8 → tol/2 роняет ровно этот блок.
    for (const zeta of ZETAS) {
      const params = springOf(zeta);
      for (const tol of TOLS) {
        const settle = springCompileHorizon(params, 0, tol);
        const [xs, ys] = tryBuildAdaptiveSpringGrid(params, 0, tol, settle)!;
        const nodes = tryBuildSpringNodes(params, 0, tol)![0];
        const keptXs = nodes.map((n) => n.percent / 100);
        // Снап хвоста в ровно 1 — дисциплина эндпоинтов, не RDP: последнюю
        // ординату возвращаем к сырому сеточному значению (grid xs[last]=1).
        const keptYs = nodes.map((n, i) => (i === nodes.length - 1 ? ys[ys.length - 1]! : n.progress));
        let worst = 0;
        for (let i = 0; i < xs.length; i++) {
          worst = Math.max(worst, Math.abs(lerpAt(keptXs, keptYs, xs[i]!) - ys[i]!));
        }
        expect(worst, `rdp ζ=${zeta} tol=${tol}`).toBeLessThanOrEqual(tol * 3 / 8 + 1e-12);
      }
    }
  });
});

describe('#228: независимый плотный оракул СЕРИАЛИЗОВАННОЙ кривой', () => {
  /** Разбор стопов как CSS-парсер: Number(token) — токены уже short-roundtrip. */
  function parseStops(linear: string): [xs: number[], ys: number[]] {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const stop of linear.slice(7, -1).split(', ')) {
      const [p, pct] = stop.split(' ');
      ys.push(Number(p));
      xs.push(Number(pct!.slice(0, -1)) / 100);
    }
    return [xs, ys];
  }

  it('полный корпус: ошибка ≤ tol на интерьере и ≤ 9tol/8 на финальном сегменте', () => {
    let corpusWorstOverTol = 0;
    for (const zeta of ZETAS) {
      const params = springOf(zeta);
      for (const v0 of V0S) {
        for (const tol of TOLS) {
          const built = tryBuildSpringNodes(params, v0, tol);
          expect(built, `ζ=${zeta} v0=${v0} tol=${tol}`).toBeDefined();
          const [xs, ys] = parseStops(compileSpringLinear(params, { v0, tolerance: tol }));
          const settle = built![1];
          // Интерьер: до последнего узла ПЕРЕД снапом хвоста в 1 — здесь
          // замкнутая арифметика (сетка tol/2 + RDP 3tol/8 + эмит tol/8) точна.
          const interiorEnd = xs[xs.length - 2]!;
          let worst = 0;
          for (let i = 0; i <= 2048; i++) {
            const tau = (interiorEnd * i) / 2048;
            const truth = solveSpring(params, tau * settle, v0).value;
            worst = Math.max(worst, Math.abs(lerpAt(xs, ys, tau) - truth));
          }
          expect(worst, `oracle ζ=${zeta} v0=${v0} tol=${tol}`)
            .toBeLessThanOrEqual(tol * (1 + 1e-9));
          corpusWorstOverTol = Math.max(corpusWorstOverTol, worst / tol);
          // Финальный сегмент: снап в ровно 1 добавляет остаток горизонта
          // (≤ tol/8 по #223-закону для строгих tol; перцептивный для дефолта).
          for (let i = 0; i <= 64; i++) {
            const tau = interiorEnd + ((1 - interiorEnd) * i) / 64;
            const truth = solveSpring(params, tau * settle, v0).value;
            expect(Math.abs(lerpAt(xs, ys, tau) - truth), `tail ζ=${zeta} v0=${v0} tol=${tol}`)
              .toBeLessThanOrEqual(tol * 9 / 8 * (1 + 1e-9));
          }
        }
      }
    }
    // Санити от «вечнозелёного» оракула: бюджет реально расходуется (спайк:
    // худшее 0.666·tol). Вырожденно-малое худшее значит, что оракул сломан
    // либо сетка пере-плотнена на порядок (регрессия выигрыша #228).
    expect(corpusWorstOverTol).toBeGreaterThan(0.2);
  });

  it('масс-эквивалентные системы дают идентичные узлы ({2,340,52} ≡ {1,170,26})', () => {
    const a = tryBuildSpringNodes({ mass: 1, stiffness: 170, damping: 26 }, 0.4, 1 / 400)!;
    const b = tryBuildSpringNodes({ mass: 2, stiffness: 340, damping: 52 }, 0.4, 1 / 400)!;
    expect(b[0]).toEqual(a[0]);
    expect(b[1]).toBe(a[1]);
  });
});

describe('#228: структура сетки и fail-closed', () => {
  it('xs строго возрастают, конечны, стартуют в 0 и кончаются в 1 (весь корпус)', () => {
    for (const zeta of ZETAS) {
      const params = springOf(zeta);
      for (const v0 of V0S) {
        const settle = springCompileHorizon(params, v0, 1 / 400);
        const [xs, ys] = tryBuildAdaptiveSpringGrid(params, v0, 1 / 400, settle)!;
        expect(xs[0]).toBe(0);
        expect(xs[xs.length - 1]).toBe(1);
        for (let i = 0; i < xs.length; i++) {
          expect(Number.isFinite(xs[i]!) && Number.isFinite(ys[i]!)).toBe(true);
          if (i > 0) expect(xs[i]!, `ζ=${zeta} v0=${v0} i=${i}`).toBeGreaterThan(xs[i - 1]!);
        }
      }
    }
  });

  it('пол сетки: ≥ BASE_GRID_MIN интервалов даже у гладчайшей пружины', () => {
    // Мутация «убрать cap 1/32» роняет ровно этот пин: мягкая критическая
    // пружина при слабом tol иначе прошла бы парой гигантских шагов.
    expect(baseGridSize(springOf(1), springCompileHorizon(springOf(1), 0, 0.02), 0.02))
      .toBeGreaterThanOrEqual(32);
  });

  it('кап: сетка никогда не превышает BASE_GRID_MAX интервалов (жёсткий корпус)', () => {
    for (const zeta of [0.05, 5]) {
      const params = springOf(zeta);
      const settle = springCompileHorizon(params, 3, 2.5e-4);
      const grid = tryBuildAdaptiveSpringGrid(params, 3, 2.5e-4, settle)!;
      expect(grid[0].length - 1).toBeLessThanOrEqual(BASE_GRID_MAX);
    }
  });

  it('anchor: узел 1 — четверть первого шага, физическая касательная v0', () => {
    const params = springOf(0.5);
    const v0 = 4;
    const settle = springCompileHorizon(params, v0, 1 / 400);
    const [xs, ys] = tryBuildAdaptiveSpringGrid(params, v0, 1 / 400, settle)!;
    // Геометрия: anchor строго внутри первого интервала (четверть шага).
    expect(xs[1]!).toBeGreaterThan(0);
    expect(xs[1]!).toBeLessThan(xs[2]!);
    expect(xs[2]! / xs[1]!).toBeCloseTo(4, 9);
    // Значение — касательная (slope = v0 в физическом времени), не сэмпл.
    expect(ys[1]! / (xs[1]! * settle)).toBeCloseTo(v0, 9);
  });

  it('#228-выигрыш: pre-RDP сетка ≥3× меньше прежней worst-case формулы', () => {
    // Прежний global-grid закон (снят в #228) воспроизведён дословно как
    // baseline-квитанция: N = √(T²(ω₀+c/m)·hypot(v0,ω₀)/(2tol)) + 24.
    const legacy = (p: SpringParams, settle: number, tol: number, v0: number): number => {
      const omega0 = Math.sqrt(p.stiffness / p.mass);
      const curvature = settle * settle * (omega0 + p.damping / p.mass) * Math.hypot(v0, omega0);
      return Math.max(32, Math.ceil(Math.sqrt(curvature / (2 * tol))) + 24);
    };
    for (const zeta of ZETAS) {
      const params = springOf(zeta);
      for (const v0 of V0S) {
        const tol = 1 / 400;
        const settle = springCompileHorizon(params, v0, tol);
        const adaptive = baseGridSize(params, settle, tol, v0);
        expect(adaptive * 3, `ζ=${zeta} v0=${v0}`)
          .toBeLessThanOrEqual(legacy(params, settle, tol, v0));
      }
    }
  });
});
