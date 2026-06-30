/**
 * @labpics/motion — subpath ./value
 *
 * Headless zero-DOM value-model: парсинг и интерполяция CSS-значений.
 *
 * Публичный API (инвариант 6 — закреплён в value-api-surface-pin.test.ts):
 *
 *   parse()             — единый разбор: числа, юниты, цвета, var(), +=/-=
 *   interpolate()       — интерполяция любых ValueAST по прогрессу t
 *   mixColor()          — удобная обёртка для смешения двух CSS-цветов (строки)
 *   buildTransform()    — CSS transform-строка из TransformState
 *   interpolateTransform() — интерполяция TransformState → CSS строка
 *
 * Типы (type-only, стираются при рантайме):
 *   ValueAST, ParsedUnit, ParsedRelative, ParsedVar, ParsedColor, TransformState
 *
 * Инварианты:
 *   - Zero runtime deps (нет внешних npm-зависимостей)
 *   - TypeScript strict
 *   - FINITENESS GUARD: никаких NaN/Infinity на выходе при любых входах
 *   - SSR-safe: нет window/document на импорте
 */

// ── Re-exports: типы ─────────────────────────────────────────────────────────
export type { ParsedUnit, ParsedRelative, ParsedVar } from './units.js';
export type { ParsedColor } from './color.js';
export type { TransformState } from './transform.js';

// ── Re-exports: функции ──────────────────────────────────────────────────────
export { parseUnit, interpolateUnit } from './units.js';
export { parseColor, interpolateColor, mixColor, hslToRgb, rgbToHsl } from './color.js';
export { buildTransform, interpolateTransform } from './transform.js';

// ── Unified parse / interpolate ──────────────────────────────────────────────

import { type ParsedUnit, type ParsedRelative, type ParsedVar, parseUnit, interpolateUnit, clampFinite } from './units.js';
import { type ParsedColor, parseColor, interpolateColor } from './color.js';

/**
 * Дискриминированный тип для всех разбираемых CSS-значений.
 *
 * kind='unit'     — числовое с юнитом или без (px, %, deg, …)
 * kind='relative' — относительное: +=10px, -=5
 * kind='var'      — CSS custom property: var(--name)
 * kind='color'    — CSS цвет: #hex, rgb(), hsl()
 */
export type ValueAST = ParsedUnit | ParsedRelative | ParsedVar | ParsedColor;

/**
 * Единая точка парсинга CSS-значения → ValueAST.
 *
 * Обнаружение по эвристике:
 *   1. Число → ParsedUnit (unitless)
 *   2. Строка "#..." или "rgb..." или "hsl..." → ParsedColor
 *   3. Строка "var(..." → ParsedVar
 *   4. Строка "+=..." / "-=..." → ParsedRelative
 *   5. Строка с числом + юнит → ParsedUnit
 *
 * @throws RangeError если значение не распознаётся
 */
export function parse(value: string | number): ValueAST {
  if (typeof value === 'number') {
    return parseUnit(value);
  }
  const s = value.trim();

  // Пробуем цвет в первую очередь (специфичный префикс)
  if (s.startsWith('#') || /^rgba?/i.test(s) || /^hsla?/i.test(s)) {
    const color = parseColor(s);
    if (color) return color;
    throw new RangeError(`@labpics/motion value: не удалось распарсить цвет "${value}"`);
  }

  // Всё остальное → parseUnit (юниты, var(), относительные)
  return parseUnit(s);
}

/**
 * Интерполирует два ValueAST при нормированном прогрессе t ∈ [0,1].
 *
 * Правила:
 *   ParsedUnit/Relative/Var — делегирует в interpolateUnit
 *   ParsedColor × ParsedColor — делегирует в interpolateColor
 *   Разные kind → дискретный свап (from при t<0.5, to при t>=0.5)
 *
 * FINITENESS GUARD: вывод НИКОГДА не содержит NaN или Infinity.
 *
 * @param from     - начальное ValueAST
 * @param to       - конечное ValueAST
 * @param t        - прогресс; hostile-t (NaN, ±Infinity) безопасен
 * @returns строка с CSS-значением или число (если unitless)
 */
export function interpolate(from: ValueAST, to: ValueAST, t: number): string | number {
  // Оба цвета
  if (from.kind === 'color' && to.kind === 'color') {
    return interpolateColor(from, to, t);
  }

  // Оба юнитных (unit/relative/var)
  if (from.kind !== 'color' && to.kind !== 'color') {
    return interpolateUnit(
      from as ParsedUnit | ParsedRelative | ParsedVar,
      to as ParsedUnit | ParsedRelative | ParsedVar,
      t,
    );
  }

  // Разные типы → дискретный свап
  const progress = Number.isFinite(t)
    ? t <= 0 ? 0 : t >= 1 ? 1 : t
    : Number.isNaN(t) ? 0
    : t > 0 ? 1 : 0;

  if (progress < 0.5) {
    return valueAstToString(from);
  }
  return valueAstToString(to);
}

/** Сериализует ValueAST обратно в строку (для дискретного свапа).
 *
 * FINITENESS GUARD: все числовые поля (.value, .amount, .r/.g/.b) прогоняются через
 * clampFinite перед вставкой в строку/возвратом числа, гарантируя отсутствие
 * 'Infinity'/'NaN' в выводе при любых hand-constructed non-finite AST-компонентах.
 */
function valueAstToString(v: ValueAST): string | number {
  if (v.kind === 'unit') {
    const safe = clampFinite(v.value);
    return v.unit ? `${safe}${v.unit}` : safe;
  }
  if (v.kind === 'relative') return `${v.op}=${clampFinite(v.amount)}${v.unit}`;
  if (v.kind === 'var') {
    return v.fallback !== undefined ? `var(${v.name}, ${v.fallback})` : `var(${v.name})`;
  }
  // color — сериализуем как rgb; каналы зажимаем в [0,255] через clampFinite
  const clampCh = (x: number) => Math.max(0, Math.min(255, clampFinite(x)));
  return `rgb(${Math.round(clampCh(v.r))}, ${Math.round(clampCh(v.g))}, ${Math.round(clampCh(v.b))})`;
}
