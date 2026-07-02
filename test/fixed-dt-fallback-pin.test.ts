/**
 * test/fixed-dt-fallback-pin.test.ts — пин ВЕЛИЧИНЫ fallback-шага (FIXED_DT_S).
 *
 * Класс (Б, нота QA #44): мутант FIXED_DT_S 1/60 → 1/6 выживал во всём сьюте —
 * детерминированные тест-часы всегда передают ts, fallback-ветка (ts=undefined,
 * non-draining клок handle=0) исполнялась только fuzz'ом на конечность.
 * Слой обязан пинить шаг по значению: оракул использует ЛИТЕРАЛ 1/60
 * (не импорт константы — self-consistent оракул не убил бы мутанта).
 *
 * RED-proof (диверсия): в src/internal/constants.ts FIXED_DT_S = 1/60 → 1/6 →
 * тест красный (траектория уезжает на 10× по времени за те же тики).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionValue } from '../src/index.js';
import { springUnchecked } from '../src/spring.js';

// Монотонная (сильно передемпфированная) пружина: без перелёта эмит MotionValue
// равен сырому солверу бит-в-бит — кламп/монотонизация перелёта нейтральны
// (underdamped-пружина здесь непригодна: её эмиты срезаются на пике).
const SPRING = { mass: 2, stiffness: 16, damping: 40 } as const;

describe('fallback-шаг setTimeout-пути запинен по значению (1/60 s)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('после k тиков без ts значение соответствует t = k/60 бит-в-бит', () => {
    // handle=0 → ядро переключается на setTimeout-фоллбек; колбэк приходит
    // без DOMHighResTimeStamp → dt каждого тика обязан быть ровно 1/60 c.
    const mv = new MotionValue({ initial: 0, spring: SPRING, requestFrame: () => 0 });
    mv.setTarget(1);

    const K = 30;
    for (let i = 0; i < K; i++) vi.advanceTimersToNextTimer();

    // Оракул: нормализованный солвер на t = K * (1/60) — литерал, не константа ядра.
    const oracle = springUnchecked(SPRING, K * (1 / 60)).value;
    expect(Object.is(mv.value, oracle), `mv=${mv.value} oracle=${oracle}`).toBe(true);
    // Санити: анимация реально в полёте (не снап и не покой) — медленная
    // пружина за 0.5 s проходит лишь часть пути.
    expect(mv.value).toBeGreaterThan(0.05);
    expect(mv.value).toBeLessThan(0.95);

    mv.destroy();
  });
});
