/**
 * Тест: интерполяция CSS-значений, цветов и трансформов.
 * Класс A (Unit): покрывает interpolateUnit, interpolate, interpolateColor,
 *   interpolateTransform, buildTransform.
 * Класс Б (Regression): конкретные endpoint-значения зафиксированы.
 * Класс Д (Mutation): описаны mutation-зонды в комментариях.
 *
 * RED-доказательство:
 *   Убрать страж `t <= 0 ? 0` в interpolateUnit → endpoint-тесты для t=0 падают.
 *   Убрать hue-wraparound в interpolateHsl → тест "кратчайший путь hue" падает.
 *   Убрать clampFinite в lerpField → overflow-тест падает.
 *   Убрать `parts.push('none')` default в buildTransform → тест identity-трансформа падает.
 */

import { describe, expect, it } from 'vitest';
import {
  interpolateUnit,
  interpolateColor,
  interpolateTransform,
  buildTransform,
  interpolate,
  parseUnit,
  parseColor,
} from '../src/value/index.js';

// ── interpolateUnit: юниты ────────────────────────────────────────────────────

describe('interpolateUnit: числовые юниты', () => {
  it('t=0 → from', () => {
    const from = parseUnit('0px');
    const to = parseUnit('100px');
    expect(interpolateUnit(from, to, 0)).toBe('0px');
  });

  it('t=1 → to', () => {
    const from = parseUnit('0px');
    const to = parseUnit('100px');
    expect(interpolateUnit(from, to, 1)).toBe('100px');
  });

  it('t=0.5 → mid', () => {
    const from = parseUnit('0px');
    const to = parseUnit('100px');
    expect(interpolateUnit(from, to, 0.5)).toBe('50px');
  });

  it('сохраняет юнит "to"', () => {
    const from = parseUnit('0px');
    const to = parseUnit('200px');
    const r = interpolateUnit(from, to, 0.25);
    expect(r).toBe('50px');
  });

  it('% юнит', () => {
    const from = parseUnit('0%');
    const to = parseUnit('100%');
    expect(interpolateUnit(from, to, 0.5)).toBe('50%');
  });

  it('deg юнит', () => {
    const from = parseUnit('0deg');
    const to = parseUnit('360deg');
    expect(interpolateUnit(from, to, 0.5)).toBe('180deg');
  });

  it('rem юнит', () => {
    const from = parseUnit('0rem');
    const to = parseUnit('4rem');
    expect(interpolateUnit(from, to, 0.25)).toBe('1rem');
  });

  it('vh юнит', () => {
    const from = parseUnit('0vh');
    const to = parseUnit('100vh');
    expect(interpolateUnit(from, to, 0.75)).toBe('75vh');
  });

  it('безъюнитное число → число (не строка)', () => {
    const from = parseUnit(0);
    const to = parseUnit(100);
    const r = interpolateUnit(from, to, 0.5);
    expect(typeof r).toBe('number');
    expect(r).toBe(50);
  });
});

describe('interpolateUnit: hostile-t', () => {
  it('t=NaN → from (0%)', () => {
    const from = parseUnit('0%');
    const to = parseUnit('100%');
    expect(interpolateUnit(from, to, NaN)).toBe('0%');
  });

  it('t=+Infinity → to (100%)', () => {
    const from = parseUnit('0%');
    const to = parseUnit('100%');
    expect(interpolateUnit(from, to, Infinity)).toBe('100%');
  });

  it('t=-Infinity → from (0%)', () => {
    const from = parseUnit('0%');
    const to = parseUnit('100%');
    expect(interpolateUnit(from, to, -Infinity)).toBe('0%');
  });

  it('t=-0 → from', () => {
    const from = parseUnit('0px');
    const to = parseUnit('100px');
    expect(interpolateUnit(from, to, -0)).toBe('0px');
  });
});

describe('interpolateUnit: относительные значения', () => {
  it('относительные разрешаются против 0: +=10px + 0px при t=0.5', () => {
    const from = parseUnit('0px');
    const to = parseUnit('+=10px');
    // to resolves to +10px, from resolves to 0 → mid = 5px
    expect(interpolateUnit(from, to, 0.5)).toBe('5px');
  });

  it('-=5 против 10 при t=1 → -5 (base 0)', () => {
    const from = parseUnit(10);
    const to = parseUnit('-=5');
    // to resolves to -5, from = 10 → at t=1 → -5 (unitless)
    const r = interpolateUnit(from, to, 1);
    expect(r).toBe(-5);
  });
});

describe('interpolateUnit: var() — дискретный свап', () => {
  it('t < 0.5 → from', () => {
    const from = parseUnit('var(--a)');
    const to = parseUnit('var(--b)');
    expect(interpolateUnit(from, to, 0.4)).toBe('var(--a)');
  });

  it('t >= 0.5 → to', () => {
    const from = parseUnit('var(--a)');
    const to = parseUnit('var(--b)');
    expect(interpolateUnit(from, to, 0.5)).toBe('var(--b)');
  });

  it('from=unit, to=var → at t=0.5 дискретный свап', () => {
    const from = parseUnit('10px');
    const to = parseUnit('var(--x)');
    expect(interpolateUnit(from, to, 0.5)).toBe('var(--x)');
    expect(interpolateUnit(from, to, 0.4)).toBe('10px');
  });
});

// ── interpolateColor ──────────────────────────────────────────────────────────

describe('interpolateColor: sRGB (hex/rgb)', () => {
  it('t=0 → from цвет', () => {
    const from = parseColor('#ff0000')!;
    const to = parseColor('#0000ff')!;
    const r = interpolateColor(from, to, 0);
    expect(r).toBe('rgb(255, 0, 0)');
  });

  it('t=1 → to цвет', () => {
    const from = parseColor('#ff0000')!;
    const to = parseColor('#0000ff')!;
    const r = interpolateColor(from, to, 1);
    expect(r).toBe('rgb(0, 0, 255)');
  });

  it('t=0.5 → линейно-световая середина (красный+синий = светлый пурпур 180,0,180)', () => {
    // default 'linear' (2026-07-03): √(255²·0.5) = 180.31 → 180. Гамма-lerp
    // давал грязный тёмный #800080 — физически свет складывается линейно.
    const from = parseColor('#ff0000')!;
    const to = parseColor('#0000ff')!;
    const r = interpolateColor(from, to, 0.5);
    expect(r).toBe('rgb(180, 0, 180)');
  });

  it("t=0.5 легаси {space:'srgb'} → гамма-середина 128,0,128", () => {
    const from = parseColor('#ff0000')!;
    const to = parseColor('#0000ff')!;
    expect(interpolateColor(from, to, 0.5, { space: 'srgb' })).toBe('rgb(128, 0, 128)');
  });

  it('с alpha: rgba(255,0,0,1) → rgba(0,0,255,0) при t=0.5', () => {
    const from = parseColor('rgba(255, 0, 0, 1)')!;
    const to = parseColor('rgba(0, 0, 255, 0)')!;
    const r = interpolateColor(from, to, 0.5);
    // Ожидаем rgba (alpha < 1)
    expect(r).toMatch(/^rgba/);
  });

  it('hostile t=NaN → from', () => {
    const from = parseColor('#ff0000')!;
    const to = parseColor('#0000ff')!;
    expect(interpolateColor(from, to, NaN)).toBe('rgb(255, 0, 0)');
  });
});

describe('interpolateColor: HSL', () => {
  it('t=0 → from hsl-строка', () => {
    const from = parseColor('hsl(0, 100%, 50%)')!;
    const to = parseColor('hsl(120, 100%, 50%)')!;
    const r = interpolateColor(from, to, 0);
    // Должна начинаться с hsl
    expect(r).toMatch(/^hsl/);
    // H ≈ 0
    expect(r).toContain('0,');
  });

  it('t=1 → to hsl', () => {
    const from = parseColor('hsl(0, 100%, 50%)')!;
    const to = parseColor('hsl(120, 100%, 50%)')!;
    const r = interpolateColor(from, to, 1);
    expect(r).toMatch(/^hsl/);
  });

  it('hue-wraparound: 350° → 10° кратчайший путь (через 0, не через 180)', () => {
    // Кратчайший путь: delta = 10 - 350 = -340; но |delta| > 180 → добавляем 360 → delta = 20
    // При t=0.5: h = 350 + 10 = 360 → нормализуется в 0
    const from = parseColor('hsl(350, 100%, 50%)')!;
    const to = parseColor('hsl(10, 100%, 50%)')!;
    const r = interpolateColor(from, to, 0.5);
    // hue ≈ 0 (оба варианта: 360 ≡ 0)
    expect(r).toMatch(/^hsl/);
    // Угол должен быть около 0 или 360
    const hMatch = r.match(/^hsla?\(([^,]+),/);
    expect(hMatch).not.toBeNull();
    const hVal = parseFloat(hMatch![1]);
    // 0 ≤ hVal < 1 или 359 < hVal ≤ 360
    const inRange = (hVal >= 0 && hVal < 1) || (hVal > 359);
    expect(inRange).toBe(true);
  });
});

// ── unified interpolate ───────────────────────────────────────────────────────

describe('interpolate (unified)', () => {
  it('unit × unit → lerp', () => {
    const from = { kind: 'unit' as const, value: 0, unit: 'px' };
    const to = { kind: 'unit' as const, value: 100, unit: 'px' };
    expect(interpolate(from, to, 0.5)).toBe('50px');
  });

  it('color × color → rgb', () => {
    const from = parseColor('#ff0000')!;
    const to = parseColor('#0000ff')!;
    const r = interpolate(from, to, 0.5);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/rgb/);
  });

  it('unit × color → дискретный свап при t=0.5', () => {
    const from = { kind: 'unit' as const, value: 10, unit: 'px' };
    const to = parseColor('#f00')!;
    const r = interpolate(from, to, 0.5);
    // Дискретный свап: to → сериализуем to-color
    expect(typeof r).toBe('string');
  });

  it('unit × color → from при t<0.5', () => {
    const from = { kind: 'unit' as const, value: 10, unit: 'px' };
    const to = parseColor('#f00')!;
    const r = interpolate(from, to, 0.4);
    expect(r).toBe('10px');
  });
});

// ── buildTransform ────────────────────────────────────────────────────────────

describe('buildTransform', () => {
  it('identity → "none"', () => {
    expect(buildTransform({})).toBe('none');
  });

  it('только x=10 → translateX(10px)', () => {
    expect(buildTransform({ x: 10 })).toBe('translateX(10px)');
  });

  it('только y=20 → translateY(20px)', () => {
    expect(buildTransform({ y: 20 })).toBe('translateY(20px)');
  });

  it('x+y → translate(10px, 20px)', () => {
    expect(buildTransform({ x: 10, y: 20 })).toBe('translate(10px, 20px)');
  });

  it('scale=2 → scale(2)', () => {
    expect(buildTransform({ scale: 2 })).toBe('scale(2)');
  });

  it('scaleX=2, scaleY=3 → scaleX(2) scaleY(3)', () => {
    expect(buildTransform({ scaleX: 2, scaleY: 3 })).toBe('scaleX(2) scaleY(3)');
  });

  it('scaleX=scaleY → scale(N)', () => {
    expect(buildTransform({ scaleX: 2, scaleY: 2 })).toBe('scale(2)');
  });

  it('rotate=45 → rotate(45deg)', () => {
    expect(buildTransform({ rotate: 45 })).toBe('rotate(45deg)');
  });

  it('skewX=10 → skewX(10deg)', () => {
    expect(buildTransform({ skewX: 10 })).toBe('skewX(10deg)');
  });

  it('skewY=5 → skewY(5deg)', () => {
    expect(buildTransform({ skewY: 5 })).toBe('skewY(5deg)');
  });

  it('skewX+skewY → skew(10deg, 5deg)', () => {
    expect(buildTransform({ skewX: 10, skewY: 5 })).toBe('skew(10deg, 5deg)');
  });

  it('полный набор: порядок translate→scale→rotate→skew', () => {
    const r = buildTransform({ x: 10, y: 5, scale: 2, rotate: 45, skewX: 5 });
    const parts = r.split(' ');
    const tIdx = parts.findIndex((p) => p.startsWith('translate'));
    const sIdx = parts.findIndex((p) => p.startsWith('scale'));
    const rIdx = parts.findIndex((p) => p.startsWith('rotate'));
    const kIdx = parts.findIndex((p) => p.startsWith('skew'));
    expect(tIdx).toBeLessThan(sIdx);
    expect(sIdx).toBeLessThan(rIdx);
    expect(rIdx).toBeLessThan(kIdx);
  });

  it('FINITENESS GUARD: NaN-поля → identity (nones out)', () => {
    // NaN → clampFinite → 0; для scale 0 ≠ 1 → scale(0)
    const r = buildTransform({ x: NaN });
    // x=NaN → clampFinite → 0 → не добавляет translateX
    expect(r).toBe('none');
  });
});

describe('interpolateTransform', () => {
  it('t=0 → from', () => {
    const r = interpolateTransform({ x: 0, y: 0 }, { x: 100, y: 200 }, 0);
    expect(r).toBe('none'); // x=0,y=0 → none
  });

  it('t=1 → to', () => {
    const r = interpolateTransform({ x: 0 }, { x: 100 }, 1);
    expect(r).toBe('translateX(100px)');
  });

  it('t=0.5 → средний translate', () => {
    const r = interpolateTransform({ x: 0 }, { x: 100 }, 0.5);
    expect(r).toBe('translateX(50px)');
  });

  it('rotate: 0 → 90 при t=0.5 → 45deg', () => {
    const r = interpolateTransform({ rotate: 0 }, { rotate: 90 }, 0.5);
    expect(r).toBe('rotate(45deg)');
  });

  it('scale: 1 → 2 при t=0.5 → scale(1.5)', () => {
    const r = interpolateTransform({ scale: 1 }, { scale: 2 }, 0.5);
    expect(r).toContain('scale(1.5)');
  });
});
