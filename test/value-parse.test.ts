/**
 * Тест: парсинг CSS-значений.
 * Класс A (Unit): покрывает parseUnit, parseColor, parse.
 * Класс Б (Regression): зафиксированы конкретные выходы parse.
 * Класс Д (Mutation proof): ревёрт логики → RED (описано в комментариях).
 *
 * RED-доказательство:
 *   Убрать ветку RELATIVE_RE.exec → тест "парсит +=10px" падает.
 *   Убрать ветку VAR_RE.exec → тест "парсит var(--x)" падает.
 *   Убрать hex-ветку parseColor → тест "#ff0000" падает.
 *   Убрать hsl-ветку parseColor → тест "hsl(0,100%,50%)" падает.
 */

import { describe, expect, it } from 'vitest';
import { parse, parseColor, parseUnit } from '../src/value/index.js';

// ── parseUnit ─────────────────────────────────────────────────────────────────

describe('parseUnit: чистые числа', () => {
  it('number 0 → unit ""', () => {
    const r = parseUnit(0);
    expect(r).toEqual({ kind: 'unit', value: 0, unit: '' });
  });

  it('number 42 → unit ""', () => {
    const r = parseUnit(42);
    expect(r).toEqual({ kind: 'unit', value: 42, unit: '' });
  });

  it('number -3.14 → unit ""', () => {
    const r = parseUnit(-3.14);
    expect(r).toEqual({ kind: 'unit', value: -3.14, unit: '' });
  });

  it('NaN → clampFinite → 0', () => {
    const r = parseUnit(NaN);
    expect(r).toEqual({ kind: 'unit', value: 0, unit: '' });
  });

  it('+Infinity → clampFinite → MAX_VALUE', () => {
    const r = parseUnit(Infinity);
    expect(r).toEqual({ kind: 'unit', value: Number.MAX_VALUE, unit: '' });
  });

  it('-Infinity → clampFinite → -MAX_VALUE', () => {
    const r = parseUnit(-Infinity);
    expect(r).toEqual({ kind: 'unit', value: -Number.MAX_VALUE, unit: '' });
  });
});

describe('parseUnit: строки с юнитами', () => {
  it('"100px" → unit px', () => {
    expect(parseUnit('100px')).toEqual({ kind: 'unit', value: 100, unit: 'px' });
  });

  it('"50%" → unit %', () => {
    expect(parseUnit('50%')).toEqual({ kind: 'unit', value: 50, unit: '%' });
  });

  it('"360deg" → unit deg', () => {
    expect(parseUnit('360deg')).toEqual({ kind: 'unit', value: 360, unit: 'deg' });
  });

  it('"2rem" → unit rem', () => {
    expect(parseUnit('2rem')).toEqual({ kind: 'unit', value: 2, unit: 'rem' });
  });

  it('"100vh" → unit vh', () => {
    expect(parseUnit('100vh')).toEqual({ kind: 'unit', value: 100, unit: 'vh' });
  });

  it('"50vw" → unit vw', () => {
    expect(parseUnit('50vw')).toEqual({ kind: 'unit', value: 50, unit: 'vw' });
  });

  it('"1.5em" → unit em', () => {
    expect(parseUnit('1.5em')).toEqual({ kind: 'unit', value: 1.5, unit: 'em' });
  });

  it('"3.14rad" → unit rad', () => {
    expect(parseUnit('3.14rad')).toEqual({ kind: 'unit', value: 3.14, unit: 'rad' });
  });

  it('"0.25turn" → unit turn', () => {
    expect(parseUnit('0.25turn')).toEqual({ kind: 'unit', value: 0.25, unit: 'turn' });
  });

  it('"300ms" → unit ms', () => {
    expect(parseUnit('300ms')).toEqual({ kind: 'unit', value: 300, unit: 'ms' });
  });

  it('"1s" → unit s', () => {
    expect(parseUnit('1s')).toEqual({ kind: 'unit', value: 1, unit: 's' });
  });

  it('регистронезависимость "100PX" → unit px', () => {
    const r = parseUnit('100PX');
    expect(r).toMatchObject({ kind: 'unit', value: 100, unit: 'px' });
  });

  it('пробелы вокруг значения обрезаются', () => {
    expect(parseUnit('  50%  ')).toEqual({ kind: 'unit', value: 50, unit: '%' });
  });

  it('отрицательные: "-10px" → unit px', () => {
    expect(parseUnit('-10px')).toEqual({ kind: 'unit', value: -10, unit: 'px' });
  });

  it('научная нотация "1e2px" → 100px', () => {
    expect(parseUnit('1e2px')).toEqual({ kind: 'unit', value: 100, unit: 'px' });
  });
});

describe('parseUnit: относительные значения', () => {
  it('"+=10" → relative + 10 ""', () => {
    expect(parseUnit('+=10')).toEqual({ kind: 'relative', op: '+', amount: 10, unit: '' });
  });

  it('"-=5" → relative - 5 ""', () => {
    expect(parseUnit('-=5')).toEqual({ kind: 'relative', op: '-', amount: 5, unit: '' });
  });

  it('"+=10px" → relative + 10 px', () => {
    expect(parseUnit('+=10px')).toEqual({ kind: 'relative', op: '+', amount: 10, unit: 'px' });
  });

  it('"-=5%" → relative - 5 %', () => {
    expect(parseUnit('-=5%')).toEqual({ kind: 'relative', op: '-', amount: 5, unit: '%' });
  });

  it('"+=0.5rem" → relative + 0.5 rem', () => {
    expect(parseUnit('+=0.5rem')).toEqual({ kind: 'relative', op: '+', amount: 0.5, unit: 'rem' });
  });
});

describe('parseUnit: var()', () => {
  it('"var(--x)" → var --x без fallback', () => {
    expect(parseUnit('var(--x)')).toEqual({ kind: 'var', name: '--x', fallback: undefined });
  });

  it('"var(--color, red)" → var с fallback', () => {
    expect(parseUnit('var(--color, red)')).toEqual({
      kind: 'var', name: '--color', fallback: 'red',
    });
  });

  it('"var(--spacing, 8px)" → var с числовым fallback', () => {
    expect(parseUnit('var(--spacing, 8px)')).toEqual({
      kind: 'var', name: '--spacing', fallback: '8px',
    });
  });

  it('var с пробелами внутри', () => {
    expect(parseUnit('var( --x )')).toMatchObject({ kind: 'var', name: '--x' });
  });
});

describe('parseUnit: ошибки', () => {
  it('не-CSS строка → RangeError', () => {
    expect(() => parseUnit('not-a-value')).toThrow(RangeError);
  });

  it('пустая строка → RangeError', () => {
    expect(() => parseUnit('')).toThrow(RangeError);
  });

  it('#fff → RangeError (не юнит; это цвет)', () => {
    // parseUnit не знает о цветах — бросает RangeError
    expect(() => parseUnit('#fff')).toThrow(RangeError);
  });
});

// ── parseColor ────────────────────────────────────────────────────────────────

describe('parseColor: hex', () => {
  it('#rgb (shorthand)', () => {
    const c = parseColor('#f00');
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('color');
    expect(c!.format).toBe('hex');
    expect(c!.r).toBe(255);
    expect(c!.g).toBe(0);
    expect(c!.b).toBe(0);
    expect(c!.a).toBe(1);
  });

  it('#rrggbb', () => {
    const c = parseColor('#00ff00');
    expect(c!.r).toBe(0);
    expect(c!.g).toBe(255);
    expect(c!.b).toBe(0);
    expect(c!.a).toBe(1);
  });

  it('#rrggbb регистронезависимо', () => {
    const c = parseColor('#FF0000');
    expect(c!.r).toBe(255);
  });

  it('#rgba (shorthand с alpha)', () => {
    const c = parseColor('#f008');
    expect(c).not.toBeNull();
    expect(c!.r).toBe(255);
    expect(c!.a).toBeCloseTo(136 / 255, 5);
  });

  it('#rrggbbaa', () => {
    const c = parseColor('#ff000080');
    expect(c!.r).toBe(255);
    expect(c!.a).toBeCloseTo(0x80 / 255, 5);
  });

  it('нераспознанный → null', () => {
    expect(parseColor('not-a-color')).toBeNull();
  });
});

describe('parseColor: rgb()', () => {
  it('rgb(255, 0, 0)', () => {
    const c = parseColor('rgb(255, 0, 0)');
    expect(c!.r).toBe(255);
    expect(c!.g).toBe(0);
    expect(c!.b).toBe(0);
    expect(c!.a).toBe(1);
    expect(c!.format).toBe('rgb');
  });

  it('rgba(0, 128, 255, 0.5)', () => {
    const c = parseColor('rgba(0, 128, 255, 0.5)');
    expect(c!.r).toBe(0);
    expect(c!.g).toBe(128);
    expect(c!.b).toBe(255);
    expect(c!.a).toBeCloseTo(0.5, 5);
  });
});

describe('parseColor: hsl()', () => {
  it('hsl(0, 100%, 50%) → красный', () => {
    const c = parseColor('hsl(0, 100%, 50%)');
    expect(c).not.toBeNull();
    expect(c!.format).toBe('hsl');
    expect(c!.r).toBeCloseTo(255, 0);
    expect(c!.g).toBeCloseTo(0, 0);
    expect(c!.b).toBeCloseTo(0, 0);
    expect(c!.hsl).toMatchObject({ h: 0, s: 1, l: 0.5 });
  });

  it('hsl(120, 100%, 50%) → зелёный', () => {
    const c = parseColor('hsl(120, 100%, 50%)');
    expect(c!.r).toBeCloseTo(0, 0);
    expect(c!.g).toBeCloseTo(255, 0);
    expect(c!.b).toBeCloseTo(0, 0);
  });

  it('hsl(240, 100%, 50%) → синий', () => {
    const c = parseColor('hsl(240, 100%, 50%)');
    expect(c!.r).toBeCloseTo(0, 0);
    expect(c!.g).toBeCloseTo(0, 0);
    expect(c!.b).toBeCloseTo(255, 0);
  });

  it('hsla(0, 100%, 50%, 0.5)', () => {
    const c = parseColor('hsla(0, 100%, 50%, 0.5)');
    expect(c!.a).toBeCloseTo(0.5, 5);
  });
});

// ── parse (unified) ───────────────────────────────────────────────────────────

describe('parse: unified dispatcher', () => {
  it('число → ParsedUnit', () => {
    const r = parse(100);
    expect(r.kind).toBe('unit');
  });

  it('"100px" → ParsedUnit', () => {
    const r = parse('100px');
    expect(r.kind).toBe('unit');
  });

  it('"#f00" → ParsedColor', () => {
    const r = parse('#f00');
    expect(r.kind).toBe('color');
  });

  it('"rgb(255,0,0)" → ParsedColor', () => {
    const r = parse('rgb(255, 0, 0)');
    expect(r.kind).toBe('color');
  });

  it('"hsl(0,100%,50%)" → ParsedColor', () => {
    const r = parse('hsl(0, 100%, 50%)');
    expect(r.kind).toBe('color');
  });

  it('"var(--x)" → ParsedVar', () => {
    const r = parse('var(--x)');
    expect(r.kind).toBe('var');
  });

  it('"+=10px" → ParsedRelative', () => {
    const r = parse('+=10px');
    expect(r.kind).toBe('relative');
  });

  it('нераспознанная строка → RangeError', () => {
    expect(() => parse('not-valid')).toThrow(RangeError);
  });

  it('невалидный цвет → RangeError (начинается с #)', () => {
    // Начинается с '#' → ветка цвета, но parseColor вернёт null → RangeError
    expect(() => parse('#gg0000')).toThrow(RangeError);
  });
});
