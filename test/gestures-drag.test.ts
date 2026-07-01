/**
 * test/gestures-drag.test.ts
 * Классы: А (интеграция позиции/границ) + В (fuzz finiteness, детерминизм) + Д (mutation-proof).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации. Mutation-proof:
 *   убрать rubber-band множитель → тест «сопротивление за границей» RED;
 *   убрать generation-подобный interrupt → тест «down во время глайда» RED;
 *   убрать reduced-motion snap → тест «reduce: ноль кадров» RED.
 */

import { describe, expect, it } from 'vitest';
import { createDrag } from '../src/gestures/index.js';

// ─── Виртуальный клок (конвенция repo: ts в мс, handle > 0) ────────────────────

function virtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  let calls = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    calls++;
    return ++handle;
  };
  /** Прокачать один кадр с given ts (мс). */
  const pump = (ts: number): void => {
    const cbs = queue.splice(0);
    for (const cb of cbs) cb(ts);
  };
  return { requestFrame, pump, queue, rafCalls: () => calls };
}

/** matchMedia-стаб: reduced-motion = true. */
function reduceMedia(): (q: string) => MediaQueryList {
  return () =>
    ({ matches: true, media: '', onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as unknown as MediaQueryList;
}

// ─── Позиция и оси ────────────────────────────────────────────────────────────

describe('gestures/drag: интеграция позиции', () => {
  it('перетаскивание двигает позицию на дельту указателя от точки down', () => {
    const steps: Array<[number, number]> = [];
    const d = createDrag({ from: { x: 10, y: 20 }, onStep: (x, y) => steps.push([x, y]) });
    d.pointerDown({ x: 100, y: 100, t: 0 });
    d.pointerMove({ x: 130, y: 110, t: 0.05 });
    expect(d.x).toBeCloseTo(40); // 10 + 30
    expect(d.y).toBeCloseTo(30); // 20 + 10
    expect(steps[steps.length - 1]).toEqual([40, 30]);
  });

  it('axis="x" — y заморожен', () => {
    const d = createDrag({ axis: 'x' });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 50, y: 99, t: 0.05 });
    expect(d.x).toBeCloseTo(50);
    expect(d.y).toBe(0);
  });

  it('dragging-флаг', () => {
    const d = createDrag({ inertia: false });
    expect(d.dragging).toBe(false);
    d.pointerDown({ x: 0, y: 0, t: 0 });
    expect(d.dragging).toBe(true);
    d.pointerUp({ x: 0, y: 0, t: 0.1 });
    expect(d.dragging).toBe(false);
  });

  it('move/up без down — no-op', () => {
    const steps: unknown[] = [];
    const d = createDrag({ onStep: () => steps.push(1) });
    d.pointerMove({ x: 50, y: 50, t: 0 });
    d.pointerUp({ x: 50, y: 50, t: 0.1 });
    expect(steps).toEqual([]);
    expect(d.x).toBe(0);
  });
});

// ─── Границы и rubber-band ────────────────────────────────────────────────────

describe('gestures/drag: bounds + rubber-band', () => {
  it('rubberBand=0 — жёсткий clamp на границе', () => {
    const d = createDrag({ bounds: { x: { min: 0, max: 100 } }, rubberBand: 0 });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 250, y: 0, t: 0.05 });
    expect(d.x).toBe(100);
    d.pointerMove({ x: -250, y: 0, t: 0.1 });
    expect(d.x).toBe(0);
  });

  it('rubberBand=0.5 — за границей растёт вдвое медленнее (паритет elastic Motion)', () => {
    const d = createDrag({ bounds: { x: { min: 0, max: 100 } }, rubberBand: 0.5 });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 140, y: 0, t: 0.05 }); // raw=140, overshoot=40 → 100 + 20
    expect(d.x).toBeCloseTo(120);
  });

  it('внутри границ rubber-band не влияет', () => {
    const d = createDrag({ bounds: { x: { min: 0, max: 100 } }, rubberBand: 0.5 });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 60, y: 0, t: 0.05 });
    expect(d.x).toBeCloseTo(60);
  });

  it('отпускание без инерции за границей → снап на границу + onRest', () => {
    const rests: Array<[number, number]> = [];
    const d = createDrag({
      bounds: { x: { min: 0, max: 100 } }, rubberBand: 0.5, inertia: false,
      onRest: (x, y) => rests.push([x, y]),
    });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 140, y: 0, t: 0.05 });
    d.pointerUp({ x: 140, y: 0, t: 0.1 });
    expect(d.x).toBe(100);
    expect(rests).toEqual([[100, 0]]);
  });
});

// ─── Инерция (глайд через ./decay) ────────────────────────────────────────────

describe('gestures/drag: инерция отпускания', () => {
  function flick(clock: ReturnType<typeof virtualClock>, opts: Parameters<typeof createDrag>[0] = {}) {
    const d = createDrag({ requestFrame: clock.requestFrame, ...opts });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: 100, y: 0, t: 0.08 }); // vx ≈ 1250 px/s
    return d;
  }

  it('после up позиция продолжает двигаться по кадрам и оседает (onRest один раз)', () => {
    const clock = virtualClock();
    let rests = 0;
    const d = flick(clock, { onRest: () => rests++ });
    const xAtRelease = d.x;
    expect(d.gliding).toBe(true);
    // Прокачиваем виртуальное время до оседания
    for (let ts = 0; ts <= 3000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.gliding).toBe(false);
    expect(d.x).toBeGreaterThan(xAtRelease); // импульс пронёс дальше
    expect(Number.isFinite(d.x)).toBe(true);
    expect(rests).toBe(1);
  });

  it('глайд детерминирован: два одинаковых прогона бит-в-бит', () => {
    const run = (): number[] => {
      const clock = virtualClock();
      const steps: number[] = [];
      const d = flick(clock, { onStep: (x) => steps.push(x) });
      for (let ts = 0; ts <= 3000 && d.gliding; ts += 16) clock.pump(ts);
      return steps;
    };
    expect(run()).toEqual(run());
  });

  it('глайд жёстко останавливается на границе bounds', () => {
    const clock = virtualClock();
    const d = flick(clock, { bounds: { x: { min: 0, max: 150 } }, onRest: () => {} });
    for (let ts = 0; ts <= 5000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBe(150);
  });

  it('pointerDown во время глайда прерывает его (интерактивность)', () => {
    const clock = virtualClock();
    const d = flick(clock);
    clock.pump(16);
    expect(d.gliding).toBe(true);
    d.pointerDown({ x: 500, y: 0, t: 1 }); // перехват
    expect(d.gliding).toBe(false);
    expect(d.dragging).toBe(true);
    const xNow = d.x;
    clock.pump(32); // старый кадр глайда не должен сдвинуть позицию
    expect(d.x).toBe(xNow);
  });

  it('stop() глушит глайд без onRest', () => {
    const clock = virtualClock();
    let rests = 0;
    const d = flick(clock, { onRest: () => rests++ });
    d.stop();
    expect(d.gliding).toBe(false);
    clock.pump(160);
    expect(rests).toBe(0);
  });

  it('inertia=false → нет глайда, нет кадров', () => {
    const clock = virtualClock();
    const d = flick(clock, { inertia: false });
    expect(d.gliding).toBe(false);
    expect(clock.rafCalls()).toBe(0);
  });
});

// ─── Reduced motion: CHARACTER-switch ─────────────────────────────────────────

describe('gestures/drag: семантика cancel/stop (ноты арх-ревью PR #20)', () => {
  function flick2(clock: ReturnType<typeof virtualClock>, opts: Parameters<typeof createDrag>[0] = {}) {
    const d = createDrag({ requestFrame: clock.requestFrame, ...opts });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: 100, y: 0, t: 0.08 });
    return d;
  }

  it('pointerCancel во время ГЛАЙДА — осесть где стоишь (единая семантика с cancel при drag)', () => {
    const clock = virtualClock();
    const rests: number[] = [];
    const d = flick2(clock, { onRest: (x) => rests.push(x) });
    clock.pump(16);
    expect(d.gliding).toBe(true);
    const xAtCancel = d.x;
    d.pointerCancel(); // системный перехват указателя — глайд обязан осесть немедленно
    expect(d.gliding).toBe(false);
    expect(d.x).toBe(xAtCancel);
    expect(rests).toEqual([xAtCancel]);
    clock.pump(32); // stale-кадр глайда инертен
    expect(d.x).toBe(xAtCancel);
    expect(rests.length).toBe(1);
  });

  it('stop() во время АКТИВНОГО drag — no-op по контракту (скоуп stop = только глайд)', () => {
    const d = createDrag({ inertia: false });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 30, y: 0, t: 0.02 });
    d.stop(); // палец ещё на элементе: drag продолжает жить
    expect(d.dragging).toBe(true);
    d.pointerMove({ x: 50, y: 0, t: 0.04 });
    expect(d.x).toBeCloseTo(50);
  });

  it('повторный pointerDown во время dragging перехватывает якорь (не ломает состояние)', () => {
    const d = createDrag({ inertia: false });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 30, y: 0, t: 0.02 });
    expect(d.x).toBeCloseTo(30);
    d.pointerDown({ x: 100, y: 0, t: 0.04 }); // новый захват с текущей позиции
    d.pointerMove({ x: 110, y: 0, t: 0.06 });
    expect(d.x).toBeCloseTo(40); // 30 + 10, без скачка
    expect(d.dragging).toBe(true);
  });

  it('axis="x" + bounds совместно: y заморожен, x клампится', () => {
    const d = createDrag({ axis: 'x', bounds: { x: { min: 0, max: 50 } }, rubberBand: 0 });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 200, y: 99, t: 0.02 });
    expect(d.x).toBe(50);
    expect(d.y).toBe(0);
  });

  it('non-draining шов (handle=0): глайд едет через setTimeout-фоллбек и оседает', async () => {
    const d = createDrag({ requestFrame: () => 0 }); // конвенция repo: 0 = non-draining
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: 100, y: 0, t: 0.08 });
    expect(d.gliding).toBe(true);
    // Фоллбек тикает фиксированным шагом 1/60s: decay (timeConstant 0.35s,
    // restDelta 0.5) оседает за ~2-3s виртуального времени → < 200 тиков.
    for (let i = 0; i < 400 && d.gliding; i++) await new Promise((r) => setTimeout(r, 0));
    expect(d.gliding).toBe(false);
    expect(d.x).toBeGreaterThan(100);
    expect(Number.isFinite(d.x)).toBe(true);
  });
});

describe('gestures/drag: prefers-reduced-motion', () => {
  it('release при reduce: снап в точку покоя БЕЗ кадров (ноль rAF)', () => {
    const clock = virtualClock();
    const rests: number[] = [];
    const d = createDrag({
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(),
      onRest: (x) => rests.push(x),
    });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
    const before = clock.rafCalls();
    d.pointerUp({ x: 100, y: 0, t: 0.08 });
    expect(clock.rafCalls()).toBe(before); // ни одного кадра
    expect(d.gliding).toBe(false);
    expect(rests.length).toBe(1);
    expect(d.x).toBeGreaterThan(100); // характер сохранён: точка покоя ДОСТИГНУТА (не hard-off)
    expect(Number.isFinite(d.x)).toBe(true);
  });
});

// ─── Fuzz: finiteness (класс В) ───────────────────────────────────────────────

describe('gestures/drag: fuzz злых входов', () => {
  it('1000 злых сценариев → x/y всегда конечны', () => {
    let s = 424242;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, 1e308, -1e308];
    const pick = (): number => (rnd() < 0.35 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e5);
    for (let run = 0; run < 1000; run++) {
      const clock = virtualClock();
      const d = createDrag({
        requestFrame: clock.requestFrame,
        from: { x: rnd() < 0.2 ? pick() : 0, y: 0 },
        bounds: rnd() < 0.5 ? { x: { min: -100, max: 100 } } : undefined,
        rubberBand: rnd() < 0.3 ? pick() : 0.5,
        onStep: (x, y) => {
          expect(Number.isFinite(x)).toBe(true);
          expect(Number.isFinite(y)).toBe(true);
        },
      });
      d.pointerDown({ x: pick(), y: pick(), t: 0 });
      d.pointerMove({ x: pick(), y: pick(), t: 0.016 });
      d.pointerUp({ x: pick(), y: pick(), t: 0.032 });
      for (let ts = 0; ts <= 500 && d.gliding; ts += 16) clock.pump(ts);
      expect(Number.isFinite(d.x)).toBe(true);
      expect(Number.isFinite(d.y)).toBe(true);
    }
  });
});
