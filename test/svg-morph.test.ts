/**
 * test/svg-morph.test.ts — морфинг путей (subpath ./svg-morph, S17).
 * Классы: А (точный режим/ресэмплинг известных фигур) + В (property
 * «выход всегда парсится и конечен», fuzz злых p, выравнивание замкнутых) + Д.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падают все поведенческие блоки.
 * Mutation-proof: сломать lerp (1−p → p) → «точный режим p=0.5» RED; отключить
 * выравнивание стартовой точки → property замкнутых квадратов RED; сломать
 * кламп p → fuzz злых p RED; сломать детекцию структуры → точный режим RED.
 *
 * Заземление: D10 (morph = класс GSAP MorphSVGPlugin / anime.js morphTo;
 * у Motion морфа нет — скоуп-сигнал суперсета).
 */

import { describe, expect, it } from 'vitest';
import * as morph from '../src/svg-morph/index.js';
import { interpolatePath } from '../src/svg-morph/index.js';
import { createMotionPath, parsePath } from '../src/svg/index.js';
import { MotionParamError } from '../src/index.js';

// ─── Точный режим (совпадающая структура команд) ─────────────────────────────

describe('svg-morph: точный режим — структура команд совпадает', () => {
  const dFrom = 'M 0 0 L 10 0 L 10 10';
  const dTo = 'M 20 20 L 40 20 L 40 40';

  it('p=0.5 → покомпонентная середина значений', () => {
    const f = interpolatePath(dFrom, dTo);
    const mid = parsePath(f(0.5));
    expect(mid.map((c) => c.type)).toEqual(['M', 'L', 'L']);
    expect(mid[0]!.values).toEqual([10, 10]);
    expect(mid[1]!.values).toEqual([25, 10]);
    expect(mid[2]!.values).toEqual([25, 25]);
  });

  it('эндпоинты возвращают ОРИГИНАЛЬНЫЕ строки (без потери качества)', () => {
    const f = interpolatePath(dFrom, dTo);
    expect(f(0)).toBe(dFrom);
    expect(f(1)).toBe(dTo);
  });

  it('кривые Безье интерполируются точно (C-команды)', () => {
    const a = 'M 0 0 C 10 0 20 10 30 10';
    const b = 'M 10 10 C 20 10 30 20 40 20';
    const mid = parsePath(interpolatePath(a, b)(0.5));
    expect(mid[1]!.values).toEqual([15, 5, 25, 15, 35, 15]);
  });

  it('характеризация скоуп-предела: открытые противонаправленные пути lerp как есть (без пере-выравнивания)', () => {
    // У открытого пути нет winding'а: реверс менял бы семантику стартовой
    // точки анимации. Соответствие точек — контракт порядка у потребителя.
    const f = interpolatePath('M 0 0 L 10 10', 'M 10 10 L 0 0');
    const mid = parsePath(f(0.5));
    expect(mid[0]!.values).toEqual([5, 5]);
    expect(mid[1]!.values).toEqual([5, 5]); // осознанное схлопывание — контракт
  });

  it('дуги (A) не интерполируются покомпонентно — уходят в ресэмплинг (флаги неинтерполируемы)', () => {
    const a = 'M 0 0 A 10 10 0 0 1 20 0';
    const b = 'M 0 0 A 20 20 0 0 1 40 0';
    const f = interpolatePath(a, b, { samples: 16 });
    const mid = parsePath(f(0.5)); // полилиния из сэмплов, не A-команда
    expect(mid.some((c) => c.type === 'A' || c.type === 'a')).toBe(false);
    expect(mid.length).toBeGreaterThan(3);
  });
});

// ─── Ресэмплинг (структура не совпадает) ─────────────────────────────────────

describe('svg-morph: ресэмплинг — разные структуры', () => {
  const tri = 'M 0 0 L 10 0 L 5 10 Z';
  const square = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';

  it('выход — валидный путь из samples точек, замкнутый для двух замкнутых', () => {
    const f = interpolatePath(tri, square, { samples: 32 });
    const cmds = parsePath(f(0.5));
    expect(cmds[0]!.type).toBe('M');
    expect(cmds[cmds.length - 1]!.type.toUpperCase()).toBe('Z');
    expect(cmds.length).toBe(32 + 1); // M + 31·L + Z = 33 команды на 32 точки
  });

  it('эндпоинты — оригинальные строки', () => {
    const f = interpolatePath(tri, square, { samples: 16 });
    expect(f(0)).toBe(tri);
    expect(f(1)).toBe(square);
  });

  it('интерьер геометрически между фигурами: точки p=0.5 лежат между границами', () => {
    const f = interpolatePath(tri, square, { samples: 64 });
    const mp = createMotionPath(f(0.5));
    // Обе фигуры в [0,10]×[0,10] — середина не может выйти за bbox объединения
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const pt = mp.at(t);
      expect(pt.x).toBeGreaterThanOrEqual(-0.01);
      expect(pt.x).toBeLessThanOrEqual(10.01);
      expect(pt.y).toBeGreaterThanOrEqual(-0.01);
      expect(pt.y).toBeLessThanOrEqual(10.01);
    }
  });

  it('выравнивание замкнутых: квадрат → тот же квадрат с другой стартовой вершиной ≈ неподвижен', () => {
    // Без выравнивания стартовых точек midpoint «проворачивается» и уезжает
    // от фигуры; с выравниванием p=0.5 остаётся ≈ тем же квадратом.
    const sq1 = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
    const sq2 = 'M 10 10 L 0 10 L 0 0 L 10 0 Z'; // старт с противоположного угла
    const f = interpolatePath(sq1, sq2, { samples: 64 });
    const mp = createMotionPath(f(0.5));
    // каждая сэмпл-точка midpoint обязана лежать НА периметре квадрата
    // (расстояние до ближайшей стороны < 0.75 — допуск полилинии 64 точек)
    for (let i = 0; i <= 20; i++) {
      const { x, y } = mp.at(i / 20);
      const dEdge = Math.min(
        Math.abs(x - 0),
        Math.abs(x - 10),
        Math.abs(y - 0),
        Math.abs(y - 10),
      );
      expect(dEdge).toBeLessThan(0.75);
    }
  });

  it('выравнивание с реверсом: квадрат с ПРОТИВОПОЛОЖНЫМ обходом ≈ неподвижен', () => {
    // Пути из разных редакторов часто различаются winding'ом — выравнивание
    // обязано пробовать оба направления, иначе морф «схлопывается» через центр.
    const cw = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
    const ccw = 'M 0 0 L 0 10 L 10 10 L 10 0 Z';
    const f = interpolatePath(cw, ccw, { samples: 64 });
    const mp = createMotionPath(f(0.5));
    for (let i = 0; i <= 20; i++) {
      const { x, y } = mp.at(i / 20);
      const dEdge = Math.min(Math.abs(x), Math.abs(x - 10), Math.abs(y), Math.abs(y - 10));
      expect(dEdge).toBeLessThan(0.75);
    }
  });

  it('замкнутый выход без дублирующей точки шва (сетка i/K, не i/(K−1))', () => {
    // Дубль первой точки в конце создаёт нулевой сегмент на шве и искажает
    // равномерность распределения точек (двойная плотность у старта).
    const f = interpolatePath(tri, square, { samples: 8 });
    const cmds = parsePath(f(0.5));
    const first = cmds[0]!.values;
    const lastL = cmds[cmds.length - 2]!.values; // последняя L перед Z
    const dist = Math.hypot(first[0]! - lastL[0]!, first[1]! - lastL[1]!);
    expect(dist).toBeGreaterThan(0.1);
  });

  it('незамкнутый → замкнутый: выход без Z (честно открытый)', () => {
    const open = 'M 0 0 L 10 0';
    const f = interpolatePath(open, square, { samples: 16 });
    const cmds = parsePath(f(0.5));
    expect(cmds[cmds.length - 1]!.type.toUpperCase()).not.toBe('Z');
  });
});

// ─── Скоуп-пределы (характеризация — контракт, не дефект) ────────────────────

describe('svg-morph: характеризация скоуп-пределов', () => {
  it('составной путь (M…Z M…Z) морфится пер-подконтурно (контракт s30)', () => {
    // Прежний скоуп-предел «склейка в один контур» снят: подконтуры
    // сопоставляются по порядку, лишний исчезает через центроид партнёра.
    const compound = 'M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 20 L 30 30 Z';
    const square = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
    const cmds = parsePath(interpolatePath(compound, square, { samples: 16 })(0.5));
    expect(cmds.filter((c) => c.type.toUpperCase() === 'M')).toHaveLength(2);
    expect(cmds.filter((c) => c.type.toUpperCase() === 'Z')).toHaveLength(2);
  });

  it('относительные команды (l) в точном режиме lerp\'аются посегментно как есть', () => {
    const f = interpolatePath('M 0 0 l 10 0 l 0 10', 'M 5 5 l 20 0 l 0 20');
    const mid = parsePath(f(0.5));
    expect(mid[0]!.values).toEqual([2.5, 2.5]);
    expect(mid[1]!.type).toBe('l'); // регистр сохранён
    expect(mid[1]!.values).toEqual([15, 0]);
    expect(f(0)).toBe('M 0 0 l 10 0 l 0 10'); // эндпоинт-оригинал
  });

  it('точность формата: дробные значения не округляются до целых', () => {
    const mid = parsePath(interpolatePath('M 0 0 L 1 0', 'M 0 0 L 2 0')(0.5));
    expect(mid[1]!.values).toEqual([1.5, 0]);
  });

  it('открытый ресэмплинг достигает эндпоинтов форм (первая/последняя точки сетки)', () => {
    // Разные структуры двух ОТКРЫТЫХ путей → ресэмплинг; сетка i/(K−1) обязана
    // включать t=0 и t=1, иначе выход обрезан с конца.
    const f = interpolatePath('M 0 0 L 10 0', 'M 0 10 L 5 10 L 10 10', { samples: 64 });
    const cmds = parsePath(f(0.5));
    const first = cmds[0]!.values;
    const last = cmds[cmds.length - 1]!.values;
    expect(first[0]).toBeCloseTo(0, 6);
    expect(first[1]).toBeCloseTo(5, 6);
    expect(last[0]).toBeCloseTo(10, 6); // середина концов (10,0) и (10,10)
    expect(last[1]).toBeCloseTo(5, 6);
  });
});

// ─── Валидация и злые входы ──────────────────────────────────────────────────

describe('svg-morph: валидация', () => {
  it('мусорные пути → MotionParamError (fail-fast парсера)', () => {
    expect(() => interpolatePath('мусор', 'M 0 0 L 1 1')).toThrow(MotionParamError);
    expect(() => interpolatePath('M 0 0', '')).toThrow(MotionParamError);
  });

  it('невалидный samples → MotionParamError', () => {
    for (const samples of [1, 0, -4, 2.5, NaN, Infinity]) {
      expect(() => interpolatePath('M 0 0 L 1 1', 'M 2 2 L 3 3', { samples })).toThrow(
        MotionParamError,
      );
    }
  });

  it('fuzz: злые p (NaN/±Infinity/вне [0,1]) → кламп, выход всегда парсится и конечен', () => {
    const f = interpolatePath('M 0 0 L 10 0 L 5 10 Z', 'M 0 0 L 10 0 L 10 10 L 0 10 Z', {
      samples: 16,
    });
    expect(f(NaN)).toBe(f(0));
    expect(f(-5)).toBe(f(0));
    expect(f(Infinity)).toBe(f(1));
    for (const p of [0.001, 0.33, 0.77, 0.999]) {
      const cmds = parsePath(f(p));
      for (const c of cmds) for (const v of c.values) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('вырожденные пути (нулевая длина) не роняют', () => {
    const f = interpolatePath('M 5 5 L 5 5', 'M 0 0 L 10 10', { samples: 8 });
    expect(() => parsePath(f(0.5))).not.toThrow();
  });
});

// ─── Детерминизм и поверхность ───────────────────────────────────────────────

describe('svg-morph-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(morph).sort()).toEqual(['interpolatePath']);
  });

  it('SSR: import + вызовы в node env не бросают', () => {
    expect(() => interpolatePath('M 0 0 L 1 1', 'M 2 2 L 3 3')(0.5)).not.toThrow();
  });

  it('детерминизм: одинаковые входы → бит-в-бит одинаковые строки', () => {
    const mk = () =>
      interpolatePath('M 0 0 L 10 0 L 5 10 Z', 'M 0 0 L 10 0 L 10 10 L 0 10 Z', { samples: 32 })(
        0.37,
      );
    expect(mk()).toBe(mk());
  });
});
