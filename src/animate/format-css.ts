/**
 * animate/format-css.ts — композируемый C¹-шов css-значений (срез R3b).
 *
 * Базовый граф ./animate не несёт цветового движка: css-группы интерполирует
 * браузер, а прерывание рестартует C⁰ (from = цель прерванного прогона —
 * политика R3a). Этот модуль поверх ./value включает непрерывность значения:
 * передайте его опцией `formatCssAt` — планировщик начнёт резать середину
 * полёта точным интерполированным значением (цвета, юниты, var()-fallback).
 *
 *   import { animate } from '@labpics/motion/animate';
 *   import { formatCssAt } from '<internal: animate/format-css>'; // R3c: субпуть
 *   animate(el, { backgroundColor: '#0f0' }, { formatCssAt });
 *
 * Не публичный entry в R3b: exports подключит срез R3c вместе с диетой.
 */

import { interpolate } from '../value/index.js';
import { tryParseValue } from '../value/parse.js';
import type { FormatCssAt } from './compositor-plan.js';

/**
 * Значение между from и to при прогрессе p. Нераспознанная грамматика →
 * undefined: планировщик деградирует к своей C⁰-политике, а не к броску —
 * прерывание анимации не место для исключений.
 */
export const formatCssAt: FormatCssAt = (from, to, p) => {
  const fromAst = tryParseValue(from);
  const toAst = tryParseValue(to);
  if (fromAst === undefined || toAst === undefined) return undefined;
  // interpolate финитно-безопасен и переживает смешанные виды AST
  // (дискретный свап) — hostile p не даёт NaN в строку.
  return interpolate(fromAst, toAst, p);
};
