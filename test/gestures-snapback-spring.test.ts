/**
 * test/gestures-snapback-spring.test.ts
 * Классы: Б (characterization дефолта) + А (contract/bite + оракул) +
 *         В (property/fuzz, seeded LCG) + Д (mutation-proof).
 * Issue: #93 «единый C¹-контракт value+velocity», срез 2, контракт C2a.
 *
 * Зачем: до этого среза инерционный глайд drag на границе bounds жёстко
 * клэмпился, а остаточная скорость в момент касания ВЫБРАСЫВАЛАСЬ — стык был
 * разрывом первой производной (объект «врезался в стену»). Опт-ин опция
 * `snapBackSpring` передаёт скорость касания пружинному snap-back (iOS-манера):
 * короткий overshoot за границу и упругий возврат на неё, C¹ на стыке
 * decay|spring. Реализация обязана переиспользовать канон
 * solveSpring(params, t, v0) из internal/solver.ts (тот же, что smooth pickup
 * MotionValue) — оракул ниже сверяет траекторию с ним БИТ-В-БИТ.
 *
 * Контракт:
 *   (1) default (опция опущена) — прежнее поведение БИТ-В-БИТ: hard-clamp на
 *       границе, ни одна эмиссия не выходит за bounds, оседание на границе;
 *   (2) со snapBackSpring: в кадре первого выхода decay за границу ось
 *       переключается на пружину к границе (from = сырое значение decay за
 *       границей, target = граница, v0 = скорость decay в момент касания);
 *   (3) C¹ на стыке: позиция стыка лежит на той же decay-траектории, секанс
 *       скорости сразу после касания сонаправлен и соизмерим с секансом до;
 *   (4) траектория пружинной фазы бит-в-бит равна оракулу
 *       from + solveSpring(snap, t−t₀, v/range).value · range;
 *   (5) оседание РОВНО на границе (не рядом), onRest один раз;
 *   (6) невалидная snapBackSpring → MotionParamError синхронно из createDrag;
 *   (7) финитность каждой эмиссии на злых входах (инвариант G1).
 *
 * RED PROOF (вневременно — почему тесты были красными до реализации):
 *   DragOptions не имел поля snapBackSpring (tsc: unknown property в строгом
 *   объектном литерале), глайд жёстко клэмпился: «эмиссии выходят за границу»
 *   падал (max(emitted) === bound), секанс после касания был 0 (осёл в кадре
 *   касания) — C¹-bite падал, оракул solveSpring не совпадал ни с одним
 *   кадром после касания, toThrow(MotionParamError) на невалидной пружине
 *   падал (опция игнорировалась). RED по правильной причине: отсутствие
 *   контракта, не поломка decay/солвера.
 *
 * Mutation proofs (тест обязан падать на своей мутации):
 *   [inherit-v] Захардкодить v0n=0 при переключении → оракул-сверка (4) и
 *               «эмиссии выходят за границу» (overshoot исчезает) падают.
 *   [reuse]     Подменить solveSpring самодельной формулой → бит-в-бит оракул (4).
 *   [default]   Включить snap-back без опции → characterization-пин (1) падает.
 *   [settle]    Убрать снап в target при сходимости → «оседание РОВНО на
 *               границе» (5) падает (last !== bound).
 *   [validate]  Убрать validateSpringParams(snapBack) → (6) падает.
 *   [guard]     Убрать non-finite-страж пружинной фазы → фазз (7) ловит.
 */

import { describe, expect, it } from 'vitest';
import { createDrag, createVelocityTracker } from '../src/gestures/index.js';
import { createDecay } from '../src/decay.js';
import { solveSpring } from '../src/internal/solver.js';
import { CONVERGENCE_THRESHOLD } from '../src/internal/constants.js';
import { MotionParamError } from '../src/errors.js';

// ─── Виртуальный клок (конвенция repo: ts в мс, handle > 0) ────────────────────

function virtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return ++handle;
  };
  const pump = (ts: number): void => {
    const cbs = queue.splice(0);
    for (const cb of cbs) cb(ts);
  };
  return { requestFrame, pump, queue };
}

/** matchMedia-стаб: reduced-motion = true. */
function reduceMedia(): (q: string) => MediaQueryList {
  return () =>
    ({ matches: true }) as unknown as MediaQueryList;
}

const SNAP = { mass: 1, stiffness: 200, damping: 20 } as const;

/**
 * Стандартный флик вправо (vx = 100/0.08 = 1250 px/s на отпускании) —
 * та же последовательность точек, что в gestures-drag.test.ts.
 */
function flick(clock: ReturnType<typeof virtualClock>, opts: Parameters<typeof createDrag>[0] = {}) {
  const d = createDrag({ requestFrame: clock.requestFrame, ...opts });
  d.pointerDown({ x: 0, y: 0, t: 0 });
  for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
  d.pointerUp({ x: 100, y: 0, t: 0.08 });
  return d;
}

/** Прокачать глайд до оседания, журналируя пампнутые ts. */
function pumpUntilRest(
  clock: ReturnType<typeof virtualClock>,
  d: { readonly gliding: boolean },
  pumped: number[] = [],
): number[] {
  for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) {
    clock.pump(ts);
    pumped.push(ts);
  }
  return pumped;
}

// ─── Класс Б: characterization — дефолт НЕ изменился ─────────────────────────

describe('gestures/drag snapBackSpring: characterization дефолта (класс Б)', () => {
  it('без опции: ни одна эмиссия не выходит за bounds, оседание ровно на границе (прежний клэмп)', () => {
    const clock = virtualClock();
    const steps: number[] = [];
    let rests = 0;
    const d = flick(clock, {
      bounds: { x: { min: 0, max: 150 } },
      onStep: (x) => steps.push(x),
      onRest: () => rests++,
    });
    pumpUntilRest(clock, d);
    const glideSteps = steps.filter((x) => x > 100); // кадры после release
    expect(glideSteps.length).toBeGreaterThan(0);
    for (const x of steps) expect(x).toBeLessThanOrEqual(150);
    expect(d.x).toBe(150);
    expect(rests).toBe(1);
  });

  it('со snapBackSpring, но БЕЗ касания границы — траектория бит-в-бит прежняя (переключение только на границе)', () => {
    const run = (withSnap: boolean): number[] => {
      const clock = virtualClock();
      const steps: number[] = [];
      const d = flick(clock, {
        // Границы заведомо недостижимы для этого флика (rest ≈ 450 px).
        bounds: { x: { min: -1e6, max: 1e6 } },
        ...(withSnap ? { snapBackSpring: SNAP } : {}),
        onStep: (x) => steps.push(x),
      });
      pumpUntilRest(clock, d);
      return steps;
    };
    const a = run(false);
    const b = run(true);
    expect(a.length).toBeGreaterThan(2);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });
});

// ─── Класс А: контракт snap-back ──────────────────────────────────────────────

describe('gestures/drag snapBackSpring: контракт C2a (класс А)', () => {
  it('касание max-границы: эмиссии выходят ЗА границу (overshoot), возврат и оседание РОВНО на границе, onRest один раз', () => {
    const clock = virtualClock();
    const steps: number[] = [];
    let rests = 0;
    const d = flick(clock, {
      bounds: { x: { min: 0, max: 150 } },
      snapBackSpring: SNAP,
      onStep: (x) => steps.push(x),
      onRest: () => rests++,
    });
    pumpUntilRest(clock, d);
    expect(Math.max(...steps)).toBeGreaterThan(150); // унаследованная скорость пронесла за границу
    expect(d.gliding).toBe(false);
    expect(d.x).toBe(150); // снап точно на границу (сходимость пружины)
    expect(steps[steps.length - 1]).toBe(150);
    expect(rests).toBe(1);
  });

  it('min-граница симметрично: флик влево — провал ниже min и оседание ровно на min', () => {
    const clock = virtualClock();
    const steps: number[] = [];
    const d = createDrag({
      requestFrame: clock.requestFrame,
      bounds: { x: { min: -150, max: 0 } },
      snapBackSpring: SNAP,
      onStep: (x) => steps.push(x),
    });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: -i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: -100, y: 0, t: 0.08 });
    pumpUntilRest(clock, d);
    expect(Math.min(...steps)).toBeLessThan(-150);
    expect(d.x).toBe(-150);
  });

  it('C¹ на стыке: секанс скорости сразу после касания сонаправлен и > 0.5·секанса до (дефолт даёт 0)', () => {
    const clock = virtualClock();
    const steps: number[] = [];
    const d = flick(clock, {
      bounds: { x: { min: 0, max: 150 } },
      snapBackSpring: SNAP,
      onStep: (x) => steps.push(x),
    });
    // Кадры глайда: только эмиссии после release.
    const glide: number[] = [];
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) {
      const before = steps.length;
      clock.pump(ts);
      if (steps.length > before) glide.push(steps[steps.length - 1]);
    }
    // Индекс первого кадра за границей.
    const k = glide.findIndex((x) => x > 150);
    expect(k).toBeGreaterThan(0);
    const dt = 0.016;
    const secBefore = (glide[k] - glide[k - 1]) / dt; // включает сам кадр касания — decay-производная
    const secAfter = (glide[k + 1] - glide[k]) / dt; // первый чисто пружинный шаг
    expect(secBefore).toBeGreaterThan(0);
    // Скорость унаследована: движение продолжается наружу, соизмеримо (не 0).
    expect(secAfter).toBeGreaterThan(0.5 * secBefore);
  });

  it('пружинная фаза бит-в-бит равна оракулу solveSpring (переиспользование канона, mutation-proof [reuse]/[inherit-v])', () => {
    const MAX = 150;
    const clock = virtualClock();
    const steps: number[] = [];
    const d = flick(clock, {
      bounds: { x: { min: 0, max: MAX } },
      snapBackSpring: SNAP,
      onStep: (x) => steps.push(x),
    });
    const glide: number[] = [];
    const pumped: number[] = [];
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) {
      const before = steps.length;
      clock.pump(ts);
      if (steps.length > before) {
        glide.push(steps[steps.length - 1]);
        pumped.push(ts);
      }
    }

    // Оракул повторяет реализацию той же арифметикой (бит-в-бит):
    // decay с параметрами release (from=100, vx=(100−0)/(0.08−0) — слоуп
    // велосити-трекера по окну) и переключение на solveSpring в кадре касания.
    const vx = (100 - 0) / (0.08 - 0);
    const model = createDecay({ from: 100, velocity: vx });
    let elapsed = 0;
    let lastTs: number | undefined;
    let t0 = -1;
    let from = 0;
    let v0n = 0;
    for (let i = 0; i < glide.length; i++) {
      const ts = pumped[i];
      elapsed = lastTs === undefined ? elapsed : elapsed + Math.max(0, (ts - lastTs) / 1000);
      lastTs = ts;
      let expected: number;
      if (t0 >= 0) {
        const range = MAX - from;
        const s = solveSpring(SNAP, elapsed - t0, v0n);
        const val = from + s.value * range;
        const vel = s.velocity * range;
        const denom = Math.abs(range);
        expected =
          Math.abs(val - MAX) / denom < CONVERGENCE_THRESHOLD &&
          Math.abs(vel) / denom < CONVERGENCE_THRESHOLD
            ? MAX
            : val;
      } else {
        const raw = model.valueAt(elapsed);
        if (raw > MAX) {
          t0 = elapsed;
          from = raw;
          v0n = model.velocityAt(elapsed) / (MAX - raw);
          expected = raw;
        } else {
          expected = raw;
        }
      }
      expect(glide[i], `кадр ${i} (elapsed=${elapsed})`).toBe(expected);
    }
    expect(t0).toBeGreaterThanOrEqual(0); // переключение состоялось
    expect(glide[glide.length - 1]).toBe(MAX);
  });

  it('reduced-motion + snapBackSpring: снап в клампнутую точку покоя БЕЗ кадров (G4 не сломан)', () => {
    const clock = virtualClock();
    const rests: number[] = [];
    const d = flick(clock, {
      bounds: { x: { min: 0, max: 150 } },
      snapBackSpring: SNAP,
      matchMedia: reduceMedia(),
      onRest: (x) => rests.push(x),
    });
    expect(clock.queue.length).toBe(0); // ни одного кадра
    expect(d.gliding).toBe(false);
    expect(d.x).toBe(150); // rest клампнут на границу — пружина всё равно осела бы там
    expect(rests).toEqual([150]);
  });

  it('inertia:false игнорирует snapBackSpring: rubber-banded позиция оседает на границе без кадров', () => {
    const clock = virtualClock();
    const d = createDrag({
      requestFrame: clock.requestFrame,
      bounds: { x: { min: 0, max: 100 } },
      inertia: false,
      snapBackSpring: SNAP,
    });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 140, y: 0, t: 0.05 });
    d.pointerUp({ x: 140, y: 0, t: 0.1 });
    expect(clock.queue.length).toBe(0);
    expect(d.x).toBe(100);
  });

  it('pointerDown во время snap-back перехватывает пружину (stale-кадры инертны)', () => {
    const clock = virtualClock();
    const d = flick(clock, { bounds: { x: { min: 0, max: 150 } }, snapBackSpring: SNAP });
    // Прокачиваем до первого выхода за границу (фаза пружины активна).
    let ts = 0;
    while (d.gliding && d.x <= 150 && ts <= 10_000) {
      clock.pump(ts);
      ts += 16;
    }
    expect(d.gliding).toBe(true);
    d.pointerDown({ x: 500, y: 0, t: 2 });
    expect(d.gliding).toBe(false);
    expect(d.dragging).toBe(true);
    const xNow = d.x;
    clock.pump(ts + 16); // stale-кадр пружины не двигает позицию
    expect(d.x).toBe(xNow);
  });
});

// ─── Класс А: fail-fast валидация опции ───────────────────────────────────────

describe('gestures/drag snapBackSpring: невалидная пружина → MotionParamError синхронно (класс А)', () => {
  it.each([
    { mass: 0, stiffness: 200, damping: 20 }, // невалидная масса
    { mass: 1, stiffness: Number.NaN, damping: 20 }, // NaN-жёсткость
    { mass: 1, stiffness: 200, damping: -1 }, // отрицательное демпфирование
    { mass: 1, stiffness: 200, damping: 0 }, // незатухающая — не проходит settle-бюджет
  ])('createDrag бросает ещё ДО первого события указателя (%j)', (bad) => {
    expect(() => createDrag({ snapBackSpring: bad })).toThrow(MotionParamError);
  });

  it('валидная пружина не бросает; отсутствие опции не бросает', () => {
    expect(() => createDrag({ snapBackSpring: SNAP })).not.toThrow();
    expect(() => createDrag({})).not.toThrow();
  });
});

// ─── Класс В: property/fuzz (seeded LCG — домовой канон) ─────────────────────

describe('gestures/drag snapBackSpring: fuzz (класс В, seeded LCG)', () => {
  it('500 сценариев: эмиссии всегда конечны; после оседания позиция внутри bounds (пересёк → ровно граница)', () => {
    let s = 0x5eedc2a1;
    const rnd = () => {
      s = (Math.imul(1664525, s) + 1013904223) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const springs = [
      { mass: 1, stiffness: 200, damping: 20 }, // underdamped
      { mass: 1, stiffness: 100, damping: 20 }, // критический
      { mass: 1, stiffness: 50, damping: 30 }, // overdamped
      { mass: 0.5, stiffness: 1000, damping: 40 }, // жёсткий
    ];
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, 1e308];

    for (let run = 0; run < 500; run++) {
      const clock = virtualClock();
      const min = -(50 + rnd() * 200);
      const max = 50 + rnd() * 200;
      const d = createDrag({
        requestFrame: clock.requestFrame,
        bounds: { x: { min, max }, y: rnd() < 0.5 ? { min, max } : undefined },
        snapBackSpring: springs[run % springs.length],
        // Горячий путь фазза: throw вместо expect (канон drive-фазза).
        onStep: (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`non-finite эмиссия: (${x}, ${y}) на прогоне ${run}`);
          }
        },
      });
      const dir = rnd() < 0.5 ? -1 : 1;
      const speed = rnd() * 200; // до ±12.5k px/s на release
      const evilX = rnd() < 0.1 ? evil[Math.floor(rnd() * evil.length)] : 0;
      d.pointerDown({ x: evilX, y: 0, t: 0 });
      for (let i = 1; i <= 5; i++) d.pointerMove({ x: dir * i * speed, y: dir * i * 5, t: i * 0.016 });
      d.pointerUp({ x: dir * 5 * speed, y: dir * 25, t: 0.08 });
      for (let ts = 0; ts <= 40_000 && d.gliding; ts += 16) clock.pump(ts);
      expect(d.gliding).toBe(false); // оседание в бюджете (страховка GLIDE_MAX_FRAMES)
      expect(Number.isFinite(d.x)).toBe(true);
      expect(Number.isFinite(d.y)).toBe(true);
      // Финал всегда внутри границ: пружина снапает РОВНО на границу.
      expect(d.x).toBeGreaterThanOrEqual(min);
      expect(d.x).toBeLessThanOrEqual(max);
    }
  });

  it('детерминизм: два одинаковых snap-back прогона бит-в-бит', () => {
    const run = (): number[] => {
      const clock = virtualClock();
      const steps: number[] = [];
      const d = flick(clock, {
        bounds: { x: { min: 0, max: 150 } },
        snapBackSpring: SNAP,
        onStep: (x) => steps.push(x),
      });
      pumpUntilRest(clock, d);
      return steps;
    };
    expect(run()).toEqual(run());
  });

  it('velocity tracker остаётся консистентным источником скорости release (санити оракула)', () => {
    // Санити: слоуп трекера по нашим точкам — ровно (100−0)/(0.08−0),
    // как принято в оракуле бит-в-бит теста выше.
    const t = createVelocityTracker();
    t.push({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) t.push({ x: i * 20, y: 0, t: i * 0.016 });
    t.push({ x: 100, y: 0, t: 0.08 });
    expect(t.velocity().vx).toBe((100 - 0) / (0.08 - 0));
  });
});
