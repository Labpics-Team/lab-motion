/**
 * test/animate-facade-defaults.test.ts — характеризация дефолтов ./animate.
 *
 * Класс: Б (characterization) — дефолты фасада ПИНЯТСЯ к токенам ./tokens:
 *   без опций          → spring.default (spring-first канон пакета);
 *   { duration }       → tween с ease = easing.standard.fn;
 *   { ease } без duration → duration.base (мс).
 * Смена дефолта (например spring.default → gentle) обязана сделать файл красным.
 *
 * Метод: траектория численно сверяется с публичной аналитикой ядра
 * (readCompositorSpring / easing.fn) на детерминированных шаг-часах —
 * не «похоже», а в явно заданной точности.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * На заглушке (export {}) каждый тест падал бы своим ассертом.
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import { duration, easing, spring as springTokens } from '../src/tokens/index.js';
import { fakeEl, makeClock, pickAnimate, translateXSeries } from './animate-facade-helpers.js';

const animate = pickAnimate(animateApi as Record<string, unknown>);

describe('./animate — дефолты из ./tokens (Класс Б, характеризация)', () => {
  it('без опций: траектория численно совпадает со spring.default', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100 }, { requestFrame: clock.requestFrame });
    const N = 8;
    for (let i = 0; i < N; i++) clock.step(16);
    const xs = translateXSeries(f.writes);
    expect(xs.length).toBe(N);
    for (let k = 0; k < N; k++) {
      const expected = readCompositorSpring(springTokens.default, {
        from: 0,
        to: 100,
        v0: 0,
        t: (k * 16) / 1000,
      }).value;
      expect(xs[k]!).toBeCloseTo(expected, 9);
    }
  });

  it('{ duration } без ease: изинг — easing.standard.fn в пределах точности', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100 }, { duration: 400, requestFrame: clock.requestFrame });
    clock.step(16); // elapsed 0 → from
    clock.step(200); // elapsed 200 → t=0.5
    const xs = translateXSeries(f.writes);
    const expected = 100 * easing.standard.fn(0.5);
    expect(xs.at(-1)!).toBeCloseTo(expected, 9);
  });

  it('{ ease } без duration: длительность — duration.base из токенов', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(
      f.el,
      { x: 100 },
      { ease: (t: number) => t, requestFrame: clock.requestFrame },
    );
    clock.step(16); // elapsed 0
    clock.step(duration.base - 1); // elapsed = base - 1 → ещё в полёте
    expect(translateXSeries(f.writes).at(-1)!).toBeLessThan(100);
    clock.step(1); // elapsed = duration.base → осел ровно на цели
    expect(translateXSeries(f.writes).at(-1)!).toBe(100);
    clock.drain(16);
    await controls.finished;
  });

  it('дефолт стал бы иным — тест красный (негативный контроль: gentle ≠ default)', () => {
    const t = 0.2;
    const def = readCompositorSpring(springTokens.default, { from: 0, to: 100, v0: 0, t }).value;
    const gentle = readCompositorSpring(springTokens.gentle, { from: 0, to: 100, v0: 0, t }).value;
    expect(Math.abs(def - gentle)).toBeGreaterThan(1e-6);
  });
});
