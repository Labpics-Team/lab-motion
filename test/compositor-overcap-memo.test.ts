/**
 * compositor-overcap-memo.test.ts — ПИН СТОИМОСТИ отказа (ревью #246).
 *
 * ЗАЧЕМ: до #228 отказ по физическому капу был O(1) (формула global worst-case).
 * С #228 предикат компилируемости — сама попытка построения адаптивной сетки,
 * поэтому честный отказ доходит до BASE_GRID_MAX узлов: ~4096 вызовов солвера.
 * Вернуть прежнюю O(1)-формулу как «предфильтр» нельзя — она НЕСОСТОЯТЕЛЬНА
 * (отвергала пружины, которые адаптивная сетка компилирует; это и был смысл
 * #228). Значит дешеветь обязан ПОВТОРНЫЙ отказ: over-cap рождается на живом
 * жесте, где animate()/retarget зовут компиляцию каждый кадр с тем же ключом.
 *
 * Прежний пин этого свойства назывался «отвергается ДО построения» и был
 * переименован вместе со снятием свойства — без замены. Здесь свойство
 * измеряется напрямую числом вызовов солвера, а не формулировкой.
 *
 * Mutation proof: убрать store(OVER_CAP) в curve.ts → «повторный отказ не
 * строит сетку» RED; вернуть sentinel наружу (не гасить в undefined) →
 * «sentinel не протекает наружу» RED.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/internal/solver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/internal/solver.js')>();
  return { ...actual, solveSpring: vi.fn(actual.solveSpring) };
});

import {
  clearSpringExecutionArtifactCacheUnchecked,
  compileSpringExecutionArtifactTupleUnchecked,
  tryCompileSpringExecutionArtifactTupleUnchecked,
} from '../src/compositor/curve';
import { MotionParamError } from '../src/errors';
import { solveSpring } from '../src/internal/solver.js';

const OVER_CAP_SPRING = { mass: 1, stiffness: 100, damping: 40 };
const OVER_CAP_V0 = 1e7;
const TOL = 1e-5;

const solverCalls = () => (solveSpring as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

describe('#246: отказ по физическому капу платится один раз на ключ', () => {
  beforeEach(() => {
    clearSpringExecutionArtifactCacheUnchecked();
    vi.mocked(solveSpring).mockClear();
  });

  it('первый отказ строит сетку, повторный — не зовёт солвер вообще', () => {
    const first = tryCompileSpringExecutionArtifactTupleUnchecked(
      OVER_CAP_SPRING, OVER_CAP_V0, TOL,
    );
    expect(first).toBeUndefined();
    // Анти-вырожденность: без реального построения тест ничего бы не пинил.
    const buildCost = solverCalls();
    expect(buildCost).toBeGreaterThan(1000);

    vi.mocked(solveSpring).mockClear();
    for (let i = 0; i < 5; i++) {
      expect(tryCompileSpringExecutionArtifactTupleUnchecked(
        OVER_CAP_SPRING, OVER_CAP_V0, TOL,
      )).toBeUndefined();
    }
    expect(solverCalls()).toBe(0);
  });

  it('сброс кэша возвращает честное построение (memo — не вечная память)', () => {
    tryCompileSpringExecutionArtifactTupleUnchecked(OVER_CAP_SPRING, OVER_CAP_V0, TOL);
    clearSpringExecutionArtifactCacheUnchecked();
    vi.mocked(solveSpring).mockClear();
    expect(tryCompileSpringExecutionArtifactTupleUnchecked(
      OVER_CAP_SPRING, OVER_CAP_V0, TOL,
    )).toBeUndefined();
    expect(solverCalls()).toBeGreaterThan(1000);
  });

  it('sentinel не протекает наружу: fail-fast путь остаётся LM016', () => {
    tryCompileSpringExecutionArtifactTupleUnchecked(OVER_CAP_SPRING, OVER_CAP_V0, TOL);
    // Второй вызов идёт по memo — и обязан бросить тот же LM016, а не отдать
    // пустой артефакт (пустая кривая уехала бы в WAAPI как duration 0).
    expect(() => compileSpringExecutionArtifactTupleUnchecked(
      OVER_CAP_SPRING, OVER_CAP_V0, TOL,
    )).toThrow(MotionParamError);
  });

  it('memo одного ключа не мешает компиляции соседних пружин', () => {
    expect(tryCompileSpringExecutionArtifactTupleUnchecked(
      OVER_CAP_SPRING, OVER_CAP_V0, TOL,
    )).toBeUndefined();
    // Тот же spring, другая скорость — другой ключ, честная компиляция.
    const ok = tryCompileSpringExecutionArtifactTupleUnchecked(OVER_CAP_SPRING, 0, TOL);
    expect(ok).toBeDefined();
    expect(ok![0].startsWith('linear(')).toBe(true);
    expect(ok![2]).toBeGreaterThan(0);
    // И memo over-cap ключа не испортилось соседом.
    expect(tryCompileSpringExecutionArtifactTupleUnchecked(
      OVER_CAP_SPRING, OVER_CAP_V0, TOL,
    )).toBeUndefined();
  });
});
