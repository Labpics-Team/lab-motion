/**
 * test/driver-velocity-read.test.ts — ./driver: аналитическое чтение скорости
 * live-рана (геттер `AnimationControls.velocity`, #93 срез 3, контракт C3b).
 *
 * Классы: Б (пин поверхности + покой), А (direct oracle против солвера),
 * В (seeded property/fuzz), вертикаль (handoff driver → MotionValue).
 *
 * Зачем: пункт issue «live-run допускает аналитическое чтение (value, velocity)
 * в произвольный момент». MotionValue закрыл его геттерами value/velocity
 * (срез 1); у scrub-хендла createDriver уже были time/progress (аналитическое
 * чтение позиции — computeProgress на замкнутой форме, без DOM), но скорости
 * не было: приёмник хендоффа не мог унаследовать пару (value, velocity) от
 * скраб-рана. Симметричный шов: `get velocity()` (units/s) — по образцу
 * `MotionValue.velocity`, БЕЗ новой поверхности состояния (progress уже есть).
 *
 * Контракт:
 *   (1) `velocity` — read-only геттер, число, units/s (единицы значения);
 *   (2) в покое ровно 0: до старта (t=0), после сходимости/complete/cancel,
 *       вырожденный from===to;
 *   (3) в полёте — АНАЛИТИЧЕСКАЯ скорость траектории: бит-в-бит
 *       springUnchecked(spring, t).velocity * range — hidden-state пружины,
 *       НЕ производная клампованного выхода (канон MotionValue.velocity:
 *       именно её наследует приёмник, clamp-режим не влияет);
 *   (4) всегда конечна.
 *
 * ── RED PROOF (вневременно) ──────────────────────────────────────────────────
 * src/driver.ts не имел `velocity` в AnimationControls: `c.velocity` —
 * undefined → пин `typeof === 'number'` красный, оракулы сравнивают число с
 * undefined, вертикаль сеет undefined в initialVelocity → MotionParamError.
 * RED по правильной причине: отсутствие контракта.
 *
 * ── MUTATION PROOF (тест обязан падать на своей мутации) ─────────────────────
 *   [oracle]    Вернуть progress/время/0 вместо скорости → бит-в-бит сверка
 *               с springUnchecked(...).velocity * range красная.
 *   [units]     Не умножать на range → оракул units/s красный (нормированная
 *               скорость ≠ units/s при range=200).
 *   [clamp-mix] Считать скорость от клампованного выхода (0 в насыщении) →
 *               оракул «overshoot-фаза: скорость отрицательна и аналитична
 *               при clamp:true» красный.
 *   [rest-zero] Убрать ветку покоя (settled → 0) → «после complete/cancel
 *               ровно 0» красный.
 *   [set-leak]  Добавить сеттер velocity → дескриптор-пин «set undefined»
 *               красный.
 */

import { describe, expect, it } from 'vitest';
import { createDriver, type DriverOptions } from '../src/driver.js';
import { MotionValue } from '../src/index.js';
import { springUnchecked } from '../src/spring.js';

/** Underdamped (ζ≈0.35): overshoot реален — различает clamp-политики. */
const UNDER: DriverOptions['spring'] = { mass: 1, stiffness: 200, damping: 10 };
/** Критическое демпфирование (канон driver-тестов). */
const CRIT: DriverOptions['spring'] = { mass: 1, stiffness: 100, damping: 20 };

/** Хендл без единого кадра: requestFrame копит колбэки, время двигает seek. */
function makeFrozen(over: Partial<DriverOptions> = {}) {
  const steps: number[] = [];
  const c = createDriver({
    from: 0,
    to: 200,
    spring: UNDER,
    onStep: (v) => steps.push(v),
    requestFrame: () => 1, // handle ≠ 0: без setTimeout-fallback, кадры не идут
    ...over,
  });
  return { c, steps };
}

// ─── Класс Б: пин поверхности ────────────────────────────────────────────────

describe('driver.velocity — пин публичной поверхности (Класс Б)', () => {
  it('velocity — число на хендле', () => {
    const { c } = makeFrozen();
    expect(typeof c.velocity).toBe('number');
    c.cancel();
  });

  it('read-only: на хендле объявлен getter без сеттера, присваивание бросает TypeError', () => {
    const { c } = makeFrozen();
    const desc = Object.getOwnPropertyDescriptor(c, 'velocity');
    expect(typeof desc?.get).toBe('function');
    expect(desc?.set).toBeUndefined();
    expect(() => {
      (c as unknown as { velocity: number }).velocity = 42;
    }).toThrow(TypeError);
    c.cancel();
  });
});

// ─── Класс Б: покой — ровно 0 ────────────────────────────────────────────────

describe('driver.velocity — в покое ровно 0 (Класс Б characterization)', () => {
  it('до старта (t=0) — 0', () => {
    const { c } = makeFrozen();
    expect(c.velocity).toBe(0);
    c.cancel();
  });

  it('после complete() — 0', () => {
    const { c } = makeFrozen();
    c.seek(0.1); // в полёте
    expect(c.velocity).not.toBe(0);
    c.complete();
    expect(c.velocity).toBe(0);
  });

  it('после cancel() в полёте — 0 (ран заморожен = покой)', () => {
    const { c } = makeFrozen();
    c.seek(0.1);
    c.cancel();
    expect(c.velocity).toBe(0);
  });

  it('после естественной сходимости — 0', async () => {
    const steps: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: CRIT,
      onStep: (v) => steps.push(v),
      requestFrame: () => 0, // non-draining конвенция: setTimeout-fallback гонит кадры
    });
    await c;
    expect(steps.at(-1)).toBe(100);
    expect(c.velocity).toBe(0);
  });

  it('вырожденный from === to — 0 (мгновенный settle)', () => {
    const { c } = makeFrozen({ from: 5, to: 5 });
    expect(c.velocity).toBe(0);
  });
});

// ─── Класс А: в полёте — бит-в-бит аналитический оракул ─────────────────────

describe('driver.velocity — аналитическая скорость траектории (Класс А)', () => {
  it('seek(t): бит-в-бит springUnchecked(spring, t).velocity * range (units/s)', () => {
    const from = 0;
    const to = 200;
    const { c } = makeFrozen({ from, to });
    for (const t of [0.02, 0.05, 0.1, 0.17, 0.25]) {
      c.seek(t);
      const expected = springUnchecked(UNDER, t).velocity * (to - from);
      expect(c.velocity).toBe(expected); // та же формула, тот же порядок операций
      expect(c.velocity).not.toBe(0);
      expect(Number.isFinite(c.velocity)).toBe(true);
    }
    c.cancel();
  });

  it('overshoot-фаза underdamped при clamp:true: скорость отрицательна и аналитична (hidden-state)', () => {
    // t=0.3: позиция за целью (клампованный ВЫХОД насыщен на to), но
    // аналитическая скорость пружины отрицательна — именно её читает геттер.
    const { c } = makeFrozen(); // clamp по умолчанию true
    c.seek(0.3);
    const expected = springUnchecked(UNDER, 0.3).velocity * 200;
    expect(expected).toBeLessThan(0);
    expect(c.velocity).toBe(expected);
    c.cancel();
  });

  it('clamp:false и clamp:true читают ОДНУ аналитическую скорость (политика MotionValue)', () => {
    const a = makeFrozen({ clamp: true });
    const b = makeFrozen({ clamp: false });
    for (const t of [0.08, 0.15, 0.3]) {
      a.c.seek(t);
      b.c.seek(t);
      expect(a.c.velocity).toBe(b.c.velocity);
    }
    a.c.cancel();
    b.c.cancel();
  });

  it('обратный range (from > to): знак скорости соответствует units/s значения', () => {
    const { c } = makeFrozen({ from: 100, to: 0 });
    c.seek(0.05);
    const expected = springUnchecked(UNDER, 0.05).velocity * (0 - 100);
    expect(expected).toBeLessThan(0); // движение вниз по значению
    expect(c.velocity).toBe(expected);
    c.cancel();
  });
});

// ─── Вертикаль: handoff driver → MotionValue (потребительская цель C¹) ───────

describe('driver.velocity — вертикаль хендоффа (Класс А, integration)', () => {
  it('пара (эмит value, velocity) сеет MotionValue: скорость рождения бит-в-бит', () => {
    const { c, steps } = makeFrozen({ from: 0, to: 200 });
    c.seek(0.1); // onStep эмитит value при t=0.1 (C⁰-часть пары)
    const value = steps.at(-1)!;
    const velocity = c.velocity;
    expect(Math.abs(velocity)).toBeGreaterThan(0);
    c.cancel();

    const mv = new MotionValue({
      initial: value,
      spring: UNDER,
      initialVelocity: velocity,
      requestFrame: () => 1,
    });
    expect(mv.value).toBe(value);
    expect(mv.velocity).toBe(velocity); // C¹: приёмник унаследовал пару точно
    mv.destroy();
  });
});

// ─── Класс В: seeded property/fuzz — финитность ──────────────────────────────

describe('driver.velocity — финитность (Класс В, seeded fuzz)', () => {
  it('1500 прогонов: velocity конечна при произвольных from/to/spring/seek; после cancel — 0', () => {
    // Домовой канон: seeded LCG — детерминированный фазз.
    let seed = 0xd21ee7 >>> 0;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const springs = [
      UNDER,
      CRIT,
      { mass: 1, stiffness: 50, damping: 30 }, // overdamped
      { mass: 0.5, stiffness: 1000, damping: 40 }, // жёсткий
    ];
    for (let i = 0; i < 1500; i++) {
      const from = (rng() - 0.5) * 2000;
      const to = (rng() - 0.5) * 2000;
      const { c } = makeFrozen({ from, to, spring: springs[i % springs.length] });
      const seeks = 1 + Math.floor(rng() * 4);
      for (let s = 0; s < seeks; s++) {
        c.seek(rng() * 3);
        if (!Number.isFinite(c.velocity)) {
          throw new Error(`non-finite velocity: from=${from} to=${to} i=${i}`);
        }
      }
      c.cancel();
      expect(c.velocity).toBe(0);
    }
  }, 30_000);

  it('сошедшийся-но-не-settled ран при range<0 отдаёт ровно 0, не −0', () => {
    // Adversarial-находка ревью PR #124: при t далеко за сходимостью экспоненты
    // солвера underflow-ятся в точный 0, seek НЕ выставляет settled, и
    // 0 * range при range<0 давал −0 наружу — нарушение инварианта
    // «вырожденное → ровно 0» (домовой канон `finite(...)+0`).
    // RED-факт до фикса: Object.is(c.velocity, -0) === true.
    const { c } = makeFrozen({ from: 100, to: 0, spring: CRIT });
    c.seek(80); // ζω=10 → e^{-10·80} underflow → solver velocity === 0
    expect(Object.is(c.velocity, 0)).toBe(true);
    expect(Object.is(c.velocity, -0)).toBe(false);
    c.cancel();
  });
});
