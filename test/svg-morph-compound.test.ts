/**
 * test/svg-morph-compound.test.ts — пер-подконтурный морф составных путей.
 *
 * Класс (последний функциональный долг суперсета, GSAP MorphSVG segments /
 * flubber separate-combine): составной d (несколько M/m — дырки, буква «O»)
 * морфится ПО ПАРАМ подконтуров, а не склейкой в один контур. При разном
 * числе подконтуров лишние появляются/исчезают через точку-центроид
 * последнего реального партнёра противоположной стороны (enter/exit-класс).
 *
 * RED-proof: до реализации ресэмплинг склеивает составной путь в один контур —
 * тесты «2 подконтура на p=0.5» красные (в d одна M).
 */

import { describe, expect, it } from 'vitest';
import { interpolatePath } from '../src/svg-morph/index.js';
import { parsePath } from '../src/svg/index.js';

// «O»: внешний квадрат + внутренняя дырка.
const O_FROM = 'M 0 0 L 20 0 L 20 20 L 0 20 Z M 5 5 L 15 5 L 15 15 L 5 15 Z';
// «O» шире: те же два подконтура в других координатах.
const O_TO = 'M 10 0 L 40 0 L 40 20 L 10 20 Z M 18 5 L 32 5 L 32 15 L 18 15 Z';
const SQUARE = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';

function countM(d: string): number {
  return parsePath(d).filter((c) => c.type.toUpperCase() === 'M').length;
}

function subpathBBoxDiag(d: string, index: number): number {
  // Диагональ bbox подконтура №index (по точкам всех команд полилинии).
  const cmds = parsePath(d);
  let group = -1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cmds) {
    if (c.type.toUpperCase() === 'M') group++;
    if (group !== index || c.values.length < 2) continue;
    const x = c.values[c.values.length - 2]!;
    const y = c.values[c.values.length - 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

describe('svg-morph: составные пути морфятся пер-подконтурно', () => {
  it('2↔2: оба подконтура сохраняются на всём протяжении (дырка не склеивается)', () => {
    const f = interpolatePath(O_FROM, O_TO, { samples: 16 });
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(countM(f(p)), `p=${p}`).toBe(2);
    }
  });

  it('2↔2: эндпоинты возвращают оригинальные строки', () => {
    const f = interpolatePath(O_FROM, O_TO);
    expect(f(0)).toBe(O_FROM);
    expect(f(1)).toBe(O_TO);
  });

  it('1↔2: появляющийся подконтур растёт из точки (bbox-диагональ монотонна по p)', () => {
    const f = interpolatePath(SQUARE, O_TO, { samples: 16 });
    const early = subpathBBoxDiag(f(0.1), 1);
    const late = subpathBBoxDiag(f(0.9), 1);
    expect(countM(f(0.5))).toBe(2);
    expect(early).toBeLessThan(late); // рождается малым, вырастает к цели
    expect(early).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(late)).toBe(true);
  });

  it('2↔1: исчезающий подконтур стягивается к точке к концу морфа', () => {
    const f = interpolatePath(O_FROM, SQUARE, { samples: 16 });
    const early = subpathBBoxDiag(f(0.1), 1);
    const late = subpathBBoxDiag(f(0.9), 1);
    expect(countM(f(0.5))).toBe(2);
    expect(late).toBeLessThan(early); // стягивается к точке исчезновения
  });

  it('относительный m в середине пути абсолютизируется корректно', () => {
    // Старт первого подконтура НЕнулевой — иначе относительный m численно
    // совпадает с абсолютным и мутация абсолютизации невидима (урок диверсии).
    // После Z текущая точка = старт подконтура (10,10) → m 5 5 ≡ M 15 15.
    const relForm = 'M 10 10 L 30 10 L 30 30 L 10 30 Z m 5 5 L 25 15 L 25 25 L 15 25 Z';
    const absForm = 'M 10 10 L 30 10 L 30 30 L 10 30 Z M 15 15 L 25 15 L 25 25 L 15 25 Z';
    const f = interpolatePath(relForm, O_TO, { samples: 16 });
    const mid = f(0.5);
    expect(countM(mid)).toBe(2);
    // Первая точка второго подконтура на p=0.5 — среднее (15,15)↔(18,5) = (16.5, 10).
    const cmds = parsePath(mid);
    const secondM = cmds.filter((c) => c.type.toUpperCase() === 'M')[1]!;
    expect(secondM.values[0]).toBeCloseTo(16.5, 3);
    expect(secondM.values[1]).toBeCloseTo(10, 3);
    // Дифференциал: относительная и абсолютная записи одного пути дают
    // идентичный морф (абсолютизация — чистая нормализация).
    expect(f(0.5)).toBe(interpolatePath(absForm, O_TO, { samples: 16 })(0.5));
  });

  it('детерминизм: два независимых интерполятора дают идентичные строки', () => {
    const a = interpolatePath(O_FROM, O_TO, { samples: 16 })(0.37);
    const b = interpolatePath(O_FROM, O_TO, { samples: 16 })(0.37);
    expect(a).toBe(b);
  });

  it('CSS-safe: NaN p → 0 (оригинал from), координаты промежуточных конечны', () => {
    const f = interpolatePath(O_FROM, O_TO, { samples: 8 });
    expect(f(NaN)).toBe(O_FROM);
    const cmds = parsePath(f(0.5));
    for (const c of cmds) for (const v of c.values) expect(Number.isFinite(v)).toBe(true);
  });

  it('пары подконтуров с совпадающей структурой морфятся точно (кривые остаются кривыми)', () => {
    // Оба подконтура — кубики одинаковой структуры: точный режим внутри пары.
    const c1 = 'M 0 0 C 5 0 10 5 10 10 Z M 20 20 C 25 20 30 25 30 30 Z';
    const c2 = 'M 2 2 C 7 2 12 7 12 12 Z M 24 24 C 29 24 34 29 34 34 Z';
    const mid = interpolatePath(c1, c2)(0.5);
    const cmds = parsePath(mid);
    // Кривые не порезаны в полилинию: тип C сохранён в обоих подконтурах.
    expect(cmds.filter((c) => c.type === 'C')).toHaveLength(2);
    expect(cmds[1]!.values).toEqual([6, 1, 11, 6, 11, 11]);
  });
});
