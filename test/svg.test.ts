/**
 * test/svg.test.ts — SVG-математика: парсер путей, длина, draw, motion-path.
 * Классы: А (формулы/парсер) + В (fuzz finiteness) + Д (mutation-proof).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый поведенческий блок своим ассертом.
 * Mutation-proof: сломать компактный синтаксис парсера («M10-20») → тест RED;
 * убрать клампы drawPath → «progress=1 → offset строго 0» RED; поменять
 * знак угла в motionPathAt → «angle горизонтальной линии» RED.
 */

import { describe, expect, it } from 'vitest';
import * as svg from '../src/svg/index.js';
import { parsePath, pathLength, drawPath, createMotionPath } from '../src/svg/index.js';
import { MotionParamError } from '../src/index.js';

// ─── parsePath ────────────────────────────────────────────────────────────────

describe('svg/parse: валидные формы', () => {
  it('простой путь M/L/Z', () => {
    const cmds = parsePath('M 10 20 L 30 40 Z');
    expect(cmds.map((c) => c.type)).toEqual(['M', 'L', 'Z']);
    expect(cmds[0].values).toEqual([10, 20]);
    expect(cmds[1].values).toEqual([30, 40]);
  });

  it('компактный синтаксис: «M10-20» (минус как разделитель)', () => {
    const cmds = parsePath('M10-20L-5.5.5');
    expect(cmds[0].values).toEqual([10, -20]);
    // «-5.5.5» = -5.5, 0.5 (вторая точка начинает новое число — SVG-грамматика)
    expect(cmds[1].values).toEqual([-5.5, 0.5]);
  });

  it('относительные команды и повтор аргументов: «m10 10 l10 0 10 0»', () => {
    const cmds = parsePath('m10 10 l10 0 10 0');
    // Повтор аргументов l → две L-команды
    expect(cmds.map((c) => c.type)).toEqual(['m', 'l', 'l']);
  });

  it('экспоненты и arc-флаги впритык: «a1 1 0 011 1»', () => {
    const a = parsePath('M0 0a1 1 0 011 1');
    expect(a[1].type).toBe('a');
    // флаги large-arc/sweep — однозначные цифры даже без пробелов
    expect(a[1].values).toEqual([1, 1, 0, 0, 1, 1, 1]);
  });

  it('научная нотация: «L1e2 -2.5e-1»', () => {
    const cmds = parsePath('M0 0L1e2 -2.5e-1');
    expect(cmds[1].values[0]).toBeCloseTo(100);
    expect(cmds[1].values[1]).toBeCloseTo(-0.25);
  });
});

describe('svg/parse: мусор → MotionParamError (класс: parser fail-fast)', () => {
  for (const bad of ['', '   ', 'X10 10', 'M', 'M 10', 'L10 10', 'M10 10L5', 'M10 10C1 2 3 4 5']) {
    it(`«${bad}» → MotionParamError`, () => {
      expect(() => parsePath(bad)).toThrow(MotionParamError);
    });
  }
});

// ─── pathLength ───────────────────────────────────────────────────────────────

describe('svg/length', () => {
  it('прямая: M0 0 L3 4 → длина 5 (точно)', () => {
    expect(pathLength('M0 0 L3 4')).toBeCloseTo(5, 6);
  });

  it('ломаная с закрытием: квадрат 10×10 → периметр 40', () => {
    expect(pathLength('M0 0 H10 V10 H0 Z')).toBeCloseTo(40, 3);
  });

  it('кубическая аппроксимация окружности r=100 → длина ≈ 2πr (±0.5%)', () => {
    // Стандартная 4-дуговая аппроксимация окружности кубиками (k≈0.5523)
    const k = 55.228474983;
    const d = `M100 0C100 ${k} ${k} 100 0 100C-${k} 100 -100 ${k} -100 0C-100 -${k} -${k} -100 0 -100C${k} -100 100 -${k} 100 0Z`;
    const L = pathLength(d);
    expect(Math.abs(L - 2 * Math.PI * 100) / (2 * Math.PI * 100)).toBeLessThan(0.005);
  });

  it('дуга A: полуокружность r=50 → ≈ πr (±1%)', () => {
    const L = pathLength('M0 0A50 50 0 0 1 100 0');
    expect(Math.abs(L - Math.PI * 50) / (Math.PI * 50)).toBeLessThan(0.01);
  });

  // Класс: мультисубпуть — второй M это ПЕРЕМЕЩЕНИЕ, не сегмент.
  it('два субпутя: длина = сумма субпутей БЕЗ фантомного перехода', () => {
    expect(pathLength('M0 0L10 0M100 100L110 100')).toBeCloseTo(20, 3);
  });

  it('Z затем новый M: тоже без фантома', () => {
    // Квадрат 10×10 (периметр 40) + отрезок длиной 5 в другом месте.
    expect(pathLength('M0 0H10V10H0ZM100 100L103 104')).toBeCloseTo(45, 3);
  });

  it('квадратичная Q: эндпоинты точны, длина ≥ хорды', () => {
    const L = pathLength('M0 0Q50 100 100 0');
    expect(L).toBeGreaterThan(100); // длиннее хорды
    expect(Number.isFinite(L)).toBe(true);
  });

  // Пин коэффициента повышения степени Q→C (2/3): симметричная парабола,
  // середина по длине = середина по параметру = (50, 50).
  // Mutation-proof: 2/3 → 1/2 сдвигает вершину → RED.
  it('Q: вершина параболы (50,50) — пин формулы 2/3', () => {
    const mp = createMotionPath('M0 0Q50 100 100 0');
    const p = mp.at(0.5);
    expect(p.x).toBeCloseTo(50, 0);
    expect(p.y).toBeCloseTo(50, 0);
  });

  // Пин отражения T: контроль = 2·конец − прежний контроль (75,−50);
  // середина второй половины (по симметрии длин) = (75, −25).
  it('T: отражённый контроль — пин формулы (середина второй дуги = (75,−25))', () => {
    const mp = createMotionPath('M0 0Q25 50 50 0T100 0');
    const p = mp.at(0.75);
    expect(p.x).toBeCloseTo(75, 0);
    expect(p.y).toBeCloseTo(-25, 0);
  });
});

// ─── drawPath ─────────────────────────────────────────────────────────────────

describe('svg/draw: stroke-dasharray/offset', () => {
  it('progress=0 → offset = длина (ничего не видно); массив = длина', () => {
    const r = drawPath(100, 0);
    expect(r.strokeDasharray).toBe('100');
    expect(r.strokeDashoffset).toBe(100);
  });

  it('progress=0.25 → offset = 75', () => {
    expect(drawPath(100, 0.25).strokeDashoffset).toBeCloseTo(75);
  });

  it('progress=1 → offset СТРОГО 0 (без float-хвоста)', () => {
    expect(drawPath(100, 1).strokeDashoffset).toBe(0);
  });

  it('принимает и путь строкой: drawPath("M0 0 L3 4", 1) → offset 0, массив 5', () => {
    const r = drawPath('M0 0 L3 4', 1);
    expect(parseFloat(r.strokeDasharray)).toBeCloseTo(5, 4);
    expect(r.strokeDashoffset).toBe(0);
  });

  it('злые входы: NaN/∞ progress и длина → конечные значения', () => {
    for (const p of [NaN, Infinity, -Infinity, 2, -1]) {
      const r = drawPath(100, p);
      expect(Number.isFinite(r.strokeDashoffset)).toBe(true);
    }
    const r2 = drawPath(NaN, 0.5);
    expect(Number.isFinite(r2.strokeDashoffset)).toBe(true);
  });
});

// ─── createMotionPath ─────────────────────────────────────────────────────────

describe('svg/motion-path: точка и угол вдоль пути', () => {
  it('горизонтальная линия: середина = (50,0), угол 0°', () => {
    const mp = createMotionPath('M0 0 L100 0');
    const p = mp.at(0.5);
    expect(p.x).toBeCloseTo(50, 1);
    expect(p.y).toBeCloseTo(0, 4);
    expect(p.angle).toBeCloseTo(0, 1);
  });

  it('вертикальная линия вниз: угол 90°', () => {
    const mp = createMotionPath('M0 0 L0 100');
    expect(mp.at(0.5).angle).toBeCloseTo(90, 1);
  });

  it('t=0 → начало; t=1 → конец (эндпоинты точны)', () => {
    const mp = createMotionPath('M10 20 L110 20');
    expect(mp.at(0).x).toBeCloseTo(10, 4);
    expect(mp.at(1).x).toBeCloseTo(110, 4);
  });

  it('равномерная скорость по ДЛИНЕ (не по параметру): ломаная 3-4-5', () => {
    // M0 0 L30 0 L30 40: длина 70. t=30/70 — угловая точка (30,0).
    const mp = createMotionPath('M0 0 L30 0 L30 40');
    const corner = mp.at(30 / 70);
    expect(corner.x).toBeCloseTo(30, 0);
    expect(corner.y).toBeCloseTo(0, 0);
  });

  it('t вне [0,1] клампится; NaN → 0', () => {
    const mp = createMotionPath('M0 0 L100 0');
    expect(mp.at(5).x).toBeCloseTo(100, 1);
    expect(mp.at(-5).x).toBeCloseTo(0, 4);
    expect(mp.at(NaN).x).toBeCloseTo(0, 4);
  });

  it('length — полная длина пути', () => {
    expect(createMotionPath('M0 0 L3 4').length).toBeCloseTo(5, 4);
  });

  it('мультисубпуть: at() НЕ интерполирует через разрыв (скачок, не проезд)', () => {
    const mp = createMotionPath('M0 0L10 0M100 100L110 100');
    // t=0.5 — ровно граница субпутей (длина 20, разрыв на 10).
    // Чуть до границы — конец первого субпутя, чуть после — начало второго.
    const before = mp.at(0.49);
    const after = mp.at(0.51);
    expect(before.y).toBeCloseTo(0, 3);
    expect(before.x).toBeLessThanOrEqual(10.001);
    expect(after.y).toBeCloseTo(100, 3);
    expect(after.x).toBeGreaterThanOrEqual(99.999);
  });

  it('fuzz: случайные валидные кубики → at(t) всегда конечен', () => {
    let s = 90210;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < 300; i++) {
      const n = () => ((rnd() - 0.5) * 2000).toFixed(2);
      const d = `M${n()} ${n()}C${n()} ${n()} ${n()} ${n()} ${n()} ${n()}`;
      const mp = createMotionPath(d);
      for (const t of [0, rnd(), 1, NaN, Infinity]) {
        const p = mp.at(t);
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        expect(Number.isFinite(p.angle)).toBe(true);
      }
    }
  });
});

// ─── API surface pin ──────────────────────────────────────────────────────────

describe('svg-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(svg).sort()).toEqual([
      'createMotionPath',
      'drawPath',
      'parsePath',
      'pathLength',
    ]);
  });

  it('форма MotionPath (исчерпывающе)', () => {
    const mp = createMotionPath('M0 0 L1 1');
    expect(Object.keys(mp).sort()).toEqual(['at', 'length']);
  });

  it('SSR: node env — не бросает', () => {
    expect(() => {
      parsePath('M0 0 L1 1');
      drawPath(10, 0.5);
      createMotionPath('M0 0 L1 1');
    }).not.toThrow();
  });
});
