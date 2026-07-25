/**
 * value-color-gamma-budget.test.ts — цена γ=2-аппроксимации ИЗМЕРЕНА, а не
 * заявлена.
 *
 * Смешение цветов идёт по приближённо-линейному свету: ch(t) = √(a²(1−t) + b²t).
 * Это сознательный размен — sqrt вместо кусочной sRGB EOTF (γ≈2.4 + линейный
 * хвост) стоит одну FPU-операцию на канал на кадр. Но ЧИСЛО в обосновании
 * («отличие на midpoint ≤ 3/255») до 2026-07-25 не проверялось ничем и было
 * занижено в 2.4 раза: развёртка по всем 256×256 парам даёт 7.33.
 *
 * Тест держит ДВА утверждения сразу:
 *   1. фактическая граница не хуже записанной в шапке color.ts — если кто-то
 *      поменяет формулу смешения, число в документации перестанет быть враньём
 *      молча;
 *   2. граница и НЕ ЛУЧШЕ существенно — иначе обоснование размена устарело бы
 *      в другую сторону (перешли на точную EOTF, а комментарий остался).
 *
 * Оракул независимый: кусочная sRGB EOTF/OETF по спецификации, написанная
 * здесь, а не импортированная из продукта.
 */

import { describe, expect, it } from 'vitest';

/** Точная sRGB EOTF: кодированный канал 0..255 → линейный свет 0..1. */
function eotf(code: number): number {
  const s = code / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Обратная: линейный свет → кодированный канал 0..255. */
function oetf(light: number): number {
  const s = light <= 0.0031308 ? light * 12.92 : 1.055 * light ** (1 / 2.4) - 0.055;
  return s * 255;
}

/** Записанная в шапке color.ts граница (кодовых единиц на midpoint). */
const DECLARED_MIDPOINT_BUDGET = 7.33;

describe('γ=2-аппроксимация: заявленная цена соответствует факту', () => {
  it('худшее отличие на midpoint по всем 256×256 парам укладывается в заявленное', () => {
    let worst = 0;
    let at: [number, number] = [0, 0];
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const approx = Math.sqrt((a * a + b * b) / 2);
        const exact = oetf((eotf(a) + eotf(b)) / 2);
        const delta = Math.abs(approx - exact);
        if (delta > worst) {
          worst = delta;
          at = [a, b];
        }
      }
    }
    expect(
      worst,
      `цена размена выросла: ${worst.toFixed(4)} при каналах (${at[0]}, ${at[1]})`,
    ).toBeLessThanOrEqual(DECLARED_MIDPOINT_BUDGET);
    // И не «внезапно стала точной»: обоснование в шапке обязано оставаться
    // правдой в обе стороны.
    expect(worst).toBeGreaterThan(DECLARED_MIDPOINT_BUDGET - 0.5);
    expect(at).toEqual([9, 255]);
  });

  it('каноничный red→blue: числа из шапки воспроизводятся', () => {
    const approx = Math.sqrt((255 * 255 + 0 * 0) / 2);
    const exact = oetf((eotf(255) + eotf(0)) / 2);
    expect(approx).toBeCloseTo(180.31, 2);
    expect(exact).toBeCloseTo(187.52, 2);
  });
});
