/**
 * color.ts — Парсинг и интерполяция CSS-цветов.
 *
 * Поддерживаемые форматы: hex (#rgb, #rrggbb, #rgba, #rrggbbaa),
 * rgb()/rgba(), hsl()/hsla().
 *
 * Инварианты:
 *   VC1. FINITENESS GUARD: interpolateColor/mixColor НИКОГДА не возвращают
 *        строки с NaN/Infinity.
 *   VC2. SSR-safe.
 *   VC3. Zero runtime deps.
 *
 * Канонические формулы:
 *   RGB-смешение (default 'linear'): приближённо-линейный свет
 *     ch(t) = √(a²·(1−t) + b²·t) — γ=2-аппроксимация sRGB EOTF, класс
 *     mixLinearColor (popmotion/framer-motion). Кодированные каналы sRGB —
 *     НЕ свет: их lerp темнит середину (red→blue @0.5 = грязный #800080);
 *     физически свет складывается в линейном пространстве (дыра C аудита
 *     2026-07-03). Точная EOTF — кусочная (γ≈2.4 + линейный хвост); γ=2
 *     выбрана сознательно: sqrt — одна FPU-операция на канал на кадр, а
 *     отличие от точной кривой на midpoint ≤ 3/255 — под порогом различимости
 *     в движении. Это ДЕКЛАРИРОВАННЫЙ размен, не «точный linear-light».
 *   RGB-смешение ('srgb', легаси): линейный lerp кодированных каналов
 *     (CSS Color 4 §13.1, legacy-поведение srgb-интерполяции).
 *   Alpha: ВСЕГДА линейный lerp — альфа есть покрытие, не свет.
 *   HSL-интерполяция: линейное смешение H,S,L с wraparound для hue
 *   HSL↔RGB: W3C CSS Color 3 §4.2.4 / MDN
 */

import { clampFinite } from './units.js';

// ── Тип ParsedColor ───────────────────────────────────────────────────────────

/** Внутреннее представление: r,g,b ∈ [0,255]; a ∈ [0,1]. */
export interface ParsedColor {
  readonly kind: 'color';
  /** Red channel 0–255. */
  readonly r: number;
  /** Green channel 0–255. */
  readonly g: number;
  /** Blue channel 0–255. */
  readonly b: number;
  /** Alpha channel 0–1. */
  readonly a: number;
  /**
   * Исходный формат — определяет формат вывода при интерполяции.
   * 'hex' и 'rgb' → вывод rgb()/rgba().
   * 'hsl' → вывод hsl()/hsla() (с сохранением H,S,L для интерполяции).
   */
  readonly format: 'hex' | 'rgb' | 'hsl';
  /** Исходные HSL-значения (только для format='hsl'). */
  readonly hsl?: { readonly h: number; readonly s: number; readonly l: number };
}

// ── Парсинг ───────────────────────────────────────────────────────────────────

const HEX3_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX4_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

const NUM_PCT = '(\\d+(?:\\.\\d+)?%?)';
// Hue по W3C CSS Color (legacy comma-синтаксис) — <number> СО знаком и БЕЗ
// процента: «hsl(50%,…)» невалиден и отклоняется целиком, «hsl(-120,…)» ≡
// hsl(240,…). Angle-единицы (deg/turn) живут только в modern space-синтаксисе,
// который этот парсер сознательно не поддерживает (как и RGB_RE рядом).
const HUE = '(-?\\d+(?:\\.\\d+)?)';
const ALPHA = '(\\d+(?:\\.\\d+)?)';
const SEP = '\\s*,\\s*';

const RGB_RE = new RegExp(`^rgba?\\(\\s*(\\d+(?:\\.\\d+)?)${SEP}(\\d+(?:\\.\\d+)?)${SEP}(\\d+(?:\\.\\d+)?)(?:${SEP}${ALPHA})?\\s*\\)$`, 'i');
const HSL_RE = new RegExp(`^hsla?\\(\\s*${HUE}${SEP}${NUM_PCT}${SEP}${NUM_PCT}(?:${SEP}${ALPHA})?\\s*\\)$`, 'i');

/**
 * Парсит строку CSS-цвета в типизированный AST.
 * Возвращает `null` если формат не распознан.
 *
 * Поддержка:
 *   hex: #rgb, #rrggbb, #rgba, #rrggbbaa
 *   rgb: rgb(r, g, b), rgba(r, g, b, a) — r,g,b ∈ [0,255], a ∈ [0,1]
 *   hsl: hsl(h, s%, l%), hsla(h, s%, l%, a) — h ∈ [0,360], s/l ∈ [0,100]
 */
export function parseColor(value: string): ParsedColor | null {
  const s = value.trim();

  // Hex shorthand #rgb
  const h3 = HEX3_RE.exec(s);
  if (h3) {
    return { kind: 'color', format: 'hex',
      r: parseInt(h3[1] + h3[1], 16),
      g: parseInt(h3[2] + h3[2], 16),
      b: parseInt(h3[3] + h3[3], 16),
      a: 1 };
  }

  // Hex shorthand #rgba
  const h4 = HEX4_RE.exec(s);
  if (h4) {
    return { kind: 'color', format: 'hex',
      r: parseInt(h4[1] + h4[1], 16),
      g: parseInt(h4[2] + h4[2], 16),
      b: parseInt(h4[3] + h4[3], 16),
      a: parseInt(h4[4] + h4[4], 16) / 255 };
  }

  // Hex #rrggbb
  const h6 = HEX6_RE.exec(s);
  if (h6) {
    return { kind: 'color', format: 'hex',
      r: parseInt(h6[1], 16),
      g: parseInt(h6[2], 16),
      b: parseInt(h6[3], 16),
      a: 1 };
  }

  // Hex #rrggbbaa
  const h8 = HEX8_RE.exec(s);
  if (h8) {
    return { kind: 'color', format: 'hex',
      r: parseInt(h8[1], 16),
      g: parseInt(h8[2], 16),
      b: parseInt(h8[3], 16),
      a: parseInt(h8[4], 16) / 255 };
  }

  // rgb() / rgba()
  const rgb = RGB_RE.exec(s);
  if (rgb) {
    return { kind: 'color', format: 'rgb',
      r: clamp255(parseFloat(rgb[1])),
      g: clamp255(parseFloat(rgb[2])),
      b: clamp255(parseFloat(rgb[3])),
      a: rgb[4] !== undefined ? clamp01(parseFloat(rgb[4])) : 1 };
  }

  // hsl() / hsla()
  const hsl = HSL_RE.exec(s);
  if (hsl) {
    const h = parseHue(hsl[1]);
    const sv = parsePct(hsl[2]);
    const lv = parsePct(hsl[3]);
    const av = hsl[4] !== undefined ? clamp01(parseFloat(hsl[4])) : 1;
    const { r, g, b } = hslToRgb(h, sv, lv);
    return { kind: 'color', format: 'hsl',
      r, g, b, a: av,
      hsl: { h, s: sv, l: lv } };
  }

  return null;
}

// ── Интерполяция ─────────────────────────────────────────────────────────────

/** Пространство RGB-смешения. Только для RGB-пути; HSL×HSL — своё. */
export type ColorMixSpace = 'linear' | 'srgb';

/** Опции интерполяции цвета. */
export interface ColorMixOptions {
  /**
   * 'linear' (default) — приближённо-линейный свет: √(a²(1−t)+b²t) по
   * каналам (провенанс в шапке модуля). 'srgb' — легаси lerp кодированных
   * каналов (CSS Color 4 §13.1) для потребителей, пиннивших старый вывод.
   */
  readonly space?: ColorMixSpace | undefined;
}

/**
 * Интерполирует между двумя ParsedColor.
 *
 * - Если оба format='hsl': интерполяция в пространстве HSL (с hue-wraparound).
 * - Иначе: смешение R,G,B в приближённо-линейном свете (default) или
 *   легаси-lerp кодированных каналов ({space:'srgb'}); alpha всегда линейно.
 *
 * Возвращает css-строку: rgb(...) или hsl(...) с alpha если a < 1.
 *
 * FINITENESS GUARD (VC1): все результаты зажимаются через clampFinite /
 * clamp255 / clamp01 → вывод ВСЕГДА конечен.
 */
export function interpolateColor(
  from: ParsedColor,
  to: ParsedColor,
  t: number,
  options?: ColorMixOptions,
): string {
  const progress = Number.isFinite(t)
    ? t <= 0 ? 0 : t >= 1 ? 1 : t
    : Number.isNaN(t) ? 0
    : t > 0 ? 1 : 0;

  if (from.format === 'hsl' && to.format === 'hsl' && from.hsl && to.hsl) {
    return interpolateHsl(from, to, progress);
  }
  return interpolateRgb(from, to, progress, options?.space !== 'srgb');
}

/**
 * Удобная обёртка: смешать два CSS-цвета (строки) при прогрессе t.
 * Возвращает `from` строку если парсинг провалился (безопасный фоллбек).
 */
export function mixColor(
  fromStr: string,
  toStr: string,
  t: number,
  options?: ColorMixOptions,
): string {
  const from = parseColor(fromStr);
  const to = parseColor(toStr);
  if (!from || !to) return t < 0.5 ? fromStr : toStr;
  return interpolateColor(from, to, t, options);
}

// ── Внутренние утилиты ────────────────────────────────────────────────────────

function interpolateRgb(from: ParsedColor, to: ParsedColor, t: number, linear: boolean): string {
  // linear: √(a²(1−t)+b²t) — подкоренное ≥ 0 для конечных каналов и t∈[0,1];
  // hostile-AST (Inf/NaN каналы) даёт NaN → clampFinite → 0 (VC1 держится).
  const mix = linear
    ? (a: number, b: number) => Math.sqrt(a * a * (1 - t) + b * b * t)
    : (a: number, b: number) => a + (b - a) * t;
  const r = clamp255(clampFinite(mix(from.r, to.r)));
  const g = clamp255(clampFinite(mix(from.g, to.g)));
  const b = clamp255(clampFinite(mix(from.b, to.b)));
  // Alpha — покрытие, не свет: всегда линейный lerp.
  const a = clamp01(clampFinite(from.a + (to.a - from.a) * t));
  const ri = Math.round(r);
  const gi = Math.round(g);
  const bi = Math.round(b);
  if (a >= 1) return `rgb(${ri}, ${gi}, ${bi})`;
  return `rgba(${ri}, ${gi}, ${bi}, ${+a.toFixed(4)})`;
}

function interpolateHsl(from: ParsedColor, to: ParsedColor, t: number): string {
  // Гарантировано наличие hsl (проверено в interpolateColor)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const fh = from.hsl!;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const th = to.hsl!;

  // Hue wraparound: берём кратчайший путь по кругу
  let dh = th.h - fh.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;

  const h = clampFinite(fh.h + dh * t);
  const s = clamp01(clampFinite(fh.s + (th.s - fh.s) * t));
  const l = clamp01(clampFinite(fh.l + (th.l - fh.l) * t));
  const a = clamp01(clampFinite(from.a + (to.a - from.a) * t));

  const hNorm = normalizeHue(h);
  const sp = +(s * 100).toFixed(4);
  const lp = +(l * 100).toFixed(4);

  if (a >= 1) return `hsl(${+hNorm.toFixed(4)}, ${sp}%, ${lp}%)`;
  return `hsla(${+hNorm.toFixed(4)}, ${sp}%, ${lp}%, ${+a.toFixed(4)})`;
}

// ── HSL ↔ RGB (канонические формулы W3C CSS Color 3 §4.2.4) ─────────────────

/**
 * Преобразует HSL в RGB.
 * h ∈ [0,360], s ∈ [0,1], l ∈ [0,1]
 * Возвращает r,g,b ∈ [0,255].
 *
 * Канонический источник: W3C CSS Color 3 §4.2.4
 * https://www.w3.org/TR/css-color-3/#hsl-color
 */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const c = clamp255(l * 255);
    return { r: c, g: c, b: c };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = normalizeHue(h) / 360;
  return {
    r: clamp255(hueToRgb(p, q, hk + 1 / 3) * 255),
    g: clamp255(hueToRgb(p, q, hk) * 255),
    b: clamp255(hueToRgb(p, q, hk - 1 / 3) * 255),
  };
}

/** Вспомогательная функция H → канал по алгоритму W3C. */
function hueToRgb(p: number, q: number, t: number): number {
  let tc = t;
  if (tc < 0) tc += 1;
  if (tc > 1) tc -= 1;
  if (tc < 1 / 6) return p + (q - p) * 6 * tc;
  if (tc < 1 / 2) return q;
  if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
  return p;
}

/**
 * Преобразует RGB в HSL.
 * r,g,b ∈ [0,255]
 * Возвращает h ∈ [0,360), s ∈ [0,1], l ∈ [0,1].
 *
 * Канонический источник: W3C CSS Color 3 §4.2.4
 */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  } else if (max === gn) {
    h = ((bn - rn) / d + 2) / 6;
  } else {
    h = ((rn - gn) / d + 4) / 6;
  }

  return { h: h * 360, s, l };
}

// ── Вспомогательные зажимы ────────────────────────────────────────────────────

function clamp255(x: number): number {
  const f = clampFinite(x);
  return f < 0 ? 0 : f > 255 ? 255 : f;
}

function clamp01(x: number): number {
  const f = clampFinite(x);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Канон hue: [0, 360). Один хелпер на все места (parse/interpolate/hslToRgb). */
function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

function parseHue(s: string): number {
  // Знак и >360 валидны по W3C — нормализуем в канон [0, 360), чтобы AST
  // хранил один hue на цвет и интерполяция не делала лишний оборот.
  return normalizeHue(clampFinite(parseFloat(s)));
}

function parsePct(s: string): number {
  // S/L приходят как "50%" → 0.5; или как "50" → 0.5
  const v = parseFloat(s);
  return clamp01(clampFinite(s.includes('%') ? v / 100 : v));
}
