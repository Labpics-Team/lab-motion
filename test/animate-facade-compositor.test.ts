/**
 * test/animate-facade-compositor.test.ts — авто-tier фасада ./animate.
 *
 * Классы: А (маршрутизация: compositor-eligible свойства + spring + tier →
 * Element.animate; прочее → main-thread), contract (форма keyframes/timing).
 *
 * Среда: node, duck-typed цели (как compositor-fallback-matrix). В node нет
 * CSS API → supportsLinearEasing() возвращает true; цель с .animate →
 * resolveCompositorTier = 'compositor' (детекция ядра, здесь переиспользуется).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * На заглушке (export {}) каждый тест падал бы своим ассертом. Мутанты (Класс Д, вручную):
 *  - роутить всё в main-thread → «Element.animate вызван» красный;
 *  - забыть cancel при compositor-ретаргете → «cancel вызван» красный;
 *  - пустить цвет на compositor-путь → «color идёт main-thread» красный.
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import { spring as springTokens } from '../src/tokens/index.js';
import {
  fakeEl,
  makeClock,
  makeNow,
  makeTimer,
  pickAnimate,
  pickLiveAnimate,
  readTranslateX,
  translateXSeries,
} from './animate-facade-helpers.js';

const animate = pickLiveAnimate(animateApi as Record<string, unknown>);
const SPRING = springTokens.default;

describe('animate: compositor-путь (Класс А + contract)', () => {
  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('transform + spring + цель с WAAPI → ОДИН Element.animate, ноль per-frame записей', () => {
    const f = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    animate(f.el, { x: 100 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    expect(f.animateCalls.length).toBe(1);
    const call = f.animateCalls[0]!;
    // Кейфреймы: [from, to] на transform; вся кривая — в linear()-easing.
    expect(call.keyframes.length).toBe(2);
    expect(call.keyframes[0]!['transform']).toBe('none'); // identity from
    expect(call.keyframes[1]!['transform']).toBe('translateX(100px)');
    expect(String(call.timing['easing'])).toMatch(/^linear\(/);
    expect(Number(call.timing['duration'])).toBeGreaterThan(0);
    // Суть compositor-пути: main-поток не пишет стиль по кадрам.
    expect(f.writes.filter((w) => w.prop === 'transform').length).toBe(0);
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('opacity + spring → Element.animate на opacity с числовыми кейфреймами', () => {
    const f = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    animate(f.el, { opacity: [0, 1] }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    expect(f.animateCalls.length).toBe(1);
    const kf = f.animateCalls[0]!.keyframes;
    expect(kf[0]!['opacity']).toBe(0);
    expect(kf[1]!['opacity']).toBe(1);
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('смешанные props {x, opacity} → ДВА независимых Element.animate (transform и opacity)', () => {
    const f = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    animate(f.el, { x: 50, opacity: [0, 1] }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    expect(f.animateCalls.length).toBe(2);
    const props = f.animateCalls.map((c) => Object.keys(c.keyframes[0]!).filter((k) => k !== 'offset')[0]);
    expect(props).toContain('transform');
    expect(props).toContain('opacity');
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('не-compositor свойство (цвет) идёт main-thread даже при WAAPI-цели', () => {
    const f = fakeEl({ 'background-color': 'rgb(0, 0, 0)' }, true);
    const clock = makeClock();
    animate(f.el, { backgroundColor: 'rgb(255, 0, 0)' }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    expect(f.animateCalls.length).toBe(0);
    expect(f.writes.filter((w) => w.prop === 'background-color').length).toBeGreaterThan(0);
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('duration/ease путь НЕ уходит на compositor (spring-only контракт CompositorSpring)', () => {
    const f = fakeEl({}, true);
    const clock = makeClock();
    animate(f.el, { x: 100 }, { duration: 300, requestFrame: clock.requestFrame });
    clock.step(16);
    expect(f.animateCalls.length).toBe(0);
    expect(f.writes.filter((w) => w.prop === 'transform').length).toBeGreaterThan(0);
  });

  it('цель без WAAPI → fallback на main-thread (записи по кадрам)', async () => {
    const f = fakeEl(); // без .animate
    const clock = makeClock();
    const controls = animate(f.el, { x: 100 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    await controls.finished;
    expect(f.animateCalls.length).toBe(0);
    expect(translateXSeries(f.writes).at(-1)).toBe(100);
  });

  it('reduced-motion перекрывает compositor: снап, Element.animate НЕ вызван', async () => {
    const f = fakeEl({}, true);
    const controls = animate(
      f.el,
      { x: 100 },
      { spring: SPRING, matchMedia: () => ({ matches: true }) },
    );
    expect(f.animateCalls.length).toBe(0);
    expect(translateXSeries(f.writes).at(-1)).toBe(100);
    await controls.finished;
  });

  it('reduced-policy снимается один раз на aggregate и не читает hostile WAAPI', async () => {
    let policyReads = 0;
    let capabilityReads = 0;
    const target = () => Object.defineProperty(fakeEl().el, 'animate', {
      get() {
        capabilityReads++;
        throw new Error('WAAPI capability не должна читаться в reduced-policy');
      },
    });

    const controls = animate(
      [target(), target()],
      { x: 100 },
      {
        spring: SPRING,
        matchMedia: () => {
          policyReads++;
          return { matches: true };
        },
      },
    );

    expect({ policyReads, capabilityReads }).toEqual({ policyReads: 1, capabilityReads: 0 });
    await controls.finished;
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('повторный animate на compositor-ране: cancel старой Animation + новая с mid-flight from (C¹-ретаргет)', () => {
    const f = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    animate(f.el, { x: 100 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    now.advance(120); // mid-flight
    animate(f.el, { x: 300 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    expect(f.cancels).toBeGreaterThanOrEqual(1);
    expect(f.animateCalls.length).toBe(2);
    const kf = f.animateCalls[1]!.keyframes;
    const midFrom = readTranslateX(String(kf[0]!['transform']));
    expect(midFrom).toBeDefined();
    // from нового плана — аналитическое mid-flight значение (строго между 0 и 100).
    expect(midFrom!).toBeGreaterThan(0);
    expect(midFrom!).toBeLessThan(100);
    expect(kf[1]!['transform']).toBe('translateX(300px)');
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('finished compositor-рана резолвится по аналитическому settle (setTimer-шов) и обновляет реестр', async () => {
    const f = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    const controls = animate(f.el, { x: 100 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    expect(timer.pending().length).toBeGreaterThan(0);
    timer.fire();
    await controls.finished;
    // Реестр обновлён: следующий вызов стартует с осевшего значения.
    animate(f.el, { x: 200 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    const kf = f.animateCalls.at(-1)!.keyframes;
    expect(kf[0]!['transform']).toBe('translateX(100px)');
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('stagger на compositor-пути: нативный WAAPI-delay в timing', () => {
    const a = fakeEl({}, true);
    const b = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    animate([a.el, b.el], { x: 100 }, { spring: SPRING, stagger: 40, now: now.now, setTimer: timer.setTimer });
    expect(a.animateCalls.length).toBe(1);
    expect(b.animateCalls.length).toBe(1);
    expect(a.animateCalls[0]!.timing['delay'] ?? 0).toBe(0);
    expect(b.animateCalls[0]!.timing['delay']).toBe(40);
  });

  // @todo-R3c: waapi-plan-shape: пины формы старого compileSpringPlan/WaapiUnit; новая форма (2 кадра + linear() из IR) закреплена animate-compositor-unit.test.ts
  it.skip('cancel на compositor-ране: инлайн-фиксация текущего значения + cancel Animation (без отката к базе)', () => {
    const f = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    const controls = animate(f.el, { x: 100 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    now.advance(120);
    controls.cancel();
    expect(f.cancels).toBeGreaterThanOrEqual(1);
    // ДО cancel Animation значение зафиксировано инлайн — элемент не мигает к базе.
    const xs = translateXSeries(f.writes);
    expect(xs.length).toBeGreaterThan(0);
    expect(xs.at(-1)!).toBeGreaterThan(0);
    expect(xs.at(-1)!).toBeLessThan(100);
  });
});
