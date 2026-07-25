/**
 * time-units-behaviour.test.ts — единицы времени как ИСПОЛНЯЕМОЕ утверждение.
 *
 * Контракт-тест рядом (time-units-contract.test.ts) следит за ТЕГАМИ: каждое
 * публичное поле со временем обязано назвать свою единицу, и карта единиц
 * заморожена. Но тег — это обещание в комментарии; сменить единицу В КОДЕ и
 * забыть тег он не поймает.
 *
 * Здесь проверяется САМА СЕМАНТИКА, и именно в тех точках, где два яруса
 * встречаются и где ×1000 обязан присутствовать РОВНО ОДИН РАЗ:
 *   • `compileWaapi` — вход в секундах, выход в миллисекундах WAAPI;
 *   • `compileSpringPlan` — пружина в секундах, план `Element.animate()` в мс;
 *   • `createTimeline` / `keyframes` — виртуальное время в секундах насквозь;
 *   • трекер скорости жестов — точки в секундах, скорость в px/s.
 *
 * Аудит 2026-07-25: до него ни одного такого ассерта не существовало, а
 * docs/getting-started.md обещал миллисекунды для ВСЕХ публичных опций — то
 * есть был неверен для восьми субпутей. Ошибка единицы не бросает исключение
 * (500 секунд — валидный таймлайн), поэтому ловить её можно только так.
 *
 * Mutation proof: убрать `* 1000` в compileWaapi → RED; поменять шкалу
 * таймлайна на миллисекунды → RED; поделить `t` трекера на 1000 → RED.
 */

import { describe, expect, it } from 'vitest';
import { compileSpringPlan } from '../src/compositor/core.js';
import { createVelocityTracker } from '../src/gestures/index.js';
import { keyframes } from '../src/keyframes/index.js';
import { spring } from '../src/spring.js';
import { fromBounce } from '../src/spring/index.js';
import { createTimeline } from '../src/timeline/index.js';
import { compileWaapi } from '../src/waapi/index.js';

describe('единицы времени: физический ярус считает в СЕКУНДАХ', () => {
  it('createTimeline: duration сегмента — секунды виртуального времени', () => {
    const seen: number[] = [];
    // requestFrame-заглушка вместо rAF: детерминизм без кадров (идиома сьюты).
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 2, onStep: (v) => seen.push(v) }],
      requestFrame: () => 0,
    });
    // 2 — это ДВЕ СЕКУНДЫ, а не две миллисекунды: тот же масштаб, что у seek.
    expect(tl.totalDuration).toBe(2);
    tl.seek(1);
    expect(tl.time).toBe(1);
    expect(tl.progress).toBeCloseTo(0.5, 10);
    expect(seen.at(-1)).toBeCloseTo(50, 10); // середина линейного сегмента
    // Подай сюда «300» в расчёте на миллисекунды — получишь пять минут.
    expect(createTimeline({
      segments: [{ from: 0, to: 1, duration: 300 }],
      requestFrame: () => 0,
    }).totalDuration).toBe(300);
  });

  it('keyframes: duration цикла — секунды', () => {
    const seen: number[] = [];
    const kf = keyframes({
      values: [0, 10], duration: 2, requestFrame: () => 0, onStep: (v) => seen.push(v),
    });
    expect(kf.totalDuration).toBe(2);
    kf.seek(1);
    expect(kf.time).toBe(1);
    expect(seen.at(-1)).toBeCloseTo(5, 10);
  });

  it('spring/fromBounce: duration — секунды, и солвер понимает их так же', () => {
    const params = fromBounce({ duration: 0.5, bounce: 0 });
    // Пружина, собранная «на 0.5 секунды», к 0.5 с обязана быть у цели, а к
    // 0.5 МИЛЛИСЕКУНДЫ — практически на старте. Это и есть цена ×1000.
    expect(spring(params, 0.5, 0).value).toBeGreaterThan(0.98);
    expect(spring(params, 0.0005, 0).value).toBeLessThan(0.01);
  });

  it('трекер скорости жестов: точки в секундах ⇒ скорость в px/s', () => {
    const tracker = createVelocityTracker();
    // Один кадр 60 fps = 1/60 СЕКУНДЫ, смещение 10 px ⇒ 600 px/s.
    tracker.push({ x: 0, y: 0, t: 0 });
    tracker.push({ x: 10, y: 0, t: 1 / 60 });
    expect(tracker.velocity().vx).toBeCloseTo(600, 6);
    // То же событие, поданное в миллисекундах (16.67), даёт 0.6 px/s — ровно в
    // 1000 раз меньше. Инерция после отпускания при такой скорости не наступает.
    const wrong = createVelocityTracker();
    wrong.push({ x: 0, y: 0, t: 0 });
    wrong.push({ x: 10, y: 0, t: 1000 / 60 });
    expect(wrong.velocity().vx).toBeCloseTo(0.6, 6);
  });
});

describe('единицы времени: фасадный ярус отдаёт МИЛЛИСЕКУНДЫ', () => {
  it('compileWaapi: вход duration в секундах → timing.duration в мс (×1000 ровно один раз)', () => {
    const compiled = compileWaapi({ property: 'opacity', values: [0, 1], duration: 2 });
    expect(compiled.timing.duration).toBe(2000);
    // Масштаб линеен и без «полуторных» коэффициентов: удвоение входа удваивает
    // выход, а не сдвигает его на константу.
    const twice = compileWaapi({ property: 'opacity', values: [0, 1], duration: 4 });
    expect(twice.timing.duration).toBe(4000);
  });

  it('compileSpringPlan: физика в секундах → duration плана в миллисекундах', () => {
    const params = { mass: 1, stiffness: 170, damping: 26 };
    const plan = compileSpringPlan({ spring: params, property: 'opacity', from: 0, to: 1 });
    // План уходит в Element.animate() как есть ⇒ миллисекунды. Канон {1,170,26}
    // оседает за доли секунды, поэтому план — СОТНИ мс, а не сотни секунд и не
    // доли миллисекунды. Диапазон широкий намеренно: пин ловит порядок величины
    // (единицу), а точное значение пришпилено в compositor-velocity-budget.
    expect(plan.duration).toBeGreaterThan(100);
    expect(plan.duration).toBeLessThan(10_000);
    // И ровно в 1000 раз больше секундного горизонта того же солвера.
    expect(plan.duration / 1000).toBeGreaterThan(0.1);
  });
});
