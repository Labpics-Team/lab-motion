import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { interpolateColor, parseColor } from '../src/value/color.js';
import type { ParsedColor } from '../src/value/color.js';

// Независимый оракул для непрозрачных in-gamut sRGB-каналов [0,255].
// CSS Color 4, §10.2 и §18 (lin_sRGB / gam_sRGB):
// https://www.w3.org/TR/css-color-4/#color-conversion-code
// Это стандартная передаточная функция, не production γ=2 и не Lab Colors.
function decode(channel: number): number {
  const encoded = channel / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function encode(linear: number): number {
  return 255 * (linear <= 0.0031308
    ? 12.92 * linear
    : 1.055 * linear ** (1 / 2.4) - 0.055);
}

function reference(from: number, to: number, progress: number): number {
  return encode(decode(from) * (1 - progress) + decode(to) * progress);
}

function gray(channel: number): ParsedColor {
  return { kind: 'color', format: 'rgb', r: channel, g: channel, b: channel, a: 1 };
}

function requiredColor(value: string): ParsedColor {
  const parsed = parseColor(value);
  assert.ok(parsed, `Цвет не разобран: ${value}`);
  return parsed;
}

describe('γ=2 color contract: отличие от точного sRGB-linear', () => {
  it('оракул закреплён внешними опорными значениями и обеими ветвями EOTF', () => {
    assert.equal(decode(0), 0);
    assert.equal(decode(255), 1);
    assert.equal(encode(0), 0);
    assert.ok(Math.abs(encode(1) - 255) < 1e-12);
    assert.ok(Math.abs(decode(10) - 0.003035269835488375) < 1e-15);
    assert.ok(Math.abs(decode(11) - 0.003346535763899161) < 1e-15);
    assert.ok(Math.abs(encode(0.003) - 9.8838) < 1e-12);
    assert.ok(Math.abs(encode(0.5) - 187.51603067837462) < 1e-10);
  });

  it('midpoint сохраняет γ=2 output, но не обещает ошибку ≤3/255', () => {
    const actual = requiredColor(interpolateColor(gray(255), gray(0), 0.5));
    const exact = reference(255, 0, 0.5);
    assert.equal(actual.r, 180);
    assert.equal(actual.g, 180);
    assert.equal(actual.b, 180);
    assert.ok(Math.abs(exact - 187.51603067837462) < 1e-10);
    // Сравниваются кодированные каналы, НЕ perceptual delta-E.
    assert.ok(Math.abs(actual.r - exact) > 7);
    assert.ok(Math.abs(255 / Math.SQRT2 - exact) > 7);
  });

  it('полный byte-midpoint corpus характеризует ошибку сериализованного API', () => {
    const colors = Array.from({ length: 256 }, (_, i) => gray(i));
    let maxError = 0;
    let witness: [number, number] = [0, 0];
    for (let from = 0; from < 256; from++) {
      for (let to = 0; to < 256; to++) {
        const actual = requiredColor(interpolateColor(colors[from]!, colors[to]!, 0.5));
        const expected = Math.round(Math.hypot(from, to) / Math.SQRT2);
        assert.equal(actual.r, expected);
        assert.equal(actual.g, expected);
        assert.equal(actual.b, expected);
        const error = Math.abs(actual.r - reference(from, to, 0.5));
        if (error > maxError) {
          maxError = error;
          witness = [from, to];
        }
      }
    }
    // Максимум ТОЛЬКО для 256² byte-пар при t=.5, с округлением API.
    // Это не верхняя граница для произвольных каналов или всего progress.
    assert.ok(Math.abs(maxError - 7.796783637120853) < 1e-9);
    assert.deepEqual(witness, [11, 255]);
  });

  it('γ=2, encoded sRGB и HSL остаются разными объявленными режимами', () => {
    const red = requiredColor('#ff0000');
    const blue = requiredColor('#0000ff');
    assert.equal(interpolateColor(red, blue, 0.5), 'rgb(180, 0, 180)');
    assert.equal(interpolateColor(red, blue, 0.5, { space: 'linear' }), 'rgb(180, 0, 180)');
    assert.equal(interpolateColor(red, blue, 0.5, { space: 'srgb' }), 'rgb(128, 0, 128)');
    assert.equal(interpolateColor(red, blue, 0), 'rgb(255, 0, 0)');
    assert.equal(interpolateColor(red, blue, 1), 'rgb(0, 0, 255)');
    const hslRed = requiredColor('hsl(0, 100%, 50%)');
    const hslBlue = requiredColor('hsl(240, 100%, 50%)');
    assert.equal(interpolateColor(hslRed, hslBlue, 0.5), 'hsl(300, 100%, 50%)');
    assert.equal(interpolateColor(hslRed, hslBlue, 0.5, { space: 'srgb' }), 'hsl(300, 100%, 50%)');
  });

  it('straight alpha и unsupported syntax не получают новых CSS-гарантий', () => {
    const transparentRed = requiredColor('rgba(255, 0, 0, 0)');
    const blue = requiredColor('#0000ff');
    assert.equal(interpolateColor(transparentRed, blue, 0.5), 'rgba(180, 0, 180, 0.5)');
    assert.equal(parseColor('oklch(60% 0.2 30)'), null);
  });
});
