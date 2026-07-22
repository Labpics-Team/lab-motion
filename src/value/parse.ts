/** Общий parser-контур: public throw-API и внутренний no-throw seam. */

import { parseColor, type ParsedColor } from './color.js';
import {
  parseUnit,
  tryParseUnit,
  type ParsedRelative,
  type ParsedUnit,
  type ParsedVar,
} from './units.js';

/** AST числа/юнита, relative, var() или цвета. */
export type ValueAST = ParsedUnit | ParsedRelative | ParsedVar | ParsedColor;

/** Строка выглядит цветом (hex/rgb()/hsl()); `a?`-хвост покрыт префиксом. */
function looksLikeColor(source: string): boolean {
  return source.startsWith('#') || /^(?:rgb|hsl)/i.test(source);
}

/** Внутренняя граница: invalid возвращает undefined и не строит RangeError. */
export function tryParseValue(value: string | number): ValueAST | undefined {
  if (typeof value === 'number') return tryParseUnit(value);
  const source = value.trim();
  return looksLikeColor(source) ? parseColor(source) ?? undefined : tryParseUnit(source);
}

/** Публичный parser сохраняет прежние типы ошибок и сообщения дословно. */
export function parse(value: string | number): ValueAST {
  if (typeof value === 'number') return parseUnit(value);
  const source = value.trim();
  if (looksLikeColor(source)) {
    const color = parseColor(source);
    if (color) return color;
    throw new RangeError(`@labpics/motion value: не удалось распарсить цвет "${value}"`);
  }
  return parseUnit(source);
}
