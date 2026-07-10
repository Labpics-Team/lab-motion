/**
 * test/flip.test.ts — FLIP-математика и драйвер (subpath ./flip).
 * Классы: А (формулы) + В (fuzz finiteness, детерминизм) + Д (mutation-proof).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый поведенческий блок своим ассертом.
 * Mutation-proof: поменять знак в dx (last−first вместо first−last) →
 * тест «инверсия» RED; убрать finite-гард нулевого размера → fuzz RED;
 * убрать коррекцию радиуса → «correctRadius» RED.
 */

import { describe, expect, it } from 'vitest';
import * as flip from '../src/flip/index.js';
import { computeFlip, flipAt, correctRadius, counterScale, createFlip } from '../src/flip/index.js';

// ─── computeFlip: инверсия First→Last ────────────────────────────────────────

describe('flip/math: computeFlip (инверсия)', () => {
  it('смещение и масштаб от first к last (origin 0 0)', () => {
    const f = computeFlip(
      { x: 0, y: 0, width: 100, height: 100 },   // first
      { x: 200, y: 50, width: 200, height: 50 }, // last
    );
    // Инверт: из финального положения ВЕРНУТЬСЯ визуально в первое.
    expect(f.dx).toBe(-200);
    expect(f.dy).toBe(-50);
    expect(f.sx).toBeCloseTo(0.5);  // 100/200
    expect(f.sy).toBeCloseTo(2);    // 100/50
  });

  it('идентичные прямоугольники → нулевая инверсия', () => {
    const r = { x: 10, y: 20, width: 30, height: 40 };
    const f = computeFlip(r, { ...r });
    expect(f.dx).toBe(0);
    expect(f.dy).toBe(0);
    expect(f.sx).toBe(1);
    expect(f.sy).toBe(1);
  });

  it('вырожденный last (width/height = 0) → конечные значения (страж)', () => {
    const f = computeFlip(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 0, height: 0 },
    );
    expect(Number.isFinite(f.sx)).toBe(true);
    expect(Number.isFinite(f.sy)).toBe(true);
  });

  it('fuzz: злые прямоугольники → все поля конечны', () => {
    let s = 777001;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, 0, -0, 1e-320];
    const pick = (): number => (rnd() < 0.4 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e5);
    for (let i = 0; i < 3000; i++) {
      const f = computeFlip(
        { x: pick(), y: pick(), width: pick(), height: pick() },
        { x: pick(), y: pick(), width: pick(), height: pick() },
      );
      for (const v of [f.dx, f.dy, f.sx, f.sy]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

// ─── flipAt: интерполяция инверт → identity ──────────────────────────────────

describe('flip/math: flipAt (прогресс инверсии)', () => {
  const inv = computeFlip(
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 200, y: 50, width: 200, height: 50 },
  );

  it('p=0 — полная инверсия (визуально на first)', () => {
    const t = flipAt(inv, 0);
    expect(t.tx).toBe(-200);
    expect(t.ty).toBe(-50);
    expect(t.sx).toBeCloseTo(0.5);
    expect(t.sy).toBeCloseTo(2);
  });

  it('p=1 — identity (визуально на last)', () => {
    const t = flipAt(inv, 1);
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(0);
    expect(t.sx).toBe(1);
    expect(t.sy).toBe(1);
  });

  it('p за пределами [0,1] клампится; NaN → 0', () => {
    expect(flipAt(inv, 2).tx).toBe(0);
    expect(flipAt(inv, -1).tx).toBe(-200);
    expect(flipAt(inv, NaN).tx).toBe(-200);
  });
});

// ─── Коррекция scale-искажений (фирменный класс Motion) ──────────────────────

describe('flip/math: коррекция искажений', () => {
  it('correctRadius: визуальный радиус постоянен при масштабе', () => {
    // Элемент растянут ×2 по x: чтобы радиус ВЫГЛЯДЕЛ 8px, применить 4px по x.
    const r = correctRadius(8, 2, 0.5);
    expect(r.x).toBeCloseTo(4);
    expect(r.y).toBeCloseTo(16);
  });

  it('correctRadius: scale 0 / NaN → конечный результат (страж)', () => {
    const r = correctRadius(8, 0, NaN);
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
  });

  it('counterScale: дочерний элемент не искажается (обратный масштаб)', () => {
    const c = counterScale(2, 0.5);
    expect(c.sx).toBeCloseTo(0.5);
    expect(c.sy).toBeCloseTo(2);
  });

  it('counterScale: нулевой/злой масштаб → конечно', () => {
    const c = counterScale(0, -Infinity);
    expect(Number.isFinite(c.sx)).toBe(true);
    expect(Number.isFinite(c.sy)).toBe(true);
  });
});

// ─── createFlip: драйвер (spring 0→1 поверх инверсии) ────────────────────────

function virtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  let calls = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    calls++;
    return ++handle;
  };
  const pump = (ts: number): void => {
    const cbs = queue.splice(0);
    for (const cb of cbs) cb(ts);
  };
  return { requestFrame, pump, rafCalls: () => calls };
}

function reduceMedia(): (q: string) => MediaQueryList {
  return () =>
    ({ matches: true, media: '', onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as unknown as MediaQueryList;
}

describe('flip/driver: createFlip', () => {
  const FIRST = { x: 0, y: 0, width: 100, height: 100 };
  const LAST = { x: 200, y: 50, width: 200, height: 50 };

  it('play(first,last): стартует с инверсии, доезжает до identity, onRest один раз', () => {
    const clock = virtualClock();
    const steps: Array<{ tx: number; sx: number }> = [];
    let rests = 0;
    const fl = createFlip({
      requestFrame: clock.requestFrame,
      onStep: (t) => steps.push({ tx: t.tx, sx: t.sx }),
      onRest: () => rests++,
    });
    fl.play(FIRST, LAST);
    for (let ts = 0; ts <= 5000 && rests === 0; ts += 16) clock.pump(ts);
    expect(rests).toBe(1);
    expect(steps[0].tx).toBeCloseTo(-200, 0); // первый кадр — у инверсии
    const last = steps[steps.length - 1];
    expect(last.tx).toBeCloseTo(0, 1); // финал — identity
    expect(last.sx).toBeCloseTo(1, 3);
    for (const st of steps) {
      expect(Number.isFinite(st.tx)).toBe(true);
      expect(Number.isFinite(st.sx)).toBe(true);
    }
  });

  it('детерминизм: два прогона бит-в-бит', () => {
    const run = (): number[] => {
      const clock = virtualClock();
      const xs: number[] = [];
      let done = false;
      const fl = createFlip({
        requestFrame: clock.requestFrame,
        onStep: (t) => xs.push(t.tx),
        onRest: () => { done = true; },
      });
      fl.play(FIRST, LAST);
      for (let ts = 0; ts <= 5000 && !done; ts += 16) clock.pump(ts);
      return xs;
    };
    expect(run()).toEqual(run());
  });

  it('reduced-motion: identity сразу, ноль кадров (CHARACTER-switch)', () => {
    const clock = virtualClock();
    const steps: number[] = [];
    let rests = 0;
    const fl = createFlip({
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(),
      onStep: (t) => steps.push(t.tx),
      onRest: () => rests++,
    });
    fl.play(FIRST, LAST);
    expect(clock.rafCalls()).toBe(0);
    expect(steps).toEqual([0]); // один снап в identity
    expect(rests).toBe(1);
  });

  it('повторный play во время полёта — перехват: кадры СТАРОГО полёта инертны (несёт generation)', () => {
    // Старый полёт: tx ← −200 (инверсия FIRST→LAST, отрицательный).
    // Новый полёт: LAST→FIRST, dx = 200 − 0 = +200 → все tx нового ≥ 0.
    // Если stale-кадр старого полёта эмитит после перехвата — в потоке
    // появится отрицательный tx → RED. Убийца мутанта «убрать gen-гард».
    const clock = virtualClock();
    const txs: number[] = [];
    const fl = createFlip({ requestFrame: clock.requestFrame, onStep: (t) => txs.push(t.tx) });
    fl.play(FIRST, LAST);
    clock.pump(16); // старый полёт запланировал следующий кадр
    fl.play(LAST, FIRST); // перехват: с этого момента только tx ≥ 0
    const marker = txs.length; // всё до — старый полёт
    clock.pump(32); // в очереди И stale-кадр старого, И первый кадр нового
    clock.pump(48);
    const afterIntercept = txs.slice(marker);
    expect(afterIntercept.length).toBeGreaterThan(0);
    for (const tx of afterIntercept) expect(tx).toBeGreaterThanOrEqual(0);
  });

  it('невалидная пружина бросает MotionParamError РАНО (createFlip), конвенция движка', async () => {
    const { MotionParamError } = await import('../src/index.js');
    expect(() => createFlip({ spring: { mass: -1, stiffness: 100, damping: 10 } }))
      .toThrow(MotionParamError);
    // И под reduced-motion невалидная пружина НЕ проглатывается молча.
    expect(() =>
      createFlip({ spring: { mass: 1, stiffness: NaN, damping: 10 }, matchMedia: reduceMedia() }),
    ).toThrow(MotionParamError);
  });

  it('cancel(): глушит полёт без onRest', () => {
    const clock = virtualClock();
    let rests = 0;
    const fl = createFlip({ requestFrame: clock.requestFrame, onStep: () => {}, onRest: () => rests++ });
    fl.play(FIRST, LAST);
    fl.cancel();
    clock.pump(160);
    expect(rests).toBe(0);
    expect(fl.playing).toBe(false);
  });
});

// ─── API surface pin ──────────────────────────────────────────────────────────

describe('flip-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(flip).sort()).toEqual([
      'computeFlip',
      'correctRadius',
      'counterScale',
      'createFlip',
      'flipAt',
    ]);
  });

  it('форма контроллера (исчерпывающе)', () => {
    const fl = createFlip();
    expect(Object.keys(fl).sort()).toEqual(['cancel', 'play', 'playing', 'progress']);
  });

  it('SSR: node env, без DOM — не бросает', () => {
    expect(() => {
      computeFlip({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 });
      createFlip();
    }).not.toThrow();
  });
});
