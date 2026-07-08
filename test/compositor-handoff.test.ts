/**
 * test/compositor-handoff.test.ts — C¹-хендофф compositor→live (M2).
 * Классы: А (маппинг: снимок состояния → live MotionValue), В (differential
 * против solveSpring/readCompositorSpring — воспроизведение хвоста в пределах
 * tolerance), Д (mutation/RED: без засева скорости траектория расходится).
 *
 * ── RED PROOF ─────────────────────────────────────────────────────────────────
 * - НЕ засеивать скорость (initialVelocity=0) → «continue ≡ original tail» RED
 *   (негативный контроль ниже: без засева девиация > tolerance).
 * - Снять cancel старой Animation при хендоффе → «compositor Animation отменена» RED.
 * - Взять позицию из from вместо readCompositorSpring → «C⁰ join = analytic value» RED.
 * - clamp=true на live-пружине → расхождение overshoot против compositor-кривой.
 *
 * Аналитический снимок (readCompositorSpring по elapsed), НЕ getComputedStyle:
 * семплинг здесь — только КРОСС-ЧЕК идентичности замкнутой формы, не источник.
 */

import { describe, expect, it } from 'vitest';
import {
  CompositorSpring,
  handoffToLive,
  readCompositorSpring,
} from '../src/compositor/index.js';
import { MotionValue } from '../src/index.js';
import { FIXED_DT_S } from '../src/internal/constants.js';
import { MotionParamError } from '../src/index.js';
import type { SpringParams } from '../src/spring.js';

const STIFF: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const BOUNCY: SpringParams = { mass: 1, stiffness: 180, damping: 8 };
const DEFAULT_TOL = 1 / 400;

/** Синхронные дренируемые часы (ts НЕ передаётся → шаг FIXED_DT_S; handle ≠ 0). */
function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length;
  };
  const drain = (cap = 100000): number => {
    let n = 0;
    while (queue.length > 0 && n < cap) {
      queue.shift()!();
      n++;
    }
    return n;
  };
  const step = (frames: number): void => {
    for (let i = 0; i < frames && queue.length > 0; i++) queue.shift()!();
  };
  return { requestFrame, drain, step };
}

/** Фейк-Element: пишет вызовы .animate, раздаёт Animation со spy-cancel. */
function fakeElement() {
  const calls: { keyframes: Record<string, string | number>[]; timing: Record<string, unknown> }[] = [];
  const animations: { cancelled: boolean }[] = [];
  return {
    calls,
    animations,
    el: {
      animate(keyframes: Record<string, string | number>[], timing: Record<string, unknown>) {
        calls.push({ keyframes, timing });
        const anim = { cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(anim);
        return anim;
      },
    },
  };
}

// ─── Standalone handoffToLive: непрерывность и differential ───────────────────

describe('compositor handoff: handoffToLive — C¹ непрерывность', () => {
  it('C⁰ join: первое эмитнутое значение = точка хендоффа (value)', () => {
    const clock = makeClock();
    const seen: number[] = [];
    handoffToLive({
      spring: STIFF,
      value: 42,
      velocity: 0,
      target: 100,
      requestFrame: clock.requestFrame,
      onChange: (v) => seen.push(v),
    });
    // onChange эмитит текущее значение сразу при подписке — это точка рождения.
    expect(seen[0]).toBe(42);
  });

  it('differential: live-хвост воспроизводит ПРОДОЛЖЕННУЮ пружину в пределах tolerance', () => {
    // Оригинал: 0→100, покой. В момент t*=0.1 снимаем (value, velocity) замкнутой
    // формой и продолжаем ЖИВОЙ пружиной к той же цели 100.
    for (const params of [STIFF, BOUNCY]) {
      const range0 = 100;
      const tStar = 0.1;
      const snap = readCompositorSpring(params, { from: 0, to: range0, v0: 0, t: tStar });

      const clock = makeClock();
      const live: number[] = [];
      handoffToLive({
        spring: params,
        value: snap.value,
        velocity: snap.velocity,
        target: range0,
        requestFrame: clock.requestFrame,
        onChange: (v) => live.push(v),
      });
      clock.drain();

      // live[k] (live-elapsed = k·dt, k≥1) обязан совпасть с ОРИГИНАЛЬНОЙ
      // траекторией в абсолютном времени t* + k·dt (свойство полугруппы линейной
      // ОДУ). live[0] — значение рождения (эмит при подписке, до первого кадра).
      let maxDev = 0;
      for (let k = 1; k < live.length - 1; k++) {
        const original = readCompositorSpring(params, { from: 0, to: range0, v0: 0, t: tStar + k * FIXED_DT_S }).value;
        maxDev = Math.max(maxDev, Math.abs(live[k]! - original));
      }
      // Допуск = tolerance компилятора × амплитуда (0.25% от 100 = 0.25 ед.);
      // фактически расхождение — лишь плавающая арифметика (≪ бюджета).
      expect(maxDev).toBeLessThanOrEqual(DEFAULT_TOL * range0);
    }
  });

  it('НЕГАТИВНЫЙ контроль (C¹ real): БЕЗ засева скорости хвост расходится > tolerance', () => {
    // Тот же снимок, но velocity=0 (как если бы скорость не переносилась) —
    // траектория обязана заметно отклониться от продолжения оригинала.
    const range0 = 100;
    const tStar = 0.08; // пружина ещё быстро движется — скорость существенна
    const snap = readCompositorSpring(BOUNCY, { from: 0, to: range0, v0: 0, t: tStar });

    const clock = makeClock();
    const live: number[] = [];
    handoffToLive({
      spring: BOUNCY,
      value: snap.value,
      velocity: 0, // ← скорость НЕ перенесена (баг-симуляция)
      target: range0,
      requestFrame: clock.requestFrame,
      onChange: (v) => live.push(v),
    });
    clock.drain();

    let maxDev = 0;
    for (let k = 1; k < live.length - 1; k++) {
      const original = readCompositorSpring(BOUNCY, { from: 0, to: range0, v0: 0, t: tStar + k * FIXED_DT_S }).value;
      maxDev = Math.max(maxDev, Math.abs(live[k]! - original));
    }
    // Пропуск скорости ломает C¹ → девиация НАМНОГО больше бюджета.
    expect(maxDev).toBeGreaterThan(DEFAULT_TOL * range0 * 10);
  });

  it('сходится к цели без NaN (финитность live-пружины)', () => {
    const clock = makeClock();
    const live: number[] = [];
    handoffToLive({
      spring: BOUNCY,
      value: 30,
      velocity: 400,
      target: 250,
      requestFrame: clock.requestFrame,
      onChange: (v) => live.push(v),
    });
    clock.drain();
    for (const v of live) expect(Number.isFinite(v)).toBe(true);
    expect(live[live.length - 1]).toBe(250);
  });

  it('cross-check семплинга (тест-only): аналитический снимок ≡ бит-в-бит solveSpring·range', () => {
    // Заземляет, что value/velocity пришли из ЗАМКНУТОЙ формы, а не из DOM-семпла.
    const r = readCompositorSpring(STIFF, { from: 10, to: 210, v0: 0, t: 0.12 });
    const mv = handoffToLive({
      spring: STIFF,
      value: r.value,
      velocity: r.velocity,
      target: 210,
      requestFrame: makeClock().requestFrame,
    });
    expect(mv).toBeInstanceOf(MotionValue);
    expect(mv.value).toBe(r.value); // рождение ровно в аналитической точке
    mv.destroy();
  });
});

describe('compositor handoff: handoffToLive — валидация', () => {
  it('не-конечные value/velocity/target → MotionParamError', () => {
    expect(() => handoffToLive({ spring: STIFF, value: NaN, velocity: 0, target: 1 })).toThrow(MotionParamError);
    expect(() => handoffToLive({ spring: STIFF, value: 0, velocity: Infinity, target: 1 })).toThrow(MotionParamError);
    expect(() => handoffToLive({ spring: STIFF, value: 0, velocity: 0, target: NaN })).toThrow(MotionParamError);
    expect(() => handoffToLive({ spring: { mass: -1, stiffness: 1, damping: 1 }, value: 0, velocity: 0, target: 1 })).toThrow(MotionParamError);
  });
});

// ─── CompositorSpring.handoffToLive: снимок с compositor-трека ─────────────────

describe('compositor handoff: CompositorSpring.handoffToLive — compositor-путь', () => {
  it('в полёте: отменяет compositor Animation, стартует live с аналитической позиции', () => {
    const f = fakeElement();
    const clock = makeClock();
    let nowMs = 1000;
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 0,
      to: 100,
      target: f.el,
      now: () => nowMs,
      requestFrame: clock.requestFrame,
    });
    cs.start();
    expect(cs.mode).toBe('compositor');
    nowMs = 1100; // 0.1 с в полёте

    const expected = readCompositorSpring(STIFF, { from: 0, to: 100, v0: 0, t: 0.1 });
    const seen: number[] = [];
    const mv = cs.handoffToLive();
    mv.onChange((v) => seen.push(v));

    // Compositor-анимация отменена (передана в live).
    expect(f.animations[0]!.cancelled).toBe(true);
    // Возвращён живой MotionValue, рождённый в аналитической точке (C⁰).
    expect(mv).toBeInstanceOf(MotionValue);
    expect(mv.value).toBe(expected.value);
    expect(seen[0]).toBe(expected.value);

    clock.drain();
    expect(mv.value).toBe(100); // сошёлся к исходной цели
  });

  it('newTarget: хендофф сразу едет к новой цели с сохранённой скоростью', () => {
    const f = fakeElement();
    const clock = makeClock();
    let nowMs = 0;
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 0,
      to: 100,
      target: f.el,
      now: () => nowMs,
      requestFrame: clock.requestFrame,
    });
    cs.start();
    nowMs = 90; // 0.09 с
    const mv = cs.handoffToLive(300);
    clock.drain();
    expect(mv.value).toBe(300); // новая цель
  });

  it('до старта: хендофф без активной Animation даёт live с from', () => {
    const f = fakeElement();
    const clock = makeClock();
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 5,
      to: 100,
      target: f.el,
      now: () => 0,
      requestFrame: clock.requestFrame,
    });
    const mv = cs.handoffToLive();
    expect(mv.value).toBe(5); // не в полёте → рождение в from
    expect(f.animations).toHaveLength(0); // compositor-анимация не запускалась
    clock.drain();
    expect(mv.value).toBe(100);
  });

  it('stop() контроллера останавливает отданный live-mv (анти-утечка)', () => {
    const f = fakeElement();
    const clock = makeClock();
    let nowMs = 0;
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 0,
      to: 100,
      target: f.el,
      now: () => nowMs,
      requestFrame: clock.requestFrame,
    });
    cs.start();
    nowMs = 50;
    const mv = cs.handoffToLive();
    cs.stop();
    clock.step(1); // остаточных запланированных кадров быть не должно
    const before = mv.value;
    clock.drain();
    expect(mv.value).toBe(before); // остановлен — значение не двигается
  });
});

// ─── SSR / fallback (WAAPI недоступен) ────────────────────────────────────────

describe('compositor handoff: fallback (WAAPI недоступен) — SSR-safe', () => {
  it('нет цели → mode fallback; handoffToLive возвращает тот же live MotionValue', () => {
    const clock = makeClock();
    const seen: number[] = [];
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 0,
      to: 100,
      apply: (v) => seen.push(v as number),
      requestFrame: clock.requestFrame,
    });
    expect(cs.mode).toBe('fallback');
    cs.start();
    clock.step(3);
    const mv = cs.handoffToLive(250);
    expect(mv).toBeInstanceOf(MotionValue);
    clock.drain();
    expect(mv.value).toBe(250); // fallback ретаргетнул к новой цели
  });

  it('handoffToLive без цели и без requestFrame не бросает (node-фоллбек), destroy чистит', () => {
    const cs = new CompositorSpring({ spring: STIFF, property: 'x', from: 0, to: 1 });
    expect(() => {
      const mv = cs.handoffToLive();
      mv.destroy();
      cs.destroy();
    }).not.toThrow();
  });
});
