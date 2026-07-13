/**
 * Test: MotionValue — публичное чтение скорости (геттер `velocity`)
 * Class: A (contract) + B (characterization/pin) + C (property/fuzz)
 * Issue: #93 «единый C¹-контракт value+velocity», срез 1, контракт A.
 *
 * Зачем: до этого среза скорость жила ТОЛЬКО в приватном `_velocity` —
 * приёмник хендоффа (жест/decay/другая пружина) не мог прочитать пару
 * (value, velocity) и был вынужден стартовать из покоя (разрыв первой
 * производной на стыке). Канон дома: value читается геттером `get value()` —
 * скорость получает симметричный `get velocity()` (units/s), НЕ метод
 * getState(): одна каноничная форма, без дублирующих поверхностей.
 *
 * Контракт:
 *   (1) `velocity` — read-only геттер (get без set), число;
 *   (2) в покое — ровно 0 (рождение без initialVelocity, сходимость, snapTo);
 *   (3) в полёте — АНАЛИТИЧЕСКАЯ скорость траектории: бит-в-бит совпадает с
 *       solveSpring(spring, elapsed, v0Normalized).velocity * range;
 *   (4) всегда конечна (стражи _tick), на любых валидных входах.
 *
 * RED PROOF (вневременно — почему эти тесты были красными до реализации):
 *   src/motion-value.ts не имел публичного `velocity`: `mv.velocity` было
 *   `undefined` → пин `typeof === 'number'` падал, дескриптор-пин не находил
 *   getter на прототипе, oracle-сверки сравнивали число с undefined. RED по
 *   правильной причине: отсутствие контракта, не поломка солвера.
 *
 * Mutation proofs (тест обязан падать на своей мутации):
 *   [descriptor]  Добавить сеттер `set velocity(v)` → пин «set undefined» падает.
 *   [oracle]      Вернуть из геттера this._value (или 0) вместо this._velocity →
 *                 бит-в-бит сверка с solveSpring падает.
 *   [rest-zero]   Убрать `this._velocity = 0` в ветке сходимости/snapTo →
 *                 «в покое ровно 0» падает.
 *   [fuzz]        Убрать страж Number.isFinite(rawVelocity) в _tick →
 *                 финитность в фаззе падает.
 */

import { describe, expect, it } from 'vitest';
import { MotionValue, type MotionValueOptions } from '../src/index.js';
import { solveSpring } from '../src/internal/solver.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const STD_SPRING: MotionValueOptions['spring'] = { mass: 1, stiffness: 200, damping: 20 };

/**
 * Виртуальный step-clock (канон motion-value.test.ts) + журнал ts:
 * возвращает ненулевой handle (rAF-путь, без setTimeout-fallback), кадры
 * дренируются вручную, каждый выданный timestamp записывается в `stamps` —
 * оракул воспроизводит elapsed БИТ-В-БИТ той же арифметикой, что _tick:
 * (ts − startTs) / 1000.
 */
function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  const stamps: number[] = [];
  let clock = 0;
  let handle = 0;

  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return ++handle;
  };

  const drain = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      const cb = queue.shift();
      if (!cb) break;
      clock += dtMs;
      stamps.push(clock);
      cb(clock);
    }
  };

  const drainAll = (max = 3000): void => {
    let i = 0;
    while (queue.length > 0 && i++ < max) drain(1);
  };

  return { requestFrame, drain, drainAll, stamps, queueLength: () => queue.length };
}

// ─── Suite B: пин поверхности (в ОБЕ стороны) ────────────────────────────────

describe('MotionValue.velocity — пин публичной поверхности (class B)', () => {
  it('velocity — число, доступное на инстансе', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(typeof mv.velocity).toBe('number');
    mv.destroy();
  });

  it('прямая сторона: на прототипе объявлен getter; обратная: сеттера НЕТ (read-only)', () => {
    const desc = Object.getOwnPropertyDescriptor(MotionValue.prototype, 'velocity');
    expect(desc).toBeDefined();
    expect(typeof desc?.get).toBe('function');
    // Обратная сторона пина: скорость — производное состояние солвера, писать
    // её снаружи запрещено (мутация «добавить set velocity» — RED здесь).
    expect(desc?.set).toBeUndefined();
  });

  it('присваивание velocity бросает TypeError (strict mode, accessor без сеттера)', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING });
    expect(() => {
      (mv as unknown as { velocity: number }).velocity = 42;
    }).toThrow(TypeError);
    mv.destroy();
  });
});

// ─── Suite B: characterization — покой ───────────────────────────────────────

describe('MotionValue.velocity — в покое ровно 0 (class B characterization)', () => {
  it('рождение без initialVelocity → velocity === 0', () => {
    const mv = new MotionValue({ initial: 7, spring: STD_SPRING });
    expect(mv.velocity).toBe(0);
    mv.destroy();
  });

  it('рождение с initialVelocity → getter возвращает засеянную скорость (handoff-seam)', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, initialVelocity: 123.5 });
    expect(mv.velocity).toBe(123.5);
    mv.destroy();
  });

  it('после естественной сходимости → velocity === 0', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drainAll(2500);
    expect(mv.value).toBe(100);
    expect(mv.velocity).toBe(0);
    mv.destroy();
  });

  it('после snapTo в полёте → velocity === 0', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(5); // в полёте, скорость ненулевая
    expect(mv.velocity).not.toBe(0);
    mv.snapTo(60);
    expect(mv.velocity).toBe(0);
    mv.destroy();
  });
});

// ─── Suite A: в полёте — аналитический оракул ────────────────────────────────

describe('MotionValue.velocity — в полёте совпадает с аналитической из солвера (class A)', () => {
  it('v0-aware ран не обрывается frame-cap раньше физической сходимости на 144 Гц', () => {
    const physics = { mass: 1, stiffness: 1, damping: 1 };
    const donor = solveSpring(physics, 0.1, 0);
    const initial = donor.value * 100_000;
    const velocity = donor.velocity * 100_000;
    const target = initial + 2e-10;
    const clock = makeVirtualClock(1000 / 144);
    const seen: number[] = [];
    const mv = new MotionValue({
      initial,
      initialVelocity: velocity,
      spring: physics,
      clamp: false,
      requestFrame: clock.requestFrame,
    });
    mv.onChange((value) => seen.push(value));
    mv.setTarget(target);
    clock.drainAll(20_000);

    expect(clock.stamps.length).toBeGreaterThan(2_000);
    expect(mv.value).toBe(target);
    expect(Math.abs(seen.at(-2)! - target)).toBeLessThan(0.01);
    mv.destroy();
  });

  it('target === current сохраняет абсолютную стартовую скорость через представимый solver-range', () => {
    const clock = makeVirtualClock(0.1);
    const seen: number[] = [];
    const mv = new MotionValue({
      initial: 10,
      initialVelocity: 100,
      spring: STD_SPRING,
      clamp: false,
      requestFrame: clock.requestFrame,
    });
    mv.onChange((value) => seen.push(value));
    mv.setTarget(10);
    clock.drain(1); // elapsed=0
    expect(mv.velocity).toBe(100);
    clock.drain(1); // 0.1 ms
    expect((seen.at(-1)! - seen.at(-2)!) / 0.0001).toBeCloseTo(100, 0);
    clock.drainAll(50_000);
    expect(mv.value).toBe(10);
    expect(mv.velocity).toBe(0);
    mv.destroy();
  });

  it('после setTarget: ненулевая и бит-в-бит равна solveSpring(...).velocity * range', () => {
    const clock = makeVirtualClock();
    const initial = 0;
    const target = 100;
    const mv = new MotionValue({ initial, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(target);

    const range = target - initial;
    // Кадры 1..8: elapsed_i = (ts_i − ts_1)/1000, v0Normalized = 0 (старт из покоя).
    clock.drain(1); // тик 1 фиксирует startTs (elapsed = 0)
    for (let i = 2; i <= 8; i++) {
      clock.drain(1);
      const elapsed = (clock.stamps[i - 1] - clock.stamps[0]) / 1000;
      const expected = solveSpring(STD_SPRING, elapsed, 0).velocity * range;
      expect(mv.velocity).toBe(expected); // бит-в-бит: та же формула, тот же порядок операций
      expect(mv.velocity).not.toBe(0);
      expect(Number.isFinite(mv.velocity)).toBe(true);
    }
    mv.destroy();
  });

  it('setTarget в полёте (retarget): скорость непрерывна и следует оракулу нового рана', () => {
    const clock = makeVirtualClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(5); // транзиент: скорость набрана

    const velBefore = mv.velocity;
    expect(Math.abs(velBefore)).toBeGreaterThan(0.1);

    const valueAt = mv.value;
    const newTarget = 50;
    mv.setTarget(newTarget); // smooth pickup: v0Normalized = velBefore / range2
    const range2 = newTarget - valueAt;
    const v0n = velBefore / range2;

    // Первый тик нового рана: elapsed = 0 → solveSpring отдаёт velocity = v0 →
    // денормализация v0n * range2 — C¹-непрерывность (round-trip ≤ 1 ulp).
    const stampBase = clock.stamps.length;
    clock.drain(1);
    expect(mv.velocity).toBe(solveSpring(STD_SPRING, 0, v0n).velocity * range2);
    expect(mv.velocity / velBefore).toBeCloseTo(1, 10);

    // Дальше в полёте: бит-в-бит оракул нового рана с унаследованным v0.
    clock.drain(3);
    const elapsed = (clock.stamps[stampBase + 3] - clock.stamps[stampBase]) / 1000;
    expect(mv.velocity).toBe(solveSpring(STD_SPRING, elapsed, v0n).velocity * range2);
    expect(mv.velocity).not.toBe(0);
    mv.destroy();
  });
});

// ─── Suite C: property/fuzz — финитность на любых валидных входах ────────────

describe('MotionValue.velocity — финитность (class C, seeded fuzz ≥3000)', () => {
  it('velocity конечна на каждом кадре для 3000+ случайных прогонов; в покое ровно 0', () => {
    // Домовой канон: seeded LCG — детерминированный фазз.
    let seed = 0xc0ffee11;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0xffffffff;
    };
    const randVal = (): number => (rng() - 0.5) * 2000;

    const springVariants = [
      { mass: 1, stiffness: 200, damping: 20 }, // underdamped
      { mass: 1, stiffness: 100, damping: 20 }, // критический
      { mass: 1, stiffness: 50, damping: 30 }, // overdamped
      { mass: 0.5, stiffness: 1000, damping: 40 }, // жёсткий
    ];

    let samples = 0;
    for (let i = 0; i < 3000; i++) {
      const springP = springVariants[i % springVariants.length];
      const initial = randVal();
      const target = randVal();
      const clock = makeVirtualClock();
      const mv = new MotionValue({ initial, spring: springP, requestFrame: clock.requestFrame });
      mv.setTarget(target);
      const frames = 1 + Math.floor(rng() * 30);
      for (let f = 0; f < frames; f++) {
        clock.drain(1);
        if (!Number.isFinite(mv.velocity)) {
          throw new Error(
            `non-finite velocity: ${mv.velocity} (initial=${initial}, target=${target}, spring=${JSON.stringify(springP)}, frame=${f})`,
          );
        }
        samples++;
      }
      // Каждый десятый прогон дожимаем до покоя: в покое — РОВНО 0.
      if (i % 10 === 0) {
        clock.drainAll(600);
        if (clock.queueLength() === 0) {
          expect(mv.velocity).toBe(0);
        }
      }
      mv.destroy();
    }
    expect(samples).toBeGreaterThanOrEqual(3000);
  }, 60_000);
});
