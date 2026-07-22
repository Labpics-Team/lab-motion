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
export type { ParsedColor, ColorMixSpace, ColorMixOptions } from './color.js';
export type { TransformState } from './transform.js';
export type { ValueAST } from './parse.js';

// ── Re-exports: функции ──────────────────────────────────────────────────────
export { parseUnit, interpolateUnit } from './units.js';
export { parseColor, interpolateColor, mixColor, hslToRgb, rgbToHsl } from './color.js';
export { buildTransform, interpolateTransform } from './transform.js';
export { parse } from './parse.js';

// ── Unified parse / interpolate ──────────────────────────────────────────────

import { type ParsedUnit, type ParsedRelative, type ParsedVar, interpolateUnit, clampFinite, clampProgress, unitToString } from './units.js';
import { clamp255, interpolateColor } from './color.js';
import type { ValueAST } from './parse.js';

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
  return valueAstToString(clampProgress(t) < 0.5 ? from : to);
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
  if (v.kind === 'var') return unitToString(v); // var() без числовых полей
  // color — сериализуем как rgb; каналы зажимаются clamp255 (внутри clampFinite)
  return `rgb(${Math.round(clamp255(v.r))}, ${Math.round(clamp255(v.g))}, ${Math.round(clamp255(v.b))})`;
}
