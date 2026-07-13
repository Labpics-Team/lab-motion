/**
 * Внутренний parser фасада возвращает sentinel вместо построения публичных
 * RangeError. Публичный ./value при этом сохраняет прежний контракт один-в-один.
 */

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { parse } from '../src/value/index.js';
import { tryParseValue } from '../src/value/parse.js';
import { parseUnit, tryParseUnit } from '../src/value/units.js';

const VALID = [
  0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '100px',
  ' 50% ',
  '-1.5e2rem',
  '+=10px',
  '-=5%',
  'var(--gap)',
  'var(--gap, calc(100% - 1px))',
  '#f0a',
  '#ff00aa80',
  'rgb(1, 2, 3)',
  'hsl(120, 50%, 25%)',
] as const;

describe('value: internal no-throw parser', () => {
  it('даёт тот же AST, что публичный parse, на полном валидном корпусе', () => {
    for (const value of VALID) {
      expect(tryParseValue(value)).toEqual(parse(value));
    }
  });

  it('unit seam совпадает с parseUnit на числах, юнитах, relative и var()', () => {
    const corpus = VALID.filter((value) =>
      typeof value === 'number' || !/^(?:#|rgba?|hsla?)/i.test(value.trim()),
    );
    for (const value of corpus) {
      expect(tryParseUnit(value)).toEqual(parseUnit(value));
    }
  });

  it('не бросает на invalid и отсекает oversized до regex', () => {
    const invalid = ['', 'nope', '#ggg', 'rgb(nope)', 'var(--open', 'x'.repeat(4097)];
    for (const value of invalid) {
      expect(() => tryParseValue(value)).not.toThrow();
      expect(tryParseValue(value)).toBeUndefined();
    }
    expect(tryParseUnit('x'.repeat(4097))).toBeUndefined();
  });

  it('принимает точную границу 4096 и отклоняет следующий символ', () => {
    const prefix = 'var(--x, ';
    const atLimit = `${prefix}${'x'.repeat(4096 - prefix.length - 1)})`;
    const overLimit = `${prefix}${'x'.repeat(4097 - prefix.length - 1)})`;
    expect(atLimit).toHaveLength(4096);
    expect(tryParseUnit(atLimit)?.kind).toBe('var');
    expect(tryParseUnit(overLimit)).toBeUndefined();
  });

  it('сохраняет точные публичные RangeError и длину после trim', () => {
    expect(() => parseUnit('nope')).toThrowError(
      '@labpics/motion value: не удалось распарсить CSS-значение "nope"',
    );
    expect(() => parse('  nope  ')).toThrowError(
      '@labpics/motion value: не удалось распарсить CSS-значение "nope"',
    );
    expect(() => parse(' #ggg ')).toThrowError(
      '@labpics/motion value: не удалось распарсить цвет " #ggg "',
    );
    expect(() => parseUnit(`  ${'x'.repeat(4097)}  `)).toThrowError(
      '@labpics/motion value: CSS-значение слишком длинное (4097 символов, максимум 4096)',
    );
  });

  it('числовой hostile-корпус всегда даёт конечный unit AST', () => {
    for (const value of [NaN, Infinity, -Infinity, -0, Number.MAX_VALUE]) {
      const ast = tryParseValue(value);
      expect(ast?.kind).toBe('unit');
      expect(Number.isFinite((ast as { value: number }).value)).toBe(true);
    }
  });
});

describe('animate graph: публичная prose-диагностика parser не поставляется', () => {
  it('in-memory production graph не содержит RangeError-строк ./value', async () => {
    const result = await build({
      entryPoints: ['src/animate/index.ts'],
      absWorkingDir: process.cwd(),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
    });
    const code = result.outputFiles[0]!.text;
    expect(code).not.toContain('@labpics/motion value: не удалось распарсить цвет');
    expect(code).not.toContain('@labpics/motion value: не удалось распарсить CSS-значение');
    expect(code).not.toContain('@labpics/motion value: CSS-значение слишком длинное');
  });
});
