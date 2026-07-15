/**
 * test/animate-linear-compile.test.ts — лёгкий linear()-компилятор прогресса
 * (срез R1 rebuild): портируемый IR + сериализатор.
 * Классы: В (differential против независимого RK4-оракула, границы ошибки),
 * А (паритет длительности с compositor-трактом), контракт слоистости IR.
 *
 * ── RED PROOF (авторские мутации, каждая роняет конкретный блок) ─────────────
 * - Убрать вклад v0 из границы кривизны (hypot → ω₀) → RK4-матрица v0=±3 RED.
 * - Убрать дожим хвоста до ε → RK4 overdamped v0=+3 RED (снап хвоста >1e-3).
 * - Прореживать ПОСЛЕ сериализации либо квантовать в сериализаторе →
 *   «граница IR → сериализатор» RED.
 * - Пустить NaN из ease в артефакт → hostile-ease и JSON-паритет RED.
 * - Снять потолок BASE_GRID_MAX → «непредставимая пружина» RED (строка-монстр
 *   вместо undefined).
 */

import { describe, expect, it } from 'vitest';
import {
  buildSpringProgressGridUnchecked,
  easeProgressCurve,
  easeProgressLinear,
  springProgressCurve,
  springProgressLinear,
  toLinear,
} from '../src/animate/linear-compile.js';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import {
  DEFAULT_DURATION_MS,
  DEFAULT_SPRING,
  STANDARD_EASING,
} from '../src/internal/motion-defaults.js';
import { MotionParamError } from '../src/errors.js';
import { type SpringParams } from '../src/spring.js';

// ─── Пружины-образцы: все три режима затухания + упругий подхват ─────────────
const UNDER: SpringParams = { mass: 1, stiffness: 100, damping: 10 }; // ζ=0.5
const CRITICAL: SpringParams = { mass: 1, stiffness: 200, damping: 2 * Math.sqrt(200) }; // ζ=1
const OVER: SpringParams = { mass: 1, stiffness: 100, damping: 40 }; // ζ=2
const BOUNCY: SpringParams = { mass: 1, stiffness: 180, damping: 8 }; // ζ≈0.3

const EPSILON = 1e-3;
// Квантование IR: value 1e-4 (вклад ≤0.5e-4) + сдвиг offset (квант 1e-6, вклад
// ≪ value-кванта). Честные пороги ниже = аналитический бюджет + этот хвост.
const QUANT = 1e-4;

/** Разбирает linear()-строку сериализатора: концы без %, внутренние с %. */
function parseLinear(easing: string): { offset: number; value: number }[] {
  expect(easing.startsWith('linear(')).toBe(true);
  expect(easing.endsWith(')')).toBe(true);
  const tokens = easing.slice(7, -1).split(',');
  expect(tokens.length).toBeGreaterThanOrEqual(2);
  return tokens.map((token, index) => {
    const parts = token.trim().split(' ');
    const value = Number(parts[0]);
    const offset =
      parts.length > 1
        ? Number(parts[1]!.replace('%', '')) / 100
        : index === 0
          ? 0
          : 1;
    expect(Number.isFinite(value)).toBe(true);
    expect(Number.isFinite(offset)).toBe(true);
    return { offset, value };
  });
}

/**
 * Максимальное отклонение кусочно-линейной реконструкции строки от оракула,
 * заданного значениями на равномерной сетке τ ∈ [0, 1].
 */
function maxReconstructionError(
  nodes: readonly { offset: number; value: number }[],
  oracle: ArrayLike<number>,
): number {
  const lastIndex = oracle.length - 1;
  let seg = 1;
  let maxErr = 0;
  for (let i = 0; i <= lastIndex; i++) {
    const tau = i / lastIndex;
    while (seg < nodes.length - 1 && nodes[seg]!.offset < tau) seg++;
    const a = nodes[seg - 1]!;
    const b = nodes[seg]!;
    const span = b.offset - a.offset;
    const mix = span > 0 ? Math.min(1, Math.max(0, (tau - a.offset) / span)) : 1;
    const err = Math.abs(a.value + (b.value - a.value) * mix - oracle[i]!);
    if (err > maxErr) maxErr = err;
  }
  return maxErr;
}

/**
 * Независимый численный оракул: классический RK4 для m·x″ + c·x′ + k·x = k,
 * x(0)=0, x′(0)=v0 — написан здесь с нуля, без порта чужих реализаций.
 */
function rk4Progress(
  spring: SpringParams,
  v0: number,
  durationS: number,
  steps: number,
): Float64Array {
  const { mass: m, stiffness: k, damping: c } = spring;
  const accel = (x: number, v: number): number => (k - k * x - c * v) / m;
  const values = new Float64Array(steps + 1);
  const h = durationS / steps;
  let x = 0;
  let v = v0;
  for (let i = 1; i <= steps; i++) {
    const k1x = v;
    const k1v = accel(x, v);
    const k2x = v + (h / 2) * k1v;
    const k2v = accel(x + (h / 2) * k1x, v + (h / 2) * k1v);
    const k3x = v + (h / 2) * k2v;
    const k3v = accel(x + (h / 2) * k2x, v + (h / 2) * k2v);
    const k4x = v + h * k3v;
    const k4v = accel(x + h * k3x, v + h * k3v);
    x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    values[i] = x;
  }
  return values;
}

// ─── A: differential против RK4 — режимы × начальная скорость ────────────────

describe('animate linear-compile: спрингова матрица против RK4', () => {
  const matrix: [string, SpringParams][] = [
    ['underdamped', UNDER],
    ['critical', CRITICAL],
    ['overdamped', OVER],
    ['bouncy', BOUNCY],
  ];
  const pickups = [0, 3, -3];
  const combos = matrix.flatMap(([mode, spring]) =>
    pickups.map((v0): [string, number, SpringParams] => [mode, v0, spring]));

  it.each(combos)('%s, v0=%s: maxErr < 2e-3, хвост ровно 1, длительность конечна', (
    _mode,
    v0,
    spring,
  ) => {
    const result = springProgressLinear(spring, v0);
    expect(result).toBeDefined();
    const { durationMs, easing } = result!;
    expect(Number.isFinite(durationMs)).toBe(true);
    expect(durationMs).toBeGreaterThan(0);

    const nodes = parseLinear(easing);
    expect(nodes.at(-1)!.value).toBe(1);
    expect(nodes.at(-1)!.offset).toBe(1);
    expect(nodes[0]).toEqual({ offset: 0, value: 0 });

    // Порог 2e-3 = сумма двух ε-стадий (дискретизация сетки ≤ ε, RDP ≤ ε);
    // квантование и снап хвоста живут внутри измеренного запаса.
    const oracle = rk4Progress(spring, v0, durationMs / 1000, 20_000);
    expect(maxReconstructionError(nodes, oracle)).toBeLessThan(2e-3);
  });
});

// ─── Паритет длительности с segmenter-трактом ────────────────────────────────

describe('animate linear-compile: паритет с compositor-трактом', () => {
  it('v0=0, дефолт-пружина: длительность совпадает с execution artifact', () => {
    const tuple = compileSpringExecutionArtifactTupleUnchecked(
      DEFAULT_SPRING,
      0,
      DEFAULT_TOLERANCE,
    );
    const result = springProgressLinear(DEFAULT_SPRING, 0)!;
    // Оба тракта читают горизонт из одного запечатанного settleTimeUpperBound,
    // поэтому нижняя граница — строгое равенство. Верхний допуск ×1.25 отведён
    // одностороннему ε-дожиму хвоста (5e-3 закона → 1e-3 модуля, ≤ ln5/rate
    // ≈ +13% шагами horizon/64); для дефолт-пружины остаток на горизонте уже
    // ≤ ε и дожим не срабатывает — фактически длительности равны бит-в-бит.
    expect(result.durationMs).toBeGreaterThanOrEqual(tuple[2] - 1e-9);
    expect(result.durationMs).toBeLessThanOrEqual(tuple[2] * 1.25);
  });
});

// ─── RDP: отклонение от плотной сетки и укорочение строки ────────────────────

describe('animate linear-compile: RDP-прореживание', () => {
  it('прореженная кривая отклоняется от плотной ≤ ε, строка короче', () => {
    const grid = buildSpringProgressGridUnchecked(DEFAULT_SPRING, 0, EPSILON)!;
    const result = springProgressLinear(DEFAULT_SPRING, 0, EPSILON)!;
    const nodes = parseLinear(result.easing);

    // Узлов строго меньше плотной сетки, строка строго короче плотной эмиссии.
    expect(nodes.length).toBeLessThan(grid.intervals + 1);
    const densePoints: number[] = [];
    for (let i = 0; i <= grid.intervals; i++) {
      densePoints.push(
        Math.round((i / grid.intervals) * 1e6) / 1e6,
        Math.round(grid.ys[i]! * 1e4) / 1e4,
      );
    }
    expect(result.easing.length).toBeLessThan(toLinear(densePoints).length);

    // Вертикальное отклонение от плотных узлов ≤ ε RDP + квантование IR.
    expect(maxReconstructionError(nodes, grid.ys)).toBeLessThanOrEqual(
      EPSILON + QUANT,
    );
  });
});

// ─── B: произвольный ease — восстановление и hostile-входы ───────────────────

describe('animate linear-compile: easeProgressLinear', () => {
  it('монотонный t² восстанавливается ≤ ε (+квант) и реально прорежен', () => {
    const easing = easeProgressLinear((t) => t * t, DEFAULT_DURATION_MS);
    const nodes = parseLinear(easing);
    expect(nodes.length).toBeLessThan(257);
    const oracle = new Float64Array(4001);
    for (let i = 0; i <= 4000; i++) oracle[i] = (i / 4000) ** 2;
    expect(maxReconstructionError(nodes, oracle)).toBeLessThanOrEqual(
      EPSILON + QUANT,
    );
  });

  it('STANDARD_EASING укладывается в тот же бюджет на фикс. сетке N=256', () => {
    // Обоснование фикс. N: сетка покрывает |f″| ≤ 8εN² ≈ 524; у эталонной
    // кривой |f″| ≲ 6 — тест сверяет фактическую ошибку, а не только вывод.
    const easing = easeProgressLinear(STANDARD_EASING, DEFAULT_DURATION_MS);
    const nodes = parseLinear(easing);
    expect(nodes.length).toBeLessThan(257);
    const oracle = new Float64Array(4001);
    for (let i = 0; i <= 4000; i++) oracle[i] = STANDARD_EASING(i / 4000);
    expect(maxReconstructionError(nodes, oracle)).toBeLessThanOrEqual(
      EPSILON + QUANT,
    );
  });

  it('NaN из ease → LM158 на первом плохом сэмпле, без частичного артефакта', () => {
    const calls: number[] = [];
    const hostile = (t: number): number => {
      calls.push(t);
      return t < 0.5 ? t : Number.NaN;
    };
    let caught: unknown;
    try {
      easeProgressLinear(hostile, DEFAULT_DURATION_MS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe('LM158');
    // Fail-fast: t=0.5 (индекс 128 из 256) — первый NaN; дальше сетка не
    // сэмплируется, сборка артефакта и строки не начинается вовсе.
    expect(calls.length).toBe(129);
    expect(calls.at(-1)).toBe(0.5);
  });

  it('±Infinity из ease → LM158 немедленно', () => {
    expect(() => easeProgressLinear(() => Number.POSITIVE_INFINITY, 100))
      .toThrowError(expect.objectContaining({ code: 'LM158' }) as Error);
    expect(() => easeProgressLinear((t) => (t === 0 ? Number.NEGATIVE_INFINITY : t), 100))
      .toThrowError(expect.objectContaining({ code: 'LM158' }) as Error);
  });

  it('собственный бросок ease всплывает как есть, строка не рождается', () => {
    // Каталожный код не маскирует пользовательскую ошибку (прецедент
    // easingToLinear): диагностика вызывающего дороже унификации кода.
    const boom = new Error('user ease boom');
    const throwing = (t: number): number => {
      if (t > 0.3) throw boom;
      return t;
    };
    expect(() => easeProgressLinear(throwing, DEFAULT_DURATION_MS)).toThrow(boom);
  });

  it('некорректная длительность → LM137 до вызова ease', () => {
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let called = false;
      let caught: unknown;
      try {
        easeProgressLinear((t) => {
          called = true;
          return t;
        }, duration);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MotionParamError);
      expect((caught as MotionParamError).code).toBe('LM137');
      expect(called).toBe(false);
    }
  });
});

// ─── Слоистость: портируемый IR и единственный сериализатор ──────────────────

describe('animate linear-compile: граница IR → сериализатор', () => {
  it('тот же points-массив сериализуется идентично, RDP работает до строки', () => {
    const curve = springProgressCurve(DEFAULT_SPRING, 0)!;
    const composed = springProgressLinear(DEFAULT_SPRING, 0)!;
    expect(toLinear(curve.points)).toBe(composed.easing);
    expect(toLinear(curve.points)).toBe(toLinear(curve.points));
    expect(curve.durationMs).toBe(composed.durationMs);

    // Прореживание произошло на данных ДО сериализации: пар в IR меньше,
    // чем узлов плотной сетки того же ε.
    const grid = buildSpringProgressGridUnchecked(DEFAULT_SPRING, 0, EPSILON)!;
    expect(curve.points.length / 2).toBeLessThan(grid.intervals + 1);

    const easeCurve = easeProgressCurve(STANDARD_EASING, DEFAULT_DURATION_MS);
    expect(toLinear(easeCurve.points))
      .toBe(easeProgressLinear(STANDARD_EASING, DEFAULT_DURATION_MS));
  });

  it('IR — чистые JSON-данные: roundtrip и structuredClone эквивалентны', () => {
    const artifacts = [
      springProgressCurve(BOUNCY, 3)!,
      springProgressCurve(DEFAULT_SPRING, -3)!,
      easeProgressCurve(STANDARD_EASING, DEFAULT_DURATION_MS),
    ];
    for (const curve of artifacts) {
      expect(Array.isArray(curve.points)).toBe(true);
      expect(curve.points.length % 2).toBe(0);
      expect(curve.points.length).toBeGreaterThanOrEqual(4);
      expect(Number.isFinite(curve.durationMs)).toBe(true);
      expect(curve.points.every((n) => typeof n === 'number' && Number.isFinite(n)))
        .toBe(true);

      const roundtrip = JSON.parse(JSON.stringify(curve)) as typeof curve;
      expect(roundtrip).toEqual(curve);
      expect(toLinear(roundtrip.points)).toBe(toLinear(curve.points));
      expect(structuredClone(curve)).toEqual(curve);
    }
  });

  it('offsets строго возрастают от ровно 0 до ровно 1 — контракт раннера', () => {
    const curve = springProgressCurve(DEFAULT_SPRING, -3)!;
    expect(curve.points[0]).toBe(0);
    expect(curve.points[1]).toBe(0);
    expect(curve.points.at(-2)).toBe(1);
    expect(curve.points.at(-1)).toBe(1);
    for (let i = 2; i < curve.points.length; i += 2) {
      expect(curve.points[i]!).toBeGreaterThan(curve.points[i - 2]!);
    }
  });
});

// ─── Детерминизм и контракт отказа ───────────────────────────────────────────

describe('animate linear-compile: детерминизм и undefined-контракт', () => {
  it('одинаковые входы → идентичные артефакты и строки', () => {
    expect(springProgressLinear(BOUNCY, 3)).toEqual(springProgressLinear(BOUNCY, 3));
    expect(springProgressLinear(BOUNCY, 3)!.easing)
      .toBe(springProgressLinear(BOUNCY, 3)!.easing);
    expect(springProgressCurve(OVER, -3)).toEqual(springProgressCurve(OVER, -3));
    expect(easeProgressLinear(STANDARD_EASING, 240))
      .toBe(easeProgressLinear(STANDARD_EASING, 240));
  });

  it('непредставимая синхронной строкой пружина → undefined, не исключение', () => {
    // Слабозатухающий монстр: сетка честной границы кривизны ≫ BASE_GRID_MAX.
    expect(springProgressLinear({ mass: 1, stiffness: 1e20, damping: 26 }, 0))
      .toBeUndefined();
  });

  it('hostile-числа сворачиваются в undefined (fail-closed на живой путь)', () => {
    expect(springProgressLinear(DEFAULT_SPRING, Number.NaN)).toBeUndefined();
    expect(springProgressLinear(DEFAULT_SPRING, Number.POSITIVE_INFINITY))
      .toBeUndefined();
    expect(springProgressLinear(DEFAULT_SPRING, 0, 0)).toBeUndefined();
    expect(springProgressLinear(DEFAULT_SPRING, 0, -1e-3)).toBeUndefined();
    expect(springProgressLinear(DEFAULT_SPRING, 0, Number.NaN)).toBeUndefined();
    expect(springProgressLinear(DEFAULT_SPRING, 0, 1)).toBeUndefined();
    // Незатухающая пружина не оседает — тоже живой путь, не строка и не throw.
    expect(springProgressLinear({ mass: 1, stiffness: 100, damping: 0 }, 0))
      .toBeUndefined();
  });
});
