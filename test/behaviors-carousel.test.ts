/**
 * test/behaviors-carousel.test.ts — carousel/pager: единый clock позиции+индекса,
 * inertia с доводкой к странице, направление+velocity, RTL и вертикаль,
 * прерывание, cancel/destroy, reduced. Класс А/Б.
 *
 * MUTATION-мишени: #7 единый clock (index из position), #10 RTL-знак.
 */

import { describe, expect, it } from 'vitest';
import { createCarousel } from '../src/behaviors/index.js';
import { makeClock, reduceMedia, pt, flickX } from './behaviors-helpers.js';

describe('./behaviors carousel — основной сценарий (флик-перелистывание)', () => {
  it('быстрый флик влево (LTR) → следующая страница, доводка к 200', () => {
    const clock = makeClock();
    const c = createCarousel({ pageCount: 3, pageSize: 200, requestFrame: clock.requestFrame });
    flickX(c, 0, -120, 0.05); // drag left, быстрый
    expect(c.state.phase).toBe('release');
    clock.drain(16);
    expect(c.state.index).toBe(1);
    expect(c.state.value).toBeCloseTo(200, 3);
  });

  it('медленный маленький drag < полстраницы → возврат на ту же страницу', () => {
    const clock = makeClock();
    const c = createCarousel({ pageCount: 3, pageSize: 200, requestFrame: clock.requestFrame });
    c.pointerDown(pt(0, 0, 0));
    c.pointerMove(pt(-30, 0, 0.3));
    c.pointerMove(pt(-30, 0, 0.6));
    c.pointerUp(pt(-30, 0, 0.7)); // мало и медленно
    clock.drain(16);
    expect(c.state.index).toBe(0);
    expect(c.state.value).toBeCloseTo(0, 3);
  });
});

describe('./behaviors carousel — единый clock: index выводится из position (мутант #7)', () => {
  it('каждый эмит-кадр: index === clamp(round(value/pageSize))', () => {
    const clock = makeClock();
    const pairs: Array<{ v: number; i: number }> = [];
    const c = createCarousel({
      pageCount: 4,
      pageSize: 100,
      requestFrame: clock.requestFrame,
      onChange: (s) => pairs.push({ v: s.value, i: s.index }),
    });
    c.goTo(3);
    clock.drain(16);
    expect(pairs.length).toBeGreaterThan(3);
    for (const { v, i } of pairs) {
      const expected = Math.max(0, Math.min(3, Math.round(v / 100)));
      expect(i).toBe(expected);
    }
    expect(c.state.index).toBe(3);
  });
});

describe('./behaviors carousel — программное управление', () => {
  it('goTo/next/prev двигают единым clock, клэмп на границах', () => {
    const clock = makeClock();
    const c = createCarousel({ pageCount: 3, pageSize: 200, requestFrame: clock.requestFrame });
    c.next();
    clock.drain(16);
    expect(c.state.index).toBe(1);
    c.next();
    clock.drain(16);
    expect(c.state.index).toBe(2);
    c.next(); // клэмп: уже последняя
    clock.drain(16);
    expect(c.state.index).toBe(2);
    c.prev();
    clock.drain(16);
    expect(c.state.index).toBe(1);
  });
});

describe('./behaviors carousel — RTL зеркалит направление (мутант #10)', () => {
  it('тот же флик влево: LTR → next, RTL → prev', () => {
    const clockL = makeClock();
    const ltr = createCarousel({
      pageCount: 3,
      pageSize: 200,
      index: 1,
      requestFrame: clockL.requestFrame,
    });
    flickX(ltr, 0, -120, 0.05);
    clockL.drain(16);

    const clockR = makeClock();
    const rtl = createCarousel({
      pageCount: 3,
      pageSize: 200,
      index: 1,
      rtl: true,
      requestFrame: clockR.requestFrame,
    });
    flickX(rtl, 0, -120, 0.05);
    clockR.drain(16);

    expect(ltr.state.index).toBe(2); // LTR: влево = вперёд
    expect(rtl.state.index).toBe(0); // RTL: влево = назад (зеркало вокруг 1)
  });
});

describe('./behaviors carousel — вертикальная ось', () => {
  it('axis=y: флик вверх → следующая страница', () => {
    const clock = makeClock();
    const c = createCarousel({
      pageCount: 3,
      pageSize: 200,
      axis: 'y',
      requestFrame: clock.requestFrame,
    });
    c.pointerDown(pt(0, 0, 0));
    c.pointerMove(pt(0, -60, 0.025));
    c.pointerMove(pt(0, -120, 0.05));
    c.pointerUp(pt(0, -120, 0.05));
    clock.drain(16);
    expect(c.state.index).toBe(1);
  });
});

describe('./behaviors carousel — прерывание и lifecycle', () => {
  it('pointer-down во время доводки → follow, без параллельного loop', () => {
    const clock = makeClock();
    const c = createCarousel({ pageCount: 3, pageSize: 200, requestFrame: clock.requestFrame });
    c.goTo(2);
    clock.step(16);
    c.pointerDown(pt(0, 0, 1));
    expect(c.state.phase).toBe('follow');
    const before = c.state.value;
    clock.drain(16);
    expect(c.state.value).toBeCloseTo(before, 3);
    expect(clock.pending()).toBe(0);
  });

  it('cancel/destroy идемпотентны', () => {
    const c = createCarousel({ pageCount: 3, pageSize: 200 });
    c.cancel();
    expect(() => c.cancel()).not.toThrow();
    c.destroy();
    expect(() => c.destroy()).not.toThrow();
    const before = c.state.value;
    c.pointerDown(pt(0, 0, 0));
    c.pointerMove(pt(-100, 0, 0.1));
    expect(c.state.value).toBe(before); // инертен
  });
});

describe('./behaviors carousel — reduced-motion', () => {
  it('доводка снапает к странице мгновенно', () => {
    const clock = makeClock();
    const c = createCarousel({
      pageCount: 3,
      pageSize: 200,
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(true) as unknown as (q: string) => MediaQueryList,
    });
    flickX(c, 0, -120, 0.05);
    expect(clock.rafCalls()).toBe(0);
    expect(c.state.index).toBe(1);
    expect(c.state.value).toBeCloseTo(200, 3);
  });
});
