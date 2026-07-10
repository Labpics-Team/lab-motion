/**
 * test/behaviors-finiteness-fuzz.test.ts — B2: value/velocity конечны и без −0
 * при ВРАЖДЕБНОМ вводе (NaN/±∞/огромные координаты). Класс В (seeded-LCG).
 *
 * Каждое из четырёх поведений прогоняется на злых точках; после доводки (drain)
 * состояние обязано остаться конечным (никогда NaN/∞), −0 схлопнут.
 */

import { describe, expect, it } from 'vitest';
import {
  createBottomSheet,
  createCarousel,
  createDragDismiss,
  createPullToRefresh,
  type BehaviorState,
} from '../src/behaviors/index.js';
import { lcg, makeClock, pt } from './behaviors-helpers.js';

/** Злое число из seed: NaN, ±∞, ±MAX, огромное, нормальное. */
function evil(rnd: () => number): number {
  const pick = Math.floor(rnd() * 6);
  switch (pick) {
    case 0:
      return NaN;
    case 1:
      return Infinity;
    case 2:
      return -Infinity;
    case 3:
      return Number.MAX_VALUE;
    case 4:
      return (rnd() - 0.5) * 1e9;
    default:
      return (rnd() - 0.5) * 400;
  }
}

function assertFinite(s: BehaviorState<number>): void {
  expect(Number.isFinite(s.value)).toBe(true);
  expect(Number.isFinite(s.velocity)).toBe(true);
  expect(Object.is(s.value, -0)).toBe(false);
  expect(Object.is(s.velocity, -0)).toBe(false);
}

describe('./behaviors finiteness fuzz — злой ввод → конечное состояние', () => {
  it('bottom sheet: 3000 злых жестов держат value/velocity конечными', () => {
    const rnd = lcg(11);
    for (let i = 0; i < 3000; i++) {
      const clock = makeClock();
      const sheet = createBottomSheet({ snapPoints: [0, 300, 600], requestFrame: clock.requestFrame });
      sheet.pointerDown(pt(evil(rnd), evil(rnd), evil(rnd)));
      sheet.pointerMove(pt(evil(rnd), evil(rnd), evil(rnd)));
      sheet.pointerUp(pt(evil(rnd), evil(rnd), evil(rnd)));
      clock.drain(16, 200);
      assertFinite(sheet.state);
    }
  });

  it('drag-to-dismiss: злой ввод конечен', () => {
    const rnd = lcg(22);
    for (let i = 0; i < 3000; i++) {
      const clock = makeClock();
      const d = createDragDismiss({ distanceThreshold: 100, requestFrame: clock.requestFrame });
      d.pointerDown(pt(evil(rnd), evil(rnd), evil(rnd)));
      d.pointerMove(pt(evil(rnd), evil(rnd), evil(rnd)));
      d.pointerUp(pt(evil(rnd), evil(rnd), evil(rnd)));
      clock.drain(16, 200);
      assertFinite(d.state);
    }
  });

  it('carousel: злой ввод конечен', () => {
    const rnd = lcg(33);
    for (let i = 0; i < 3000; i++) {
      const clock = makeClock();
      const c = createCarousel({ pageCount: 4, pageSize: 200, requestFrame: clock.requestFrame });
      c.pointerDown(pt(evil(rnd), evil(rnd), evil(rnd)));
      c.pointerMove(pt(evil(rnd), evil(rnd), evil(rnd)));
      c.pointerUp(pt(evil(rnd), evil(rnd), evil(rnd)));
      clock.drain(16, 200);
      assertFinite(c.state);
    }
  });

  it('pull-to-refresh: злой ввод конечен', () => {
    const rnd = lcg(44);
    for (let i = 0; i < 3000; i++) {
      const clock = makeClock();
      const pull = createPullToRefresh({ threshold: 60, requestFrame: clock.requestFrame });
      pull.pointerDown(pt(evil(rnd), evil(rnd), evil(rnd)));
      pull.pointerMove(pt(evil(rnd), evil(rnd), evil(rnd)));
      pull.pointerUp(pt(evil(rnd), evil(rnd), evil(rnd)));
      clock.drain(16, 200);
      assertFinite(pull.state);
    }
  });
});
