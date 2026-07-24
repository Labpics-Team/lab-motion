/**
 * test/synthetic-frame-anchor.test.ts — сброс якоря timestamp-цепочки после
 * синтетического кадра (rAF handle 0 → setTimeout(cb(undefined)), non-draining
 * шов — конвенция repo). Классы: А (contract) + Д (mutation-proof).
 *
 * Контракт (зеркало MainUnit._updateStep): кадр без ts добавляет фиксированный
 * шаг И рвёт цепочку меток (lastTs = undefined); следующий реальный ts лишь
 * пере-якоряет отсчёт. Без сброса интервал [lastTs, ts] досчитался бы ВТОРОЙ
 * раз поверх уже добавленного фиксированного шага — elapsed скачет на весь
 * разрыв между реальными кадрами.
 *
 * Сценарий-детектор: [ts=0, ts=16, synthetic, ts=5016]. С фиксом elapsed ≈
 * 0.016 + FIXED_DT + 0 (ре-якорь) ≈ 0.03 c — доводка/глайд ещё живы. С багом
 * elapsed ≈ 5.03 c — мгновенное оседание. Твин-прогон [0, 16, 5016] БЕЗ
 * синтетики оседает честно — доказывает, что детектор различает именно сброс
 * якоря, а не медленную пружину.
 *
 * Mutation proof: убрать `lastTs = undefined` из else-ветки тика
 * (_createRunner в behaviors / глайд-тик в gestures) → кадр 5016 добавляет
 * ~5 c поверх синтетики → ассерты «ещё не осел» падают.
 */

import { describe, expect, it } from 'vitest';
import { createPullToRefresh } from '../src/behaviors/index.js';
import { createDrag } from '../src/gestures/index.js';
import { pt } from './behaviors-helpers.js';

/** Ручной клок: кадры выстреливаются с ЯВНЫМ ts или синтетически (undefined). */
function manualClock() {
  const queue: Array<(ts?: number) => void> = [];
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return queue.length; // handle > 0: не задевает setTimeout-шов
    },
    fire(ts?: number): void {
      for (const cb of queue.splice(0)) cb(ts);
    },
    pending(): number {
      return queue.length;
    },
  };
}

describe('./behaviors: синтетический кадр рвёт якорь ts (нет двойного счёта)', () => {
  function releasedPull(clock: ReturnType<typeof manualClock>) {
    const pull = createPullToRefresh({
      threshold: 60,
      resistance: 0.5,
      requestFrame: clock.requestFrame,
    });
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, 80, 0.2)); // value 40 < 60 → возврат пружиной
    pull.pointerUp(pt(0, 80, 0.3));
    return pull;
  }

  it('[0, 16, synthetic, 5016]: поздний реальный кадр НЕ досчитывает разрыв — возврат ещё идёт', () => {
    const clock = manualClock();
    const pull = releasedPull(clock);
    clock.fire(0);
    clock.fire(16);
    clock.fire(undefined); // синтетика: +FIXED_DT_S и сброс якоря
    clock.fire(5016); // пере-якорь: добавляет 0, не ~5 секунд
    expect(pull.state.phase).not.toBe('idle');
    expect(pull.state.value).toBeGreaterThan(20); // от 40 прошло лишь ~0.03 c пружины
  });

  it('твин без синтетики [0, 16, 5016] оседает — детектор различает именно якорь', () => {
    const clock = manualClock();
    const pull = releasedPull(clock);
    clock.fire(0);
    clock.fire(16);
    clock.fire(5016);
    expect(pull.state.phase).toBe('idle');
    expect(pull.state.value).toBeCloseTo(0, 3);
  });
});

describe('./gestures глайд: синтетический кадр рвёт якорь ts (нет двойного счёта)', () => {
  function flickIntoGlide(clock: ReturnType<typeof manualClock>): void {
    const d = createDrag({ requestFrame: clock.requestFrame });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: 100, y: 0, t: 0.08 }); // vx ≈ 1250 px/s → инерционный глайд
  }

  it('[0, 16, synthetic, 5016]: глайд ещё жив (кадр перепланирован)', () => {
    const clock = manualClock();
    flickIntoGlide(clock);
    clock.fire(0);
    clock.fire(16);
    clock.fire(undefined);
    clock.fire(5016);
    expect(clock.pending()).toBe(1); // decay ещё не оседает — планирует кадры
  });

  it('твин без синтетики [0, 16, 5016] оседает (глайд завершён, кадров нет)', () => {
    const clock = manualClock();
    flickIntoGlide(clock);
    clock.fire(0);
    clock.fire(16);
    clock.fire(5016);
    expect(clock.pending()).toBe(0);
  });
});
