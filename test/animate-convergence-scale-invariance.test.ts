/**
 * animate-convergence-scale-invariance.test.ts — сходимость main-пути НЕ
 * зависит от масштаба свойства.
 *
 * ЗАКОН (src/animate/main-unit.ts). Юнит считает канал осевшим, когда
 * ОТНОСИТЕЛЬНЫЕ остаток и скорость меньше CONVERGENCE_THRESHOLD:
 *
 *   |value − to| / max(|range|, RANGE_EPSILON) < ε   и   |velocity| / … < ε
 *
 * Деление на масштаб — не украшение. Без него «сошлось» означало бы «остаток
 * меньше 0.005 ЕДИНИЦ СВОЙСТВА», и одна и та же пружина сходилась бы за разное
 * число кадров в зависимости от того, двигаем мы opacity 0→1 или x 0→100000 px:
 * у крупного диапазона тот же перцептивный остаток в 0.005 доли — это 500 px,
 * а абсолютный порог требовал бы уехать ещё на пять порядков вглубь хвоста,
 * который человек уже не видит. Это лишние кадры main-потока ровно там, где их
 * больше всего (крупные перемещения), — и обратная сторона: для микроскопных
 * диапазонов (масштаб 1e-6) абсолютный порог объявлял бы анимацию осевшей на
 * ПЕРВОМ кадре, то есть проглатывал бы движение целиком.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. Мутант «убрать `/ scale`» выжил всю сьюту: ни один тест не
 * сравнивал ЧИСЛО КАДРОВ до завершения между масштабами. Здесь сравнивается
 * именно оно — инвариант формулируется как равенство, а не как «примерно».
 *
 * Mutation proof: снять деление на scale в обоих ассертах main-unit → RED
 * (крупный диапазон начинает требовать заметно больше кадров); заменить
 * max(|range|, RANGE_EPSILON) на |range| → RED на вырожденном from===to.
 */

import { describe, expect, it } from 'vitest';
import { animate } from '../src/animate/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;

/** Сколько кадров main-пути нужно, чтобы анимация завершилась естественно. */
function framesToSettle(from: number, to: number): number {
  const target = fakeEl();
  const clock = makeClock();
  let frames = 0;
  let done = false;
  animate(target.el, { x: [from, to] }, {
    spring: SPRING,
    requestFrame: clock.requestFrame,
    onComplete: () => { done = true; },
  });
  while (!done && frames < 4000) {
    clock.step(1000 / 60);
    frames++;
  }
  expect(done, `диапазон ${from}→${to} не сошёлся за 4000 кадров`).toBe(true);
  return frames;
}

describe('animate: сходимость инвариантна к масштабу свойства', () => {
  it('одна пружина сходится за ОДНО И ТО ЖЕ число кадров на любом диапазоне', () => {
    // Семь порядков величины. Порог относительный ⇒ число кадров совпадает
    // ТОЧНО: масштаб сокращается и в остатке, и в скорости.
    const reference = framesToSettle(0, 1);
    for (const to of [10, 1_000, 100_000, 1e6]) {
      expect(framesToSettle(0, to), `диапазон 0→${to}`).toBe(reference);
    }
    // И для микроскопного диапазона тоже: абсолютный порог объявил бы такую
    // анимацию осевшей мгновенно и проглотил бы движение.
    expect(framesToSettle(0, 1e-6)).toBe(reference);
  });

  it('знак и смещение диапазона не меняют число кадров', () => {
    const reference = framesToSettle(0, 100);
    expect(framesToSettle(100, 0)).toBe(reference);      // реверс
    expect(framesToSettle(-50, 50)).toBe(reference);     // через ноль
    expect(framesToSettle(1000, 1100)).toBe(reference);  // тот же range, сдвиг
  });

  it('вырожденный диапазон (from === to) сходится, а не делит на ноль', () => {
    // RANGE_EPSILON в знаменателе: без него 0/0 = NaN, сравнение ложно всегда,
    // и юнит крутил бы кадры до самого капа.
    const frames = framesToSettle(42, 42);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(10);
  });
});
