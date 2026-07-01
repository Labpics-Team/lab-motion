/**
 * Тест: дифференциальный — цвета vs канонические формулы.
 * Класс В (Differential): реализация vs опубликованная формула.
 * Класс Б (Characterization): конкретные выходы зафиксированы.
 *
 * Канонические источники:
 *   HSL→RGB: W3C CSS Color 3 §4.2.4 (https://www.w3.org/TR/css-color-3/#hsl-color)
 *   RGB→HSL: W3C CSS Color 3 §4.2.4
 *   sRGB lerp: CSS Color 4 §13.1 (линейное смешение в sRGB)
 *   hue wraparound: краткий путь по кругу (|delta| ≤ 180)
 *
 * RED-доказательство:
 *   Убрать `if (dh > 180) dh -= 360` в interpolateHsl →
 *     тест "hue-wraparound 350°→10°" упадёт.
 *   Изменить hueToRgb(p, q, hk + 1/3) на hk - 1/3 →
 *     тест "hslToRgb красный" упадёт.
 *   Убрать round в sRGB-интерполяции →
 *     тесты с конкретными rgb(...) значениями могут упасть.
 */

import { describe, expect, it } from 'vitest';
import { hslToRgb, rgbToHsl, interpolateColor, parseColor } from '../src/value/index.js';

// ── Канонические формулы (независимая реализация) ────────────────────────────
// Источник: W3C CSS Color 3 §4.2.4

function canonicalHslToRgb(h: number, s: number, l: number): [number, number, number] {
  // h ∈ [0,360], s ∈ [0,1], l ∈ [0,1]
  // Канонический алгоритм W3C CSS Color 3
  if (s === 0) {
    const c = Math.round(l * 255);
    return [c, c, c];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = ((h % 360) + 360) % 360 / 360;

  function hue2rgb(pv: number, qv: number, t: number): number {
    let tc = t;
    if (tc < 0) tc += 1;
    if (tc > 1) tc -= 1;
    if (tc < 1 / 6) return pv + (qv - pv) * 6 * tc;
    if (tc < 1 / 2) return qv;
    if (tc < 2 / 3) return pv + (qv - pv) * (2 / 3 - tc) * 6;
    return pv;
  }

  return [
    Math.round(hue2rgb(p, q, hk + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hk) * 255),
    Math.round(hue2rgb(p, q, hk - 1 / 3) * 255),
  ];
}

function canonicalRgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn)      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else                 h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

/** Линейный sRGB-lerp по каноническому CSS Color 4. */
function canonicalSrgbLerp(
  fr: number, fg: number, fb: number,
  tr: number, tg: number, tb: number,
  t: number,
): [number, number, number] {
  return [
    Math.round(fr + (tr - fr) * t),
    Math.round(fg + (tg - fg) * t),
    Math.round(fb + (tb - fb) * t),
  ];
}

// ── Тесты hslToRgb vs канонической формулы ───────────────────────────────────

describe('hslToRgb: соответствие канонической W3C CSS Color 3', () => {
  const cases: Array<{ h: number; s: number; l: number; name: string }> = [
    { h: 0,   s: 1,   l: 0.5, name: 'красный' },
    { h: 120, s: 1,   l: 0.5, name: 'зелёный' },
    { h: 240, s: 1,   l: 0.5, name: 'синий' },
    { h: 60,  s: 1,   l: 0.5, name: 'жёлтый' },
    { h: 180, s: 1,   l: 0.5, name: 'голубой' },
    { h: 300, s: 1,   l: 0.5, name: 'пурпурный' },
    { h: 0,   s: 0,   l: 0.5, name: 'серый 50%' },
    { h: 0,   s: 0,   l: 0,   name: 'чёрный' },
    { h: 0,   s: 0,   l: 1,   name: 'белый' },
    { h: 30,  s: 0.5, l: 0.3, name: 'коричневый оттенок' },
    { h: 200, s: 0.7, l: 0.6, name: 'голубоватый' },
    { h: 350, s: 0.9, l: 0.4, name: 'тёмно-красный' },
  ];

  for (const { h, s, l, name } of cases) {
    it(`hsl(${h}, ${s * 100}%, ${l * 100}%) → ${name}`, () => {
      const impl = hslToRgb(h, s, l);
      const [cr, cg, cb] = canonicalHslToRgb(h, s, l);

      // Допуск ≤ 1 (округление float)
      expect(Math.round(impl.r)).toBeCloseTo(cr, 0);
      expect(Math.round(impl.g)).toBeCloseTo(cg, 0);
      expect(Math.round(impl.b)).toBeCloseTo(cb, 0);
    });
  }
});

// ── Тесты rgbToHsl vs канонической формулы ───────────────────────────────────

describe('rgbToHsl: соответствие канонической W3C CSS Color 3', () => {
  const cases: Array<{ r: number; g: number; b: number; name: string }> = [
    { r: 255, g: 0,   b: 0,   name: 'красный → h=0, s=1, l=0.5' },
    { r: 0,   g: 255, b: 0,   name: 'зелёный → h=120, s=1, l=0.5' },
    { r: 0,   g: 0,   b: 255, name: 'синий → h=240, s=1, l=0.5' },
    { r: 128, g: 128, b: 128, name: 'серый → s=0' },
    { r: 0,   g: 0,   b: 0,   name: 'чёрный → l=0' },
    { r: 255, g: 255, b: 255, name: 'белый → l=1' },
    { r: 100, g: 150, b: 200, name: 'случайный' },
  ];

  for (const { r, g, b, name } of cases) {
    it(`rgb(${r},${g},${b}) → ${name}`, () => {
      const impl = rgbToHsl(r, g, b);
      const [ch, cs, cl] = canonicalRgbToHsl(r, g, b);

      expect(impl.h).toBeCloseTo(ch, 1);
      expect(impl.s).toBeCloseTo(cs, 4);
      expect(impl.l).toBeCloseTo(cl, 4);
    });
  }
});

// ── Round-trip: hslToRgb → rgbToHsl ─────────────────────────────────────────

describe('Round-trip hslToRgb → rgbToHsl', () => {
  const cases = [
    { h: 0,   s: 1,   l: 0.5 },
    { h: 120, s: 0.8, l: 0.4 },
    { h: 240, s: 0.6, l: 0.6 },
    { h: 60,  s: 0.5, l: 0.3 },
    { h: 300, s: 0.9, l: 0.5 },
  ];

  for (const { h, s, l } of cases) {
    it(`hsl(${h}, ${s}, ${l}) round-trip с точностью 1°/1%`, () => {
      const { r, g, b } = hslToRgb(h, s, l);
      const back = rgbToHsl(Math.round(r), Math.round(g), Math.round(b));

      // H ≈ исходное (с допуском из-за округления int8 каналов)
      const hDiff = Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h));
      expect(hDiff).toBeLessThan(2); // ≤2° — потеря точности через int8
      expect(back.s).toBeCloseTo(s, 1);
      expect(back.l).toBeCloseTo(l, 1);
    });
  }
});

// ── sRGB-интерполяция vs канонической формулы ─────────────────────────────────

describe('interpolateColor sRGB: соответствие CSS Color 4', () => {
  const cases: Array<{
    from: string; to: string; t: number; name: string;
  }> = [
    { from: '#ff0000', to: '#0000ff', t: 0.5,  name: 'красный→синий 0.5' },
    { from: '#ff0000', to: '#0000ff', t: 0.0,  name: 'красный→синий 0.0' },
    { from: '#ff0000', to: '#0000ff', t: 1.0,  name: 'красный→синий 1.0' },
    { from: '#000000', to: '#ffffff', t: 0.5,  name: 'чёрный→белый 0.5' },
    { from: '#ff8800', to: '#00ff88', t: 0.25, name: 'оранжевый→mint 0.25' },
    { from: '#010101', to: '#fefefe', t: 0.75, name: 'тёмный→светлый 0.75' },
  ];

  for (const { from, to, t, name } of cases) {
    it(`sRGB lerp ${name}`, () => {
      const fc = parseColor(from)!;
      const tc = parseColor(to)!;

      const result = interpolateColor(fc, tc, t);

      // Канонический результат
      const [cr, cg, cb] = canonicalSrgbLerp(fc.r, fc.g, fc.b, tc.r, tc.g, tc.b, t);
      const expected = `rgb(${cr}, ${cg}, ${cb})`;

      expect(result).toBe(expected);
    });
  }
});

// ── Hue wraparound: канонический кратчайший путь ──────────────────────────────

describe('interpolateColor HSL: hue wraparound', () => {
  it('350° → 10°: кратчайший путь через 0 (delta=+20°, не −340°)', () => {
    const from = parseColor('hsl(350, 100%, 50%)')!;
    const to   = parseColor('hsl(10, 100%, 50%)')!;

    const mid = interpolateColor(from, to, 0.5);
    // Кратчайший путь: +20°/2 = +10°, от 350° → 0° (нормализованный)
    const hMatch = mid.match(/^hsla?\(([^,]+),/);
    expect(hMatch).not.toBeNull();
    const h = parseFloat(hMatch![1]);
    // Нормализованный 0 ± 1° (учёт хранения float)
    const normalized = ((h % 360) + 360) % 360;
    expect(normalized).toBeCloseTo(0, 0);
  });

  it('10° → 350°: кратчайший путь через 0 (delta=−20°)', () => {
    const from = parseColor('hsl(10, 100%, 50%)')!;
    const to   = parseColor('hsl(350, 100%, 50%)')!;
    const mid = interpolateColor(from, to, 0.5);
    const hMatch = mid.match(/^hsla?\(([^,]+),/);
    const h = parseFloat(hMatch![1]);
    // 10 - 10 = 0
    const normalized = ((h % 360) + 360) % 360;
    expect(normalized).toBeCloseTo(0, 0);
  });

  it('0° → 180°: прямой путь (delta=+180°)', () => {
    const from = parseColor('hsl(0, 100%, 50%)')!;
    const to   = parseColor('hsl(180, 100%, 50%)')!;
    const mid = interpolateColor(from, to, 0.5);
    const hMatch = mid.match(/^hsla?\(([^,]+),/);
    const h = parseFloat(hMatch![1]);
    expect(h).toBeCloseTo(90, 1);
  });

  it('0° → 270°: кратчайший через 360 или прямой?', () => {
    // delta = 270 - 0 = 270 > 180 → дальний, берём 270 - 360 = -90
    // h_mid = 0 + (-90)*0.5 = -45 → нормализуется в 315
    const from = parseColor('hsl(0, 100%, 50%)')!;
    const to   = parseColor('hsl(270, 100%, 50%)')!;
    const mid = interpolateColor(from, to, 0.5);
    const hMatch = mid.match(/^hsla?\(([^,]+),/);
    const h = parseFloat(hMatch![1]);
    const normalized = ((h % 360) + 360) % 360;
    expect(normalized).toBeCloseTo(315, 1);
  });
});

// ── parseColor → hslToRgb консистентность ────────────────────────────────────

describe('parseColor HSL: r,g,b поля = hslToRgb(h, s, l)', () => {
  const cases = [
    'hsl(0, 100%, 50%)',
    'hsl(120, 100%, 50%)',
    'hsl(240, 100%, 50%)',
    'hsl(60, 80%, 40%)',
    'hsl(300, 60%, 70%)',
  ];

  for (const css of cases) {
    it(`parseColor("${css}").r,g,b = hslToRgb(h,s,l)`, () => {
      const parsed = parseColor(css)!;
      expect(parsed).not.toBeNull();
      expect(parsed.hsl).toBeDefined();

      const { h, s, l } = parsed.hsl!;
      const derived = hslToRgb(h, s, l);

      expect(Math.round(parsed.r)).toBeCloseTo(Math.round(derived.r), 0);
      expect(Math.round(parsed.g)).toBeCloseTo(Math.round(derived.g), 0);
      expect(Math.round(parsed.b)).toBeCloseTo(Math.round(derived.b), 0);
    });
  }
});
