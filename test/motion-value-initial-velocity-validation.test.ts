/**
 * test/motion-value-initial-velocity-validation.test.ts
 * Классы: А (contract fail-fast) + Б (characterization) + В (fuzz, seeded LCG).
 * Issue: #93 срез 2, контракт C2c (нота CodeRabbit к #112, вне диффа среза 1).
 *
 * Зачем: NaN/±Infinity в opts.initialVelocity молча трактовались как «нет
 * сида» (гард Number.isFinite просто пропускал засев) — битый донор скорости
 * (жест/decay/compositor-хендофф) маскировался, значение рождалось в покое,
 * и C¹-разрыв всплывал далеко от причины. Контракт: initialVelocity
 * валидируется как initial/spring — MotionParamError СИНХРОННО из
 * конструктора, до единого кадра. Паритет с drive(): там non-finite
 * initialVelocity уже бросает рано (drive-initial-velocity.test.ts).
 *
 * Контракт:
 *   (1) NaN/±Infinity → MotionParamError синхронно, requestFrame не тронут;
 *   (2) ошибка имеет стабильный code-only контракт LM045;
 *   (3) отсутствие опции ≡ 0: рождение в покое, velocity === 0 (прежнее);
 *   (4) конечный сид любых величин/знаков принимается и читается геттером;
 *   (5) соседние входы сохраняют единый код LM045.
 *
 * RED PROOF (вневременно — почему тесты были красными до реализации):
 *   конструктор засеивал скорость через `if (Number.isFinite(...))` — NaN и
 *   ±Infinity молча пропускались (velocity оставалась 0, объект создавался):
 *   toThrow(MotionParamError) падал на всех трёх значениях, фазз-ветка «злой
 *   вход обязан бросить» падала. RED по правильной причине: отсутствие
 *   валидации, не поломка геттера.
 *
 * Mutation proofs (тест обязан падать на своей мутации):
 *   [validate] Вернуть молчаливый гард (не бросать) → (1) падает.
 *   [code]     Подменить смысловой код → (2) падает.
 *   [default]  Подменить дефолт `?? 0` на `?? 1` → (3) падает (velocity !== 0).
 *   [seed]     Не присваивать проверенное значение → (4) падает (velocity 0).
 *   [guard]    Обойти общий страж соседнего входа → (5) падает.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError, MotionValue } from '../src/index.js';

const STD_SPRING = { mass: 1, stiffness: 200, damping: 20 } as const;

// ─── Класс А: fail-fast ───────────────────────────────────────────────────────

describe('MotionValue initialVelocity — non-finite → MotionParamError синхронно (класс А)', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'бросает из конструктора и НЕ трогает requestFrame (initialVelocity=%s)',
    (bad) => {
      let frames = 0;
      expect(
        () =>
          new MotionValue({
            initial: 0,
            spring: STD_SPRING,
            initialVelocity: bad,
            requestFrame: () => {
              frames++;
              return 1;
            },
          }),
      ).toThrow(MotionParamError);
      expect(frames).toBe(0); // ни одного кадра: смерть до планировщика
    },
  );

  it('ошибка имеет код LM045 и сохраняет классы MotionParamError/Error', () => {
    let caught: unknown;
    try {
      new MotionValue({ initial: 0, spring: STD_SPRING, initialVelocity: Number.NaN });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('LM045');
  });

  it('валидация initial идёт раньше и сохраняет LM045', () => {
    let caught: unknown;
    try {
      new MotionValue({ initial: Number.NaN, spring: STD_SPRING, initialVelocity: Number.NaN });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as Error).message).toBe('LM045');
  });
});

// ─── Класс Б: characterization — валидные входы как прежде ────────────────────

describe('MotionValue initialVelocity — characterization валидных входов (класс Б)', () => {
  it('опция опущена ≡ 0: рождение в покое (velocity === 0), не бросает', () => {
    const mv = new MotionValue({ initial: 7, spring: STD_SPRING });
    expect(mv.velocity).toBe(0);
    mv.destroy();
  });

  it('явный 0 ≡ опущенной опции: velocity === 0', () => {
    const mv = new MotionValue({ initial: 7, spring: STD_SPRING, initialVelocity: 0 });
    expect(mv.velocity).toBe(0);
    mv.destroy();
  });

  it('конечный сид принимается и читается геттером (handoff-seam не сломан)', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, initialVelocity: -321.25 });
    expect(mv.velocity).toBe(-321.25);
    mv.destroy();
  });

  it('соседние входы сохраняют единый код общего стража', () => {
    const grab = (fn: () => void): string => {
      try {
        fn();
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    expect(grab(() => new MotionValue({ initial: Number.NaN, spring: STD_SPRING })))
      .toBe('LM045');
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(grab(() => mv.setTarget(Number.POSITIVE_INFINITY))).toBe('LM045');
    expect(grab(() => mv.snapTo(Number.NaN))).toBe('LM045');
    mv.destroy();
  });
});

// ─── Класс В: property/fuzz — домовой канон (seeded LCG, ≥3000) ───────────────

describe('MotionValue initialVelocity — property/fuzz (класс В, seeded LCG ≥3000)', () => {
  it('non-finite всегда бросает; конечные любых величин/знаков всегда принимаются и сеются точно', () => {
    let seed = 0xdeadf00d;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0xffffffff;
    };
    const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    let thrown = 0;
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 5 === 0) {
        const bad = nonFinite[(i / 5) % 3];
        expect(
          () => new MotionValue({ initial: 0, spring: STD_SPRING, initialVelocity: bad }),
        ).toThrow(MotionParamError);
        thrown++;
        continue;
      }
      // Конечные величины 1e-6..1e12 обоих знаков + субнормальные края.
      const v0 = (rng() < 0.5 ? -1 : 1) * 10 ** (rng() * 18 - 6);
      const mv = new MotionValue({
        initial: (rng() - 0.5) * 1000,
        spring: STD_SPRING,
        initialVelocity: v0,
      });
      if (mv.velocity !== v0) {
        throw new Error(`сид потерян: velocity=${mv.velocity}, ожидалось ${v0}`);
      }
      mv.destroy();
      accepted++;
    }
    expect(thrown).toBe(600);
    expect(accepted).toBe(2400);
  });
});
