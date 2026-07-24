/**
 * coverage-gate.test.ts — пины ратчета покрытия (scripts/coverage-gate.mjs).
 *
 * ЗАЧЕМ: гейт существует ради одного класса дефектов — «код приехал, а тест в
 * него не заходит». Если бы он сам был не проверен, он повторил бы ровно ту
 * ошибку, ради которой написан. Здесь проверяется его ЧИСТОЕ ядро на
 * синтетических сводках: агрегация по областям, детектор нулевого покрытия,
 * провал по полу и требование вписать новую область.
 *
 * Mutation proof: убрать проверку `metrics.lines.covered === 0` → «файл без
 * покрытия» RED; смягчить сравнение с полом на `<=` → «пол не понижается» RED.
 */

import { describe, expect, it } from 'vitest';
import { areaOf, evaluateCoverage } from '../scripts/coverage-gate.mjs';

const FLOORS = { animate: { lines: 90, branches: 80 }, nano: { lines: 95, branches: 90 } };
const TOTALS = { lines: 90, branches: 80, functions: 90 };

function summary(files: Record<string, [covered: number, total: number, bCov: number, bTot: number]>) {
  const entries: Record<string, unknown> = {};
  let lc = 0; let lt = 0; let bc = 0; let bt = 0;
  for (const [path, [covered, total, bCov, bTot]] of Object.entries(files)) {
    entries[path] = {
      lines: { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 },
      branches: { covered: bCov, total: bTot, pct: bTot === 0 ? 100 : (bCov / bTot) * 100 },
      functions: { covered: 1, total: 1, pct: 100 },
      statements: { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 },
    };
    lc += covered; lt += total; bc += bCov; bt += bTot;
  }
  entries['total'] = {
    lines: { covered: lc, total: lt, pct: (lc / lt) * 100 },
    branches: { covered: bc, total: bt, pct: (bc / bt) * 100 },
    functions: { covered: 1, total: 1, pct: 100 },
    statements: { covered: lc, total: lt, pct: (lc / lt) * 100 },
  };
  return entries;
}

describe('#coverage-gate: область файла', () => {
  it('вложенный путь даёт имя каталога, корневой файл — root', () => {
    expect(areaOf('/repo/src/animate/index.ts')).toBe('animate');
    expect(areaOf('/repo/src/compiler/runtime/index.ts')).toBe('compiler');
    expect(areaOf('/repo/src/spring.ts')).toBe('root');
  });
});

describe('#coverage-gate: ратчет', () => {
  it('покрытие выше пола — PASS без провалов', () => {
    const result = evaluateCoverage(
      summary({ '/r/src/animate/a.ts': [95, 100, 9, 10] }),
      FLOORS,
      TOTALS,
    );
    expect(result.failures).toEqual([]);
    expect(result.rows[0]!.ok).toBe(true);
  });

  it('падение ниже пола — провал с именем области и числами', () => {
    const result = evaluateCoverage(
      summary({ '/r/src/animate/a.ts': [80, 100, 9, 10] }),
      FLOORS,
      TOTALS,
    );
    expect(result.failures.some((f: string) => f.includes('animate: строки 80.00%'))).toBe(true);
    expect(result.rows[0]!.ok).toBe(false);
  });

  it('файл с исполнимым кодом и нулевым покрытием — провал даже при высоком проценте области', () => {
    // Область в среднем 95 % — выше пола; но ОДИН файл не исполняется вовсе.
    const result = evaluateCoverage(
      summary({
        '/r/src/animate/a.ts': [190, 190, 19, 19],
        '/r/src/animate/newcomer.ts': [0, 10, 0, 2],
      }),
      FLOORS,
      TOTALS,
    );
    expect(result.uncovered).toEqual(['animate/newcomer.ts']);
    expect(result.failures.some((f: string) => f.includes('не исполняются ни одним тестом'))).toBe(true);
  });

  it('новая область без пола — провал «впишите её», а не тихий пропуск', () => {
    const result = evaluateCoverage(
      summary({ '/r/src/brandnew/x.ts': [10, 10, 2, 2] }),
      FLOORS,
      TOTALS,
    );
    expect(result.failures.some((f: string) => f.includes('«brandnew» не имеет пола'))).toBe(true);
    expect(result.rows).toHaveLength(0);
  });

  it('пол ровно достигнут — это PASS (граница не строгая сверху)', () => {
    const result = evaluateCoverage(
      summary({ '/r/src/animate/a.ts': [90, 100, 8, 10] }),
      FLOORS,
      TOTALS,
    );
    expect(result.failures).toEqual([]);
  });

  it('обгон пола больше чем на 1.5 п.п. просит затянуть ратчет', () => {
    const result = evaluateCoverage(
      summary({ '/r/src/animate/a.ts': [99, 100, 10, 10] }),
      FLOORS,
      TOTALS,
    );
    expect(result.tighten.some((t: string) => t.startsWith('animate →'))).toBe(true);
  });

  it('файл без исполнимых строк не считается непокрытым', () => {
    const result = evaluateCoverage(
      summary({ '/r/src/nano/types.ts': [0, 0, 0, 0], '/r/src/nano/i.ts': [100, 100, 10, 10] }),
      FLOORS,
      TOTALS,
    );
    expect(result.uncovered).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});
