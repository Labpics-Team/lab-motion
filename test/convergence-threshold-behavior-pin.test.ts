/**
 * test/convergence-threshold-behavior-pin.test.ts — поведенческий пин
 * ЗНАЧЕНИЯ порога сходимости (internal/constants: CONVERGENCE_THRESHOLD).
 *
 * Класс (Б, найден диверсией s27): загрубление порога 0.005 → 0.05 проходило
 * весь сьют зелёным — тесты пинили факт сходимости, но не её точность.
 * Симптом класса у потребителя: финальный snap-кадр прыгает на ~5% диапазона
 * (видимый щелчок) вместо ≤0.5%.
 *
 * Пин поведением, не тавтологией `toBe(0.005)`: на медленной overdamped-пружине
 * шаг за кадр возле цели много меньше порога, значит предпоследнее значение
 * журнала (последнее ДО снапа в цель) обязано лежать в пределах порога от цели.
 * При пороге 0.05 оно оказывается на ~5% — тест красный.
 *
 * RED-proof (диверсия): в src/internal/constants.ts заменить 0.005 → 0.05 →
 * оба теста ниже красные.
 */

import { describe, expect, it } from 'vitest';
import { MotionValue } from '../src/index.js';

function makeStepClock() {
  let pending: Array<(ts?: number) => void> = [];
  let now = 0;
  return {
    requestFrame: (cb: (ts?: number) => void): number => {
      pending.push(cb);
      return 1;
    },
    step(): void {
      now += 1000 / 60;
      const batch = pending;
      pending = [];
      for (const cb of batch) cb(now);
    },
    pendingCount: () => pending.length,
  };
}

// Медленная сильно-передемпфированная пружина: возле цели движение ползёт,
// шаг за кадр « порога — предпоследний кадр честно отражает порог отсечки.
const SLOW_OVERDAMPED = { mass: 2, stiffness: 16, damping: 40 } as const;

describe('порог сходимости — точность финала запинена поведением', () => {
  it('последний кадр до снапа лежит в пределах 1.2% от цели (порог 0.5% + кадр)', () => {
    const clock = makeStepClock();
    const mv = new MotionValue({ initial: 0, spring: SLOW_OVERDAMPED, requestFrame: clock.requestFrame });
    const journal: number[] = [];
    mv.onChange((v) => journal.push(v));
    journal.length = 0; // immediate-emit подписки — не кадр
    mv.setTarget(100);

    let guard = 0;
    while (clock.pendingCount() > 0 && guard++ < 5000) clock.step();
    expect(guard).toBeLessThan(5000);

    const last = journal[journal.length - 1]!;
    expect(last).toBe(100); // снап точно в цель — инвариант финала

    const preSnap = journal[journal.length - 2]!;
    // range = 100 → порог 0.5% = 0.5; маржа на один кадр медленной пружины.
    expect(Math.abs(preSnap - 100), `preSnap=${preSnap}`).toBeLessThan(1.2);
    // Санити против вырождения теста: до порога значение реально ползло
    // (журнал длинный), а не прыгнуло сразу в цель.
    expect(journal.length).toBeGreaterThan(50);

    mv.destroy();
  });

  it('до порога анимация НЕ отсекается: на 2% от цели значение ещё живое', () => {
    const clock = makeStepClock();
    const mv = new MotionValue({ initial: 0, spring: SLOW_OVERDAMPED, requestFrame: clock.requestFrame });
    const journal: number[] = [];
    mv.onChange((v) => journal.push(v));
    journal.length = 0;
    mv.setTarget(100);

    let guard = 0;
    while (clock.pendingCount() > 0 && guard++ < 5000) clock.step();

    // Кадры в полосе (97..99.2]% от цели обязаны существовать: порог 0.5%
    // не имеет права съесть их снапом (при пороге 5% полоса пуста — снап
    // срабатывает раньше, чем значение туда доползает).
    const inBand = journal.filter((v) => v > 98 && v <= 99.2);
    expect(inBand.length, `кадров в полосе 98..99.2: ${inBand.length}`).toBeGreaterThan(0);

    mv.destroy();
  });
});
