/**
 * test/animate-facade.test.ts — субпуть ./animate: одно-строчный DOM-фасад.
 *
 * Классы: А (unit: каналы/опции/ошибки; integration: multi-element, stagger,
 * селектор, повторный animate = retarget с подхватом скорости, контролы).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * На заглушке src/animate/index.ts (export {}) каждый тест падал бы своим
 * ассертом («animate is not a function» / ассерты поверхности) — GREEN требует
 * реализации фасада. Мутанты, которые ловит файл (Класс Д, вручную):
 *  - убрать посев v0 при ретаргете → «подхват скорости C¹» красный (bit-exact
 *    сверка с readCompositorSpring);
 *  - забыть stagger-задержку → «каскад: el1 неподвижен до gap» красный;
 *  - резолвить селектор на импорте, а не в вызове → «селектор в момент вызова»
 *    красный (document появляется ПОСЛЕ импорта модуля).
 *
 * Детерминизм: время только через инжектируемый requestFrame (шаг-часы).
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import { MotionParamError, type MotionParamErrorCode } from '../src/errors.js';
import type { SpringParams } from '../src/spring.js';
import {
  fakeEl,
  makeClock,
  pickAnimate,
  pickLiveAnimate,
  translateXSeries,
  numericSeries,
} from './animate-facade-helpers.js';

const animate = pickLiveAnimate(animateApi as Record<string, unknown>);
const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

function expectCode(run: () => unknown, code: MotionParamErrorCode): void {
  try {
    run();
    expect.fail('ожидался MotionParamError');
  } catch (error) {
    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe(code);
  }
}

describe('animate: базовые каналы (Класс А, unit)', () => {
  it('физика живого рана изолирована от мутации caller-owned spring', () => {
    const a = fakeEl();
    const b = fakeEl();
    const ca = makeClock();
    const cb = makeClock();
    const spring = { mass: 1, stiffness: 170, damping: 26 };
    animate(a.el, { x: 120 }, { spring, requestFrame: ca.requestFrame });
    animate(b.el, { x: 120 }, { spring: { ...spring }, requestFrame: cb.requestFrame });
    spring.mass = 0;
    for (let i = 0; i < 6; i++) {
      ca.step(16);
      cb.step(16);
    }
    expect(translateXSeries(a.writes)).toEqual(translateXSeries(b.writes));
  });

  it('transform-шортхенд x: пружина едет к цели и оседает ровно на ней', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    const xs = translateXSeries(f.writes);
    expect(xs.length).toBeGreaterThan(3);
    // Стартует с identity (0), финал — ровно цель.
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(100);
    await controls.finished;
  });

  it('несколько transform-каналов сливаются в ОДНУ transform-строку', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(
      f.el,
      { x: 40, rotate: 90 },
      { spring: SPRING, requestFrame: clock.requestFrame },
    );
    clock.drain(16);
    await controls.finished;
    const last = f.writes.filter((w) => w.prop === 'transform').at(-1)!;
    expect(last.value).toContain('translateX(40px)');
    expect(last.value).toContain('rotate(90deg)');
  });

  it('opacity: число, оседает ровно на цели', async () => {
    const f = fakeEl({ opacity: '1' });
    const clock = makeClock();
    const controls = animate(f.el, { opacity: 0.25 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    await controls.finished;
    const os = numericSeries(f.writes, 'opacity');
    expect(os[os.length - 1]).toBe(0.25);
    expect(os.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('CSS-свойство через ./value: цвет интерполируется, каждая запись — валидный rgb', async () => {
    const f = fakeEl({ 'background-color': 'rgb(0, 0, 0)' });
    const clock = makeClock();
    const controls = animate(
      f.el,
      { backgroundColor: 'rgb(255, 0, 0)' },
      { spring: SPRING, requestFrame: clock.requestFrame },
    );
    clock.drain(16);
    await controls.finished;
    const colorWrites = f.writes.filter((w) => w.prop === 'background-color');
    expect(colorWrites.length).toBeGreaterThan(1);
    for (const w of colorWrites) expect(w.value).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(colorWrites.at(-1)!.value).toBe('rgb(255, 0, 0)');
  });

  it('CSS-свойство с юнитом: width из inline-стиля к цели, юнит сохранён', async () => {
    const f = fakeEl({ width: '10px' });
    const clock = makeClock();
    const controls = animate(f.el, { width: '110px' }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    await controls.finished;
    const ws = f.writes.filter((w) => w.prop === 'width');
    expect(ws[0]!.value).toBe('10px');
    expect(ws.at(-1)!.value).toBe('110px');
  });

  it('пара [from, to] задаёт явный from (не читая текущее состояние)', async () => {
    const f = fakeEl({ opacity: '1' });
    const clock = makeClock();
    const controls = animate(f.el, { opacity: [0, 0.5] }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    await controls.finished;
    const os = numericSeries(f.writes, 'opacity');
    expect(os[0]).toBe(0);
    expect(os.at(-1)).toBe(0.5);
  });
});

describe('animate: ошибки границы (Класс А, unit)', () => {
  it('spring и duration одновременно → MotionParamError', () => {
    const f = fakeEl();
    expectCode(
      () => animate(f.el, { x: 1 }, { spring: SPRING, duration: 300 }),
      'LM136',
    );
  });

  it('нечисловой prop (NaN) → MotionParamError, ноль записей в стиль', () => {
    const f = fakeEl();
    expect(() => animate(f.el, { x: Number.NaN }, { spring: SPRING })).toThrow();
    expect(f.writes.length).toBe(0);
  });

  it("prop 'transform' целиком не поддержан → LM140", () => {
    const f = fakeEl();
    expectCode(
      () => animate(f.el, { transform: 'translateX(10px)' }, { spring: SPRING }),
      'LM140',
    );
  });

  it('пустой список целей → controls с уже разрешённым finished (no-op)', async () => {
    let policyReads = 0;
    const controls = animate([], { x: 100 }, {
      spring: SPRING,
      matchMedia: () => {
        policyReads++;
        throw new Error('пустой aggregate не должен читать host-policy');
      },
    });
    await controls.finished; // не зависает
    expect(typeof controls.cancel).toBe('function');
    expect(policyReads).toBe(0);
  });
});

describe('animate: цели (Класс А, integration)', () => {
  it('массив элементов: анимируются все', async () => {
    const a = fakeEl();
    const b = fakeEl();
    const clock = makeClock();
    const controls = animate([a.el, b.el], { x: 50 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    await controls.finished;
    expect(translateXSeries(a.writes).at(-1)).toBe(50);
    expect(translateXSeries(b.writes).at(-1)).toBe(50);
  });

  it('duck-typed NodeList (length + индексы) принимается', async () => {
    const a = fakeEl();
    const b = fakeEl();
    const list = { length: 2, 0: a.el, 1: b.el };
    const clock = makeClock();
    const controls = animate(list, { x: 30 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    await controls.finished;
    expect(translateXSeries(a.writes).at(-1)).toBe(30);
    expect(translateXSeries(b.writes).at(-1)).toBe(30);
  });

  it('строка-селектор резолвится в МОМЕНТ ВЫЗОВА через document.querySelectorAll', async () => {
    const a = fakeEl();
    const b = fakeEl();
    const g = globalThis as { document?: unknown };
    const saved = g.document;
    // document появляется ПОСЛЕ импорта модуля — доказательство отсутствия
    // top-level захвата DOM (SSR-safe импорт + резолв на вызове).
    g.document = {
      querySelectorAll: (sel: string) => {
        expect(sel).toBe('.item');
        return { length: 2, 0: a.el, 1: b.el };
      },
    };
    try {
      const clock = makeClock();
      const controls = animate('.item', { x: 20 }, { spring: SPRING, requestFrame: clock.requestFrame });
      clock.drain(16);
      await controls.finished;
      expect(translateXSeries(a.writes).at(-1)).toBe(20);
      expect(translateXSeries(b.writes).at(-1)).toBe(20);
    } finally {
      if (saved === undefined) delete g.document;
      else g.document = saved;
    }
  });

  it('селектор без document (SSR-вызов) → MotionParamError, не ReferenceError', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    expectCode(() => animate('.item', { x: 1 }, { spring: SPRING }), 'LM149');
  });
});

describe('animate: stagger и delay (Класс А, integration)', () => {
  it('stagger: 40 — каскад: el0 сразу, el1 после 40мс, el2 после 80мс', () => {
    const a = fakeEl();
    const b = fakeEl();
    const c = fakeEl();
    const clock = makeClock();
    animate([a.el, b.el, c.el], { x: 100 }, { spring: SPRING, stagger: 40, requestFrame: clock.requestFrame });
    // Первый timestamp задаёт anchor: после двух кадров logical=16.
    clock.step(16);
    clock.step(16);
    expect(translateXSeries(a.writes).at(-1)!).toBeGreaterThan(0);
    expect(translateXSeries(b.writes).at(-1) ?? 0).toBe(0);
    expect(translateXSeries(c.writes).at(-1) ?? 0).toBe(0);
    // После четырёх кадров logical=48: el1 движется, el2 ещё нет.
    clock.step(16);
    clock.step(16);
    expect(translateXSeries(b.writes).at(-1)!).toBeGreaterThan(0);
    expect(translateXSeries(c.writes).at(-1) ?? 0).toBe(0);
    // logical=80: el2 ровно на своей границе, первый ненулевой шаг — следующий.
    clock.step(16);
    clock.step(16);
    expect(translateXSeries(c.writes).at(-1) ?? 0).toBe(0);
    clock.step(16);
    expect(translateXSeries(c.writes).at(-1)!).toBeGreaterThan(0);
  });

  it('stagger-конфиг ./stagger: from="last" — каскад с конца', () => {
    const a = fakeEl();
    const b = fakeEl();
    const clock = makeClock();
    animate(
      [a.el, b.el],
      { x: 100 },
      { spring: SPRING, stagger: { gap: 40, from: 'last' }, requestFrame: clock.requestFrame },
    );
    clock.step(16);
    clock.step(16);
    // t=32: при from='last' первым движется ПОСЛЕДНИЙ элемент.
    expect(translateXSeries(b.writes).at(-1)!).toBeGreaterThan(0);
    expect(translateXSeries(a.writes).at(-1) ?? 0).toBe(0);
  });

  it('delay задерживает старт всех элементов', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100 }, { spring: SPRING, delay: 100, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    clock.step(16); // t=48 < 100 — ещё на from
    expect(translateXSeries(f.writes).at(-1) ?? 0).toBe(0);
    for (let i = 0; i < 6; i++) clock.step(16); // t=144 > 100 — движется
    expect(translateXSeries(f.writes).at(-1)!).toBeGreaterThan(0);
  });
});

describe('animate: повторный вызов = прерывание с подхватом скорости (Класс А)', () => {
  it('C⁰: нет скачка значения на границе прерывания', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 7; i++) clock.step(16); // mid-flight
    const before = translateXSeries(f.writes).at(-1)!;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(100);
    animate(f.el, { x: 300 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    const after = translateXSeries(f.writes);
    // Первая запись нового рана — ровно значение на момент прерывания (C⁰ точно).
    expect(after.at(-1)!).toBeCloseTo(before, 6);
  });

  it('C¹: новый ран засеян скоростью прерванного — траектория bit-exact против readCompositorSpring', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    // Кадры старого рана: первый кадр — elapsed 0 (запись from), далее по 16 мс.
    const NFRAMES = 7;
    for (let i = 0; i < NFRAMES; i++) clock.step(16);
    const tInt = ((NFRAMES - 1) * 16) / 1000; // elapsed последнего кадра, сек
    const snap = readCompositorSpring(SPRING, { from: 0, to: 100, v0: 0, t: tInt });
    const xs = translateXSeries(f.writes);
    expect(xs.at(-1)!).toBeCloseTo(snap.value, 9);

    animate(f.el, { x: 300 }, { spring: SPRING, requestFrame: clock.requestFrame });
    const v0 = snap.velocity / (300 - snap.value); // нормированный посев скорости
    // 4 кадра нового рана: elapsed' = 0, 16, 32, 48 мс.
    for (let i = 0; i < 4; i++) clock.step(16);
    const after = translateXSeries(f.writes).slice(xs.length);
    for (let k = 0; k < after.length; k++) {
      const expected = readCompositorSpring(SPRING, {
        from: snap.value,
        to: 300,
        v0,
        t: (k * 16) / 1000,
      }).value;
      expect(after[k]!).toBeCloseTo(expected, 9);
    }
  });

  it('finished прерванного вызова резолвится (не зависает)', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 4; i++) clock.step(16);
    const second = animate(f.el, { x: 300 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    await first.finished;
    await second.finished;
    expect(translateXSeries(f.writes).at(-1)).toBe(300);
  });
});

describe('animate: контролы (Класс А)', () => {
  it('pause замораживает, play возобновляет', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 4; i++) clock.step(16);
    controls.pause();
    const frozen = translateXSeries(f.writes).length;
    for (let i = 0; i < 5; i++) clock.step(16);
    expect(translateXSeries(f.writes).length).toBe(frozen); // ни одной новой записи
    controls.play();
    clock.drain(16);
    await controls.finished;
    expect(translateXSeries(f.writes).at(-1)).toBe(100);
  });

  it('seek(t) перематывает к виртуальному времени (мс) и эмитит позицию', () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(
      f.el,
      { x: 100 },
      { duration: 400, ease: (t: number) => t, requestFrame: clock.requestFrame },
    );
    controls.seek(200);
    const xs = translateXSeries(f.writes);
    expect(xs.at(-1)).toBeCloseTo(50, 9); // линейный tween: 200/400 → 50px
  });

  it('cancel останавливает в текущей позиции и резолвит finished', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 4; i++) clock.step(16);
    const at = translateXSeries(f.writes).at(-1)!;
    controls.cancel();
    await controls.finished;
    clock.drain(16);
    // Позиция не убежала после cancel (записей движения больше нет).
    expect(translateXSeries(f.writes).at(-1)!).toBeCloseTo(at, 6);
    expect(translateXSeries(f.writes).at(-1)!).toBeLessThan(100);
  });

  it('stop — алиас cancel (канон driver)', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 3; i++) clock.step(16);
    controls.stop();
    await controls.finished;
    expect(translateXSeries(f.writes).at(-1)!).toBeLessThan(100);
  });

  it('onComplete вызывается один раз при завершении', async () => {
    const f = fakeEl();
    const clock = makeClock();
    let calls = 0;
    const controls = animate(
      f.el,
      { x: 100 },
      { spring: SPRING, requestFrame: clock.requestFrame, onComplete: () => calls++ },
    );
    clock.drain(16);
    await controls.finished;
    expect(calls).toBe(1);
  });
});

describe('animate: duration/ease путь (Класс А)', () => {
  it('линейный tween: значение в середине — ровно середина, оседает точно', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const controls = animate(
      f.el,
      { x: 100 },
      { duration: 400, ease: (t: number) => t, requestFrame: clock.requestFrame },
    );
    // Кадры: elapsed 0, 100, 200, ...
    clock.step(16); // первый кадр: elapsed 0 → from
    for (let i = 0; i < 2; i++) clock.step(100); // elapsed 200
    expect(translateXSeries(f.writes).at(-1)).toBeCloseTo(50, 9);
    clock.drain(100);
    await controls.finished;
    expect(translateXSeries(f.writes).at(-1)).toBe(100);
  });

  it('reduced-motion: единая снап-политика — мгновенный финал, без кадров', async () => {
    const f = fakeEl();
    const clock = makeClock();
    let completed = 0;
    const controls = animate(
      f.el,
      { x: 100, opacity: 0.5 },
      {
        spring: SPRING,
        requestFrame: clock.requestFrame,
        matchMedia: () => ({ matches: true }),
        onComplete: () => completed++,
      },
    );
    // Без единого кадра: финальные значения уже записаны.
    expect(translateXSeries(f.writes).at(-1)).toBe(100);
    expect(numericSeries(f.writes, 'opacity').at(-1)).toBe(0.5);
    await controls.finished;
    expect(completed).toBe(1);
  });
});
