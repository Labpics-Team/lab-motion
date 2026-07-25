/**
 * animate-pause-clock.test.ts — на паузе часы прогона СТОЯТ.
 *
 * ЧТО БЫЛО СЛОМАНО (аудит 2026-07-25). `pause()` на compositor-ветке снимает
 * WAAPI-эффект, поэтому native `currentTime` пропадает и `_elapsed()` уходит в
 * fallback `now() − _startTime`, который продолжает идти вместе с настенным
 * временем. Любая последующая операция, переснимающая позу (`cancel()`,
 * ретаргет через повторный `animate()`), читала это уехавшее время и писала
 * позицию БУДУЩЕГО кадра.
 *
 * Замер: пауза на 1100 фиксирует translateX(37.49px); через 400 мс реального
 * времени `cancel()` пишет translateX(98.90px) — прыжок на 61 px из положения,
 * в котором элемент визуально стоял. Тот же снимок уходит в реестр, поэтому и
 * СЛЕДУЮЩИЙ animate() стартовал с 98.90 вместо 37.49.
 *
 * Существующие тесты этого не ловили по одной причине: они держат часы
 * замороженными (`now: () => 0`) либо двигают их ДО pause(), а не во время.
 *
 * ЗАКОН. Пока юнит на паузе, `_syncSnapshot()` не трогает позу: она уже
 * зафиксирована самой паузой. `play()` в этом не участвует — он пере-сеет
 * кривую, и `_emit` заново ставит `_startTime`.
 *
 * Mutation proof: снять `if (this._paused) return;` из _syncSnapshot → RED на
 * обоих блоках («поза уехала на паузе»).
 */

import { describe, expect, it } from 'vitest';
import { animate } from '../src/animate/index.js';
import { createWaapiDouble } from './support/waapi-double.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;
const NO_REDUCE = (() => ({ matches: false })) as never;

/** Прогон на compositor-ветке с управляемыми часами. */
function start(double: ReturnType<typeof createWaapiDouble>, to: number, now: () => number) {
  return animate(double.el as never, { x: to }, {
    spring: SPRING,
    now,
    setTimer: () => () => {},
    matchMedia: NO_REDUCE,
  });
}

describe('animate: часы прогона на паузе стоят', () => {
  it('cancel через 400 мс после паузы оставляет ту же позу', () => {
    const double = createWaapiDouble();
    let now = 1000;
    const controls = start(double, 100, () => now);
    now = 1100;
    double.advance(100);
    controls.pause();
    const paused = double.el.style.getPropertyValue('transform');
    expect(paused, 'пауза обязана зафиксировать позу инлайном').toContain('translateX(');

    now = 1500; // 400 мс настенного времени на паузе
    controls.cancel();
    expect(
      double.el.style.getPropertyValue('transform'),
      'поза уехала на паузе: cancel телепортировал элемент вперёд',
    ).toBe(paused);
  });

  it('ретаргет через 400 мс после паузы стартует С ПОЗЫ ПАУЗЫ', () => {
    const double = createWaapiDouble();
    let now = 1000;
    const controls = start(double, 100, () => now);
    now = 1100;
    double.advance(100);
    controls.pause();
    const paused = double.el.style.getPropertyValue('transform');

    now = 1500;
    start(double, 200, () => now);
    const first = double.calls.at(-1)?.keyframes?.[0] as { transform?: string } | undefined;
    expect(
      first?.transform,
      'новый прогон стартовал не с той позы, в которой элемент стоял',
    ).toBe(paused);
  });

  it('seek на паузе двигает позу — это НЕ заморожено', () => {
    // Обратная сторона закона: стоят ЧАСЫ, а не сам юнит. Явная перемотка
    // обязана менять позу, иначе seek на паузе стал бы no-op.
    const double = createWaapiDouble();
    let now = 1000;
    const controls = start(double, 100, () => now);
    now = 1100;
    double.advance(100);
    controls.pause();
    const paused = double.el.style.getPropertyValue('transform');

    controls.seek(400);
    const seeked = double.el.style.getPropertyValue('transform');
    expect(seeked).not.toBe(paused);
    // И после seek поза снова стабильна во времени.
    now = 2000;
    controls.cancel();
    expect(double.el.style.getPropertyValue('transform')).toBe(seeked);
  });
});
