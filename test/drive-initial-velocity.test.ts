/**
 * Test: drive() — opt-in `initialVelocity` (v0 солвера, units value/s)
 * Class: A (contract/bite) + B (characterization) + C (property/fuzz)
 * Issue: #93 «единый C¹-контракт value+velocity», срез 1, контракт B.
 *
 * Зачем: до этого среза drive() жёстко стартовал из покоя (v0=0 через
 * springUnchecked) — донор скорости (жест/decay/прерванный полёт) не мог
 * передать пружине свою первую производную, стык был C⁰, но не C¹ (видимый
 * рывок скорости). Опция проводит v0 до канонического
 * solveSpring(params, t, v0) из internal/solver.ts (тот же канон, что
 * projection/driver и smooth pickup MotionValue).
 *
 * Контракт:
 *   (1) default (опция опущена / 0) — рождение из покоя, БИТ-В-БИТ прежняя
 *       траектория (characterization);
 *   (2) initialVelocity=V → первая производная эмитируемой траектории ≈ V,
 *       а вся траектория (clamp:false) бит-в-бит равна аналитическому оракулу
 *       from + solveSpring(spring, t, V/range).value * range;
 *   (3) NaN/±Infinity → MotionParamError РАНО: синхронно, до Promise, до
 *       единого вызова requestFrame, даже на вырожденном from===to;
 *   (4) конечные входы → только конечные эмиссии, финальный settle ровно `to`;
 *   (5) retarget-семантики у drive НЕТ и не появилось: one-shot прогон,
 *       from===to — мгновенный resolve без onStep (v0 не оживляет его).
 *
 * RED PROOF (вневременно — почему эти тесты были красными до реализации):
 *   DriveOptions не имел поля initialVelocity, drive() звал
 *   springUnchecked(spring, t) с жёстким v0=0 → секанс первого кадра ≈ 0
 *   (не V), оракул solveSpring(t, V/range) расходился с эмиссиями со второго
 *   кадра, NaN в initialVelocity молча игнорировался (toThrow падал). RED по
 *   правильной причине: отсутствие контракта, не поломка солвера.
 *
 * Mutation proofs (тест обязан падать на своей мутации):
 *   [bite]     Захардкодить v0Normalized=0 → секанс ≈ 83 вместо ≈ 2000 →
 *              нижняя граница 0.5·V падает; оракул-сверка падает со 2-го кадра.
 *   [validate] Убрать Number.isFinite(v0)-гард → toThrow(MotionParamError)
 *              падает; NaN гонит цикл до MAX_FRAMES (класс дыры from/to).
 *   [norm]     Нормировать как v0*range вместо v0/range → оракул падает.
 *   [guard]    Убрать страж Number.isFinite(cv) → фазз ловит non-finite
 *              эмиссию на экстремальных величинах.
 *   [parity]   Подменить default на v0=1 → бит-паритет omitted ≡ 0 падает.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError, drive } from '../src/index.js';
import { solveSpring } from '../src/internal/solver.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const STD_SPRING = { mass: 1, stiffness: 200, damping: 20 } as const;

/**
 * Step-clock (канон drive-unclamped-overshoot.test.ts) + журнал ts: ненулевой
 * handle (rAF-путь, без setTimeout-fallback), кадры дренируются вручную,
 * каждый timestamp пишется в `stamps` — оракул воспроизводит elapsed бит-в-бит
 * той же арифметикой, что tick(): (ts − startTs) / 1000.
 */
function makeStepClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  const stamps: number[] = [];
  let ts = 0;
  let handle = 0;
  return {
    clock: (cb: (ts?: number) => void): number => {
      queue.push(cb);
      return ++handle;
    },
    drain: (n: number): void => {
      for (let i = 0; i < n && queue.length > 0; i++) {
        ts += dtMs;
        stamps.push(ts);
        const cb = queue.shift();
        if (cb) cb(ts);
      }
    },
    drainUntilIdle: (maxFrames: number): void => {
      for (let i = 0; i < maxFrames && queue.length > 0; i++) {
        ts += dtMs;
        stamps.push(ts);
        const cb = queue.shift();
        if (cb) cb(ts);
      }
    },
    stamps,
    queueLength: () => queue.length,
  };
}

// ─── Suite B: characterization — default стартует из покоя ──────────────────

describe('drive initialVelocity — characterization default v0=0 (class B)', () => {
  it('опция опущена ≡ initialVelocity:0 — бит-в-бит одинаковые эмиссии', async () => {
    const run = async (withOption: boolean): Promise<number[]> => {
      const { clock, drainUntilIdle } = makeStepClock();
      const emitted: number[] = [];
      const done = drive({
        from: 0,
        to: 100,
        spring: STD_SPRING,
        onStep: (v) => emitted.push(v),
        requestFrame: clock,
        ...(withOption ? { initialVelocity: 0 } : {}),
      });
      drainUntilIdle(2500);
      await done;
      return emitted;
    };
    const a = await run(false);
    const b = await run(true);
    expect(a.length).toBeGreaterThan(2);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('default — рождение из покоя: траектория бит-в-бит равна оракулу v0=0 (clamp:false)', async () => {
    const { clock, drainUntilIdle, stamps } = makeStepClock();
    const from = 0;
    const to = 100;
    const range = to - from;
    const emitted: number[] = [];
    const done = drive({
      from,
      to,
      spring: STD_SPRING,
      clamp: false,
      onStep: (v) => emitted.push(v),
      requestFrame: clock,
    });
    drainUntilIdle(2500);
    await done;

    // Все кадры до финального settle — точный аналитический оракул из покоя.
    for (let k = 0; k < emitted.length - 1; k++) {
      const elapsed = (stamps[k] - stamps[0]) / 1000;
      expect(emitted[k]).toBe(from + solveSpring(STD_SPRING, elapsed, 0).value * range);
    }
    expect(emitted[emitted.length - 1]).toBe(to);
  });
});

// ─── Suite A: bite-тесты нового контракта ────────────────────────────────────

describe('drive initialVelocity — C¹-контракт (class A bite)', () => {
  it('первая производная эмитируемой траектории ≈ V (bite: отделяет v0=V от v0=0)', () => {
    const dtMs = 1000 / 120;
    const { clock, drain, stamps } = makeStepClock(dtMs);
    const V = 2000; // units/s; из покоя секанс первого кадра был бы ≈ 83 units/s
    const emitted: number[] = [];
    void drive({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      clamp: false,
      initialVelocity: V,
      onStep: (v) => emitted.push(v),
      requestFrame: clock,
    });
    drain(2); // кадр 1: elapsed=0 → from; кадр 2: elapsed=dt

    const dtS = (stamps[1] - stamps[0]) / 1000;
    const secant = (emitted[1] - emitted[0]) / dtS;
    // Средняя скорость на [0, dt] ≈ V (демпфирование за 8.3мс мало́): ±15%.
    expect(Math.abs(secant - V)).toBeLessThan(0.15 * V);
    // Нижняя граница строго отделяет от старта из покоя (~83 units/s « 0.5·V).
    expect(secant).toBeGreaterThan(0.5 * V);
  });

  it('вся траектория бит-в-бит равна оракулу solveSpring(t, V/range) (clamp:false)', async () => {
    const { clock, drainUntilIdle, stamps } = makeStepClock();
    const from = 10;
    const to = 110;
    const range = to - from;
    const V = 700;
    const v0n = V / range; // та же нормировка, что в drive()
    const emitted: number[] = [];
    const done = drive({
      from,
      to,
      spring: STD_SPRING,
      clamp: false,
      initialVelocity: V,
      onStep: (v) => emitted.push(v),
      requestFrame: clock,
    });
    drainUntilIdle(2500);
    await done;

    expect(emitted.length).toBeGreaterThan(3);
    for (let k = 0; k < emitted.length - 1; k++) {
      const elapsed = (stamps[k] - stamps[0]) / 1000;
      expect(emitted[k]).toBe(from + solveSpring(STD_SPRING, elapsed, v0n).value * range);
    }
    // Финальный settle — ровно to (семантика settle не изменена).
    expect(emitted[emitted.length - 1]).toBe(to);
  });

  it('отрицательный V (от цели): честный провал ниже from (clamp:false), settle ровно в to', async () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const done = drive({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      clamp: false,
      initialVelocity: -800,
      onStep: (v) => emitted.push(v),
      requestFrame: clock,
    });
    drainUntilIdle(2500);
    await done;

    expect(Math.min(...emitted)).toBeLessThan(0); // траектория честно ушла ниже from
    for (const v of emitted) expect(Number.isFinite(v)).toBe(true);
    expect(emitted[emitted.length - 1]).toBe(100);
  });

  it('default clamp остаётся CSS-safe при огромном V: эмиссии в [from,to], монотонны к to', async () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const done = drive({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      initialVelocity: 1e5,
      onStep: (v) => emitted.push(v),
      requestFrame: clock,
    });
    drainUntilIdle(2500);
    await done;

    for (let i = 0; i < emitted.length; i++) {
      expect(emitted[i]).toBeGreaterThanOrEqual(0);
      expect(emitted[i]).toBeLessThanOrEqual(100);
      if (i > 0) expect(emitted[i]).toBeGreaterThanOrEqual(emitted[i - 1]); // монотонный эмиттер жив
    }
    expect(emitted[emitted.length - 1]).toBe(100);
  });

  it('from===to остаётся мгновенным resolve без onStep — v0 не оживляет вырожденный прогон', async () => {
    let steps = 0;
    let frames = 0;
    await drive({
      from: 5,
      to: 5,
      spring: STD_SPRING,
      initialVelocity: 900,
      onStep: () => steps++,
      requestFrame: () => {
        frames++;
        return 1;
      },
    });
    expect(steps).toBe(0);
    expect(frames).toBe(0);
  });

  it('оседание точно в to на матрице направлений/величин/таймскейлов', async () => {
    for (const V of [1, -1, 5000, -5000]) {
      for (const dtMs of [1000 / 60, 1000 / 120]) {
        for (const clampMode of [true, false]) {
          const { clock, drainUntilIdle } = makeStepClock(dtMs);
          const emitted: number[] = [];
          const done = drive({
            from: 100,
            to: -50,
            spring: STD_SPRING,
            clamp: clampMode,
            initialVelocity: V,
            onStep: (v) => emitted.push(v),
            requestFrame: clock,
          });
          drainUntilIdle(2500);
          await done;
          expect(
            emitted[emitted.length - 1],
            `V=${V} dt=${dtMs.toFixed(2)} clamp=${clampMode}`,
          ).toBe(-50);
          for (const v of emitted) expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  }, 30_000);
});

// ─── Suite A: ранняя валидация ───────────────────────────────────────────────

describe('drive initialVelocity — non-finite → MotionParamError рано (class A)', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'бросает MotionParamError синхронно и НЕ трогает requestFrame (v0=%s)',
    (bad) => {
      let frames = 0;
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: STD_SPRING,
          initialVelocity: bad,
          onStep: () => {},
          requestFrame: () => {
            frames++;
            return 1;
          },
        }),
      ).toThrow(MotionParamError);
      expect(frames).toBe(0); // до Promise и до единого кадра
    },
  );

  it('бросает даже на вырожденном from===to (валидация раньше fast-path)', () => {
    expect(() =>
      drive({
        from: 5,
        to: 5,
        spring: STD_SPRING,
        initialVelocity: Number.NaN,
        onStep: () => {},
      }),
    ).toThrow(MotionParamError);
  });

  it('ошибка имеет код LM025 и сохраняет классы MotionParamError/Error', () => {
    let caught: unknown;
    try {
      drive({
        from: 0,
        to: 100,
        spring: STD_SPRING,
        initialVelocity: Number.NaN,
        onStep: () => {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('LM025');
  });
});

// ─── Suite C: property/fuzz — домовой канон (seeded LCG, ≥3000) ──────────────

describe('drive initialVelocity — property/fuzz (class C, seeded LCG ≥3000)', () => {
  it('non-finite → MotionParamError; конечные любых величин/знаков → только конечные эмиссии, settle в to', () => {
    let seed = 0xfeedbead;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0xffffffff;
    };

    const springVariants = [
      { mass: 1, stiffness: 200, damping: 20 }, // underdamped
      { mass: 1, stiffness: 100, damping: 20 }, // критический
      { mass: 1, stiffness: 50, damping: 30 }, // overdamped
      { mass: 0.5, stiffness: 1000, damping: 40 }, // жёсткий
    ];
    const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    let thrown = 0;
    let finiteRuns = 0;
    let emissionsChecked = 0;

    for (let i = 0; i < 3000; i++) {
      const springP = springVariants[i % springVariants.length];
      const from = (rng() - 0.5) * 2000;
      const to = (rng() - 0.5) * 2000;

      if (i % 10 === 0) {
        // Злые входы: NaN/±Infinity обязаны падать MotionParamError ДО кадров.
        const bad = nonFinite[(i / 10) % 3];
        expect(() =>
          drive({
            from,
            to,
            spring: springP,
            initialVelocity: bad,
            onStep: () => {},
            requestFrame: () => 1,
          }),
        ).toThrow(MotionParamError);
        thrown++;
        continue;
      }

      // Конечные v0: величины 1e-3..1e6 обоих знаков (направления × масштабы).
      const v0 = (rng() < 0.5 ? -1 : 1) * 10 ** (rng() * 9 - 3);
      const { clock, drainUntilIdle, queueLength } = makeStepClock();
      const emitted: number[] = [];
      void drive({
        from,
        to,
        spring: springP,
        clamp: rng() < 0.5,
        initialVelocity: v0,
        onStep: (v) => emitted.push(v),
        requestFrame: clock,
      });
      drainUntilIdle(160);

      for (const v of emitted) {
        if (!Number.isFinite(v)) {
          throw new Error(
            `non-finite эмиссия: ${v} (from=${from}, to=${to}, v0=${v0}, spring=${JSON.stringify(springP)})`,
          );
        }
        emissionsChecked++;
      }
      // Прогон, дошедший до settle (очередь пуста), обязан завершиться ровно в to.
      if (queueLength() === 0 && emitted.length > 0) {
        expect(emitted[emitted.length - 1]).toBe(to);
      }
      finiteRuns++;
    }

    expect(thrown + finiteRuns).toBeGreaterThanOrEqual(3000);
    expect(thrown).toBeGreaterThanOrEqual(300);
    expect(emissionsChecked).toBeGreaterThan(10_000);
  }, 120_000);
});
