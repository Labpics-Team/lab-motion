/**
 * test/behaviors-pull.test.ts — pull-to-refresh: резистентный overscroll, порог
 * активации, pending без второго владельца позиции, возврат пружиной после async,
 * reduced, cancel/destroy. Класс А/Б.
 *
 * MUTATION-мишень: #9 второй владелец позиции (pending).
 */

import { describe, expect, it } from 'vitest';
import { createPullToRefresh } from '../src/behaviors/index.js';
import { makeClock, reduceMedia, pt } from './behaviors-helpers.js';

/** Управляемый deferred для async-действия refresh. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('./behaviors pull-to-refresh — резистентный overscroll', () => {
  it('value = rawPull·resistance (сопротивление): тянешь 160 при 0.5 → 80', () => {
    const pull = createPullToRefresh({ threshold: 60, resistance: 0.5 });
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, 160, 0.1));
    expect(pull.state.value).toBeCloseTo(80, 3);
    expect(pull.state.value).toBeLessThan(160); // сопротивление
    expect(pull.state.armed).toBe(true); // 80 >= 60
  });

  it('протяжка ПРОТИВ направления не тянет (value 0)', () => {
    const pull = createPullToRefresh({ threshold: 60 });
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, -100, 0.1)); // вверх при dir=1
    expect(pull.state.value).toBe(0);
    expect(pull.state.armed).toBe(false);
  });
});

describe('./behaviors pull-to-refresh — порог активации', () => {
  it('ниже порога → возврат к 0, refresh НЕ вызван', async () => {
    const clock = makeClock();
    let called = 0;
    const pull = createPullToRefresh({
      threshold: 60,
      resistance: 0.5,
      requestFrame: clock.requestFrame,
      onRefresh: () => {
        called++;
      },
    });
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, 80, 0.2)); // value 40 < 60
    pull.pointerMove(pt(0, 80, 0.4));
    pull.pointerUp(pt(0, 80, 0.5));
    clock.drain(16);
    await flush();
    expect(called).toBe(0);
    expect(pull.state.value).toBeCloseTo(0, 3);
    expect(pull.state.phase).toBe('idle');
  });
});

describe('./behaviors pull-to-refresh — pending без второго владельца (мутант #9)', () => {
  it('за порог → удержание на pendingPosition тем же runner; возврат после resolve', async () => {
    const clock = makeClock();
    const d = deferred();
    const pull = createPullToRefresh({
      threshold: 60,
      resistance: 0.5,
      requestFrame: clock.requestFrame,
      onRefresh: () => d.promise,
    });
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, 200, 0.1)); // value 100 >= 60 armed
    pull.pointerUp(pt(0, 200, 0.15));
    clock.drain(16); // доводка к pendingPosition
    await flush();
    expect(pull.state.pending).toBe(true);
    expect(pull.state.value).toBeCloseTo(60, 1); // pendingPosition = threshold

    // Пока pending — pointerDown ИГНОРИРУЕТСЯ (нет второго владельца позиции).
    pull.pointerDown(pt(0, 0, 2));
    pull.pointerMove(pt(0, 500, 2.1));
    expect(pull.state.value).toBeCloseTo(60, 1); // не сдвинулся
    expect(pull.state.phase).toBe('settle');

    // Async завершился → пружинный возврат к 0 тем же clock.
    d.resolve();
    await flush();
    clock.drain(16);
    expect(pull.state.pending).toBe(false);
    expect(pull.state.value).toBeCloseTo(0, 3);
    expect(pull.state.phase).toBe('idle');
  });
});

describe('./behaviors pull-to-refresh — reduced-motion', () => {
  it('удержание/возврат снапают мгновенно, pending-цикл сохранён', async () => {
    const clock = makeClock();
    const d = deferred();
    const pull = createPullToRefresh({
      threshold: 60,
      resistance: 0.5,
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(true) as unknown as (q: string) => MediaQueryList,
      onRefresh: () => d.promise,
    });
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, 200, 0.1));
    pull.pointerUp(pt(0, 200, 0.15));
    await flush();
    expect(clock.rafCalls()).toBe(0); // снап, ни одного кадра
    expect(pull.state.pending).toBe(true);
    expect(pull.state.value).toBeCloseTo(60, 3);
    d.resolve();
    await flush();
    expect(pull.state.value).toBeCloseTo(0, 3);
    expect(pull.state.pending).toBe(false);
  });
});

describe('./behaviors pull-to-refresh — cancel/destroy и pointer-cancel', () => {
  it('pointer-cancel во время протяжки → возврат домой, refresh не вызван', async () => {
    const clock = makeClock();
    let called = 0;
    const pull = createPullToRefresh({
      threshold: 60,
      resistance: 0.5,
      requestFrame: clock.requestFrame,
      onRefresh: () => {
        called++;
      },
    });
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, 300, 0.1)); // за порогом
    pull.pointerCancel();
    clock.drain(16);
    await flush();
    expect(called).toBe(0);
    expect(pull.state.value).toBeCloseTo(0, 3);
  });

  it('cancel/destroy идемпотентны', () => {
    const pull = createPullToRefresh({ threshold: 60 });
    pull.cancel();
    expect(() => pull.cancel()).not.toThrow();
    pull.destroy();
    expect(() => pull.destroy()).not.toThrow();
    pull.pointerDown(pt(0, 0, 0));
    pull.pointerMove(pt(0, 200, 0.1));
    expect(pull.state.value).toBe(0); // инертен
  });
});
