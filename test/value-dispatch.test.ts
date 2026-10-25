import { expect, it } from 'vitest';
import { tryParseValue } from '../src/value/parse.js';

// WhiteSpace и LineTerminator ECMAScript: это также набор String#trim.
const whitespace = [
  '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
  '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
];

it.each(whitespace)('CSS dispatch сохраняет крайний whitespace %j', space => {
  const read = (input: string) => tryParseValue(space + input + space);
  expect(read('#abc')).toEqual({ kind: 'color', format: 'hex', r: 170, g: 187, b: 204, a: 1 });
  expect(read('RGBA(1,2,3,0.5)')).toEqual({ kind: 'color', format: 'rgb', r: 1, g: 2, b: 3, a: 0.5 });
  expect(read('HsL(120,100%,50%)')).toEqual({
    kind: 'color', format: 'hsl', r: 0, g: 255, b: 0, a: 1, hsl: { h: 120, s: 1, l: 0.5 },
  });
  expect(read('12px')).toEqual({ kind: 'unit', value: 12, unit: 'px' });
  expect(read('+=2px')).toEqual({ kind: 'relative', op: '+', amount: 2, unit: 'px' });
  expect(read('var(--accent, #fff)')).toEqual({ kind: 'var', name: '--accent', fallback: '#fff' });
});

it.each(['\u0085', '\u180e', '\u200b'])('не-whitespace %j не открывает CSS prefix', prefix => {
  expect(tryParseValue(prefix + '#fff')).toBeUndefined();
  expect(tryParseValue(prefix + 'rgb(1,2,3)')).toBeUndefined();
  expect(tryParseValue(prefix + '12px')).toBeUndefined();
});

it('CSS dispatch не расширяет грамматику неполных цветовых prefixes', () => {
  for (const input of ['#oops', 'rgb', 'rgba(', 'rgbSuffix', 'hsl', 'hsla(', 'hslSuffix']) {
    expect(tryParseValue(' \t' + input + '\n')).toBeUndefined();
  }
});

it('parser limits применяются после trim и сохраняют отдельную грамматику цветов', () => {
  const padding = ' '.repeat(4097);
  expect(tryParseValue(padding)).toBeUndefined();
  expect(tryParseValue(padding + '12px' + padding)).toEqual({ kind: 'unit', value: 12, unit: 'px' });
  expect(tryParseValue('1'.repeat(4097))).toBeUndefined();
  expect(tryParseValue('rgb(' + padding + '1,2,3)')).toEqual({
    kind: 'color', format: 'rgb', r: 1, g: 2, b: 3, a: 1,
  });
});
