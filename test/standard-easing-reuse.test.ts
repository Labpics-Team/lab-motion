import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_EASING } from '../src/internal/motion-defaults.js';
import { cubicBezierUnchecked } from '../src/internal/cubic-bezier.js';
import { animate } from '../src/animate/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('стандартная кривая: повтор одной фазы', () => {
  it('одна фаза решается один раз, включая разные группы и вызовы animate', () => {
    STANDARD_EASING(0.1234567);
    const original = Math.min;
    let seeds = 0;
    vi.spyOn(Math, 'min').mockImplementation((...values) => {
      seeds++;
      return original(...values);
    });
    let total = 0;
    for (let i = 0; i < 1000; i++) total += STANDARD_EASING(0.371234);
    expect(total).toBeGreaterThan(0);
    expect(seeds).toBe(1);
  });

  it('другая фаза вытесняет предыдущую; память не растёт с числом времён', () => {
    const expected = cubicBezierUnchecked(0.2, 0, 0, 1);
    let state = 0x7ab49;
    for (let step = 0; step < 10_000; step++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const input = (state + 0.5) / 0x1_0000_0000;
      const first = STANDARD_EASING(input);
      expect(Math.abs(first - expected(input))).toBeLessThanOrEqual(1e-15);
      expect(Object.is(STANDARD_EASING(input), first)).toBe(true);
      STANDARD_EASING(1 - input);
      expect(Object.is(STANDARD_EASING(input), first)).toBe(true);
    }
  });

  it('границы и нечисловое время не повреждают следующее внутреннее значение', () => {
    const first = STANDARD_EASING(0.314159);
    for (const input of [NaN, -Infinity, Infinity, -0, 0, 1, -1, 2]) {
      expect(Number.isFinite(STANDARD_EASING(input))).toBe(true);
      expect(Object.is(STANDARD_EASING(0.314159), first)).toBe(true);
    }
  });

  it('произвольная easing-функция вызывается отдельно для каждого исполнителя', () => {
    const clock = makeClock();
    const ease = vi.fn((value: number) => value);
    const control = animate(Array.from({ length: 100 }, () => fakeEl().el),
      { x: [0, 100], opacity: [0, 1] }, { duration: 1000, ease, requestFrame: clock.requestFrame });
    try {
      clock.step(16); clock.step(16);
      expect(ease).toHaveBeenCalledTimes(400);
    } finally { control.cancel(); }
  });
});

it('повтор coercible-входа заново читает его значение', () => {
  let value = 0.2;
  const source = { valueOf: () => value } as unknown as number;
  const first = STANDARD_EASING(source);
  expect(first).toBe(STANDARD_EASING(0.2));
  STANDARD_EASING(source);
  value = 0.7;
  expect(STANDARD_EASING(source)).toBe(STANDARD_EASING(0.7));
  expect(STANDARD_EASING(source)).not.toBe(first);
});
