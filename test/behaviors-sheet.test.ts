/**
 * test/behaviors-sheet.test.ts — bottom sheet: пример, контракт переходов,
 * прерывание, cancel/destroy, reduced-motion. Класс А/Б.
 *
 * MUTATION-мишени (см. докблок src/behaviors/index.ts): #1 выбор snap по
 * скорости, #2 velocity на follow→release, #3 параллельный loop, #4 идемпотентность
 * cancel, #5 reduced-leak, #8 rubber-band знак.
 */

import { describe, expect, it, vi } from 'vitest';
import { createBottomSheet } from '../src/behaviors/index.js';
import { makeClock, reduceMedia, pt, flickY } from './behaviors-helpers.js';

const SNAPS = [0, 300, 600];

describe('./behaviors bottom sheet — основной сценарий', () => {
  it('медленный drag к 280 → доводка в ближайший snap 300, phase settle', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: SNAPS, requestFrame: clock.requestFrame });
    // Медленно (0.5s) — низкая скорость: выбор по положению.
    flickY(sheet, 0, 280, 0.5, 5);
    expect(sheet.state.phase).toBe('release');
    clock.drain(16);
    expect(sheet.state.phase).toBe('settle');
    expect(sheet.state.value).toBeCloseTo(300, 3);
    expect(sheet.state.snapIndex).toBe(1);
    expect(sheet.state.velocity).toBe(0);
  });

  it('быстрый флик с малой позиции перепрыгивает snap по СКОРОСТИ (проекция decay)', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: SNAPS, requestFrame: clock.requestFrame });
    // К 150 за 0.05s → ~3000 px/s: проекция улетает к дальнему snap.
    flickY(sheet, 0, 150, 0.05, 5);
    const chosen = sheet.state.snapIndex;
    clock.drain(16);
    expect(chosen).toBeGreaterThanOrEqual(2); // мутант #1 (landing=value) → выбрал бы 0/1
    expect(sheet.state.value).toBeCloseTo(600, 3);
  });

  it('follow→release НЕ теряет velocity: старт доводки идёт с ненулевой скоростью', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const sheet = createBottomSheet({
      snapPoints: SNAPS,
      requestFrame: clock.requestFrame,
      onChange: (s) => {
        if (s.phase === 'release') seen.push(s.velocity);
      },
    });
    flickY(sheet, 0, 200, 0.08, 5);
    clock.step(16); // первый кадр доводки
    // Мутант #2 (v0n=0): первый кадр скорости ≈ 0. C¹: скорость заметно ненулевая.
    const maxV = Math.max(...seen.map(Math.abs));
    expect(maxV).toBeGreaterThan(50);
  });
});

describe('./behaviors bottom sheet — rubber-band за крайними snap', () => {
  it('drag за max=600 сопротивляется: value ∈ (600, raw), знак сохранён (мутант #8)', () => {
    const sheet = createBottomSheet({ snapPoints: SNAPS, rubberBand: 0.5 });
    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 800, 0.1)); // raw=800 за границей 600
    expect(sheet.state.value).toBeGreaterThan(600);
    expect(sheet.state.value).toBeLessThan(800);
    expect(sheet.state.value).toBeCloseTo(700, 3); // 600 + (800-600)*0.5
  });

  it('rubberBand=0 → жёсткий clamp на границе', () => {
    const sheet = createBottomSheet({ snapPoints: SNAPS, rubberBand: 0 });
    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 800, 0.1));
    expect(sheet.state.value).toBeCloseTo(600, 3);
  });
});

describe('./behaviors bottom sheet — программный переход', () => {
  it('snapTo(2) → доводка к 600, единый clock', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: SNAPS, requestFrame: clock.requestFrame });
    sheet.snapTo(2);
    expect(sheet.state.phase).toBe('release');
    clock.drain(16);
    expect(sheet.state.value).toBeCloseTo(600, 3);
    expect(sheet.state.snapIndex).toBe(2);
  });
});

describe('./behaviors bottom sheet — прерывание pointer-down во время settle (мутант #3)', () => {
  it('pointer-down в фазе release гасит доводку, НЕ плодит второй clock', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: SNAPS, requestFrame: clock.requestFrame });
    sheet.snapTo(2);
    clock.step(16);
    clock.step(16); // частично доехали
    const midValue = sheet.state.value;
    expect(sheet.state.phase).toBe('release');

    sheet.pointerDown(pt(0, midValue, 1)); // перехват
    expect(sheet.state.phase).toBe('follow');

    // Оставшийся stale-кадр гаснет: дальнейший drain НЕ двигает value к 600.
    const before = sheet.state.value;
    clock.drain(16);
    expect(sheet.state.value).toBeCloseTo(before, 3);
    // Один stale-callback умирает без перепланирования — очередь пуста.
    expect(clock.pending()).toBe(0);
  });
});

describe('./behaviors bottom sheet — cancel/destroy идемпотентны (мутант #4)', () => {
  it('cancel() дважды: второй вызов — no-op (без лишних эмитов), phase idle', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: SNAPS, requestFrame: clock.requestFrame });
    sheet.snapTo(2);
    clock.step(16);
    const spy = vi.fn();
    sheet.subscribe(spy);
    sheet.cancel();
    expect(sheet.state.phase).toBe('idle');
    const afterFirst = spy.mock.calls.length;
    sheet.cancel(); // идемпотентно
    expect(spy.mock.calls.length).toBe(afterFirst);
  });

  it('destroy() делает вход инертным и идемпотентен', () => {
    const sheet = createBottomSheet({ snapPoints: SNAPS });
    sheet.destroy();
    expect(() => sheet.destroy()).not.toThrow();
    const before = sheet.state.value;
    sheet.pointerDown(pt(0, 100, 0));
    sheet.pointerMove(pt(0, 300, 0.1));
    expect(sheet.state.value).toBe(before); // инертен
    expect(sheet.state.phase).toBe('idle');
  });
});

describe('./behaviors bottom sheet — reduced-motion character-switch (мутант #5)', () => {
  it('release снапает в snap МГНОВЕННО, без единого кадра, результат сохранён', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({
      snapPoints: SNAPS,
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(true) as unknown as (q: string) => MediaQueryList,
    });
    flickY(sheet, 0, 280, 0.5, 5);
    // Мгновенно осел (нет кадров): ни одного requestFrame.
    expect(clock.rafCalls()).toBe(0);
    expect(sheet.state.phase).toBe('settle');
    expect(sheet.state.value).toBeCloseTo(300, 3);
    expect(sheet.state.velocity).toBe(0);
  });
});
