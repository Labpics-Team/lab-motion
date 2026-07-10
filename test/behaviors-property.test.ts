/**
 * test/behaviors-property.test.ts — property-тесты выбора snap/страницы на
 * диапазоне value+velocity (seeded-LCG). Класс В.
 *
 * Оракул выбора snap — САМ ./decay (проекция момента): свойство поведения —
 * «выбирается ближайший snap к decay-landing». Мутант #1 (landing=value)
 * рушит это на всех seed'ах с ненулевой скоростью. Мутанты #10 (RTL) и знак
 * направления карусели — во втором блоке.
 */

import { describe, expect, it } from 'vitest';
import { createBottomSheet, createCarousel } from '../src/behaviors/index.js';
import { createDecay } from '../src/decay.js';
import { lcg, pt } from './behaviors-helpers.js';

const SNAPS = [0, 300, 600, 900];

/** Ближайший snap к точке — независимый оракул. */
function nearestSnap(target: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < SNAPS.length; i++) {
    const d = Math.abs(SNAPS[i]! - target);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

describe('./behaviors property — bottom sheet: выбор snap = ближайший к decay-проекции', () => {
  it('на 400 seed-парах (value, velocity) выбор совпадает с оракулом ./decay', () => {
    const rnd = lcg(20260710);
    for (let iter = 0; iter < 400; iter++) {
      const p = 10 + rnd() * 580; // value ∈ [10, 590]
      const T = 0.03 + rnd() * 0.06; // время → velocity = p/T ∈ широкий диапазон
      const sheet = createBottomSheet({ snapPoints: SNAPS });
      sheet.pointerDown(pt(0, 0, 0));
      sheet.pointerMove(pt(0, p, T / 2));
      sheet.pointerMove(pt(0, p, T));
      sheet.pointerUp(pt(0, p, T)); // velocity vy = p/T
      const chosen = sheet.state.snapIndex;

      const v = p / T;
      const landing = createDecay({ from: p, velocity: v }).rest;
      expect(chosen).toBe(nearestSnap(landing));
    }
  });

  it('монотонность: при фиксированном value рост скорости не уменьшает snapIndex', () => {
    const rnd = lcg(777);
    for (let iter = 0; iter < 60; iter++) {
      const p = 20 + rnd() * 560;
      let prev = -1;
      // T убывает → velocity растёт.
      for (const T of [0.09, 0.07, 0.05, 0.04, 0.03]) {
        const sheet = createBottomSheet({ snapPoints: SNAPS });
        sheet.pointerDown(pt(0, 0, 0));
        sheet.pointerMove(pt(0, p, T / 2));
        sheet.pointerMove(pt(0, p, T));
        sheet.pointerUp(pt(0, p, T));
        const idx = sheet.state.snapIndex;
        expect(idx).toBeGreaterThanOrEqual(prev);
        prev = idx;
      }
    }
  });
});

describe('./behaviors property — carousel: направление+velocity, RTL-зеркало', () => {
  it('на 200 seed-флик-жестах направление выбора согласовано и зеркалено RTL', () => {
    const rnd = lcg(4242);
    for (let iter = 0; iter < 200; iter++) {
      const start = 1; // средняя страница из 3 — есть куда идти в обе стороны
      const mag = 80 + rnd() * 200; // сила флика (px за 0.05s → быстрый)
      const leftward = rnd() < 0.5; // тянем влево или вправо
      const dx = leftward ? -mag : mag;

      const mk = (rtl: boolean) => {
        const c = createCarousel({ pageCount: 3, pageSize: 200, index: start, rtl });
        c.pointerDown(pt(0, 0, 0));
        c.pointerMove(pt(dx / 2, 0, 0.025));
        c.pointerMove(pt(dx, 0, 0.05));
        c.pointerUp(pt(dx, 0, 0.05));
        return c.state.index;
      };
      const ltrIdx = mk(false);
      const rtlIdx = mk(true);

      // LTR: влево = вперёд (index растёт), вправо = назад.
      if (leftward) expect(ltrIdx).toBe(2);
      else expect(ltrIdx).toBe(0);
      // RTL зеркалит вокруг стартовой страницы 1: 0↔2.
      expect(rtlIdx).toBe(2 - ltrIdx);
    }
  });
});
