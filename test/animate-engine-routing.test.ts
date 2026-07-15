/**
 * Маршрутизация фасада ./animate (R3b, WAAPI-first strict) — пины решений
 * на вызов: reduced → снап-план; WAAPI + представимая кривая → юнит R2
 * (ноль работы main-потока, engine не зовётся); непредставимая группа →
 * композируемый engine, а без него — валидированный снап к финалу.
 *
 * Замена route-sum старых тиров (main/compositor/reduced счётчики):
 * арифметика планировщика закреплена animate-compositor-plan.test.ts,
 * здесь — наблюдаемая маршрутная поверхность фасада.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate, type AnimateEngine } from '../src/animate/index.js';
import { liveEngine } from '../src/animate/live.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { fakeEl, makeClock, makeNow, makeTimer } from './animate-facade-helpers.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

beforeEach(() => {
  __resetDetectionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

function spyEngine(): { engine: AnimateEngine; calls: Parameters<AnimateEngine>[0][] } {
  const calls: Parameters<AnimateEngine>[0][] = [];
  const engine: AnimateEngine = (group, context) => {
    calls.push(group);
    return liveEngine(group, context);
  };
  return { engine, calls };
}

describe('animate маршрутизация: WAAPI-путь не зовёт engine', () => {
  it('представимая группа на WAAPI-цели едет юнитом; engine молчит', async () => {
    const target = fakeEl({}, true);
    const { engine, calls } = spyEngine();
    const now = makeNow();
    const timer = makeTimer();
    const controls = animate(target.el, { x: 100, opacity: [1, 0] }, {
      spring: SPRING,
      engine,
      now: now.now,
      setTimer: timer.setTimer,
    });
    await Promise.resolve(); // microtask-коммит юнитов R2

    expect(calls).toHaveLength(0);
    expect(target.animateCalls).toHaveLength(2); // transform + opacity
    expect(target.writes).toHaveLength(0); // ноль main-thread записей
    controls.cancel();
  });

  it('reduced побеждает маршрут целиком: снап без юнита, engine и кадров', async () => {
    const target = fakeEl({}, true);
    const { engine, calls } = spyEngine();
    const requestFrame = vi.fn(() => 1);
    let completed = 0;
    const controls = animate(target.el, { x: 100 }, {
      spring: SPRING,
      engine,
      requestFrame,
      matchMedia: () => ({ matches: true }),
      onComplete: () => completed++,
    });

    expect(calls).toHaveLength(0);
    expect(target.animateCalls).toHaveLength(0);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(target.writes).toEqual([
      { prop: 'transform', value: 'translateX(100px)' },
    ]);
    await controls.finished;
    expect(completed).toBe(1);
  });
});

describe('animate маршрутизация: непредставимая группа без engine — валидированный снап', () => {
  it('среда без WAAPI: мгновенный финал, finished резолвится, onComplete natural', async () => {
    const target = fakeEl({ width: '0px' });
    const requestFrame = vi.fn(() => 1);
    let completed = 0;
    const controls = animate(target.el, { x: [0, 100], width: '100px' }, {
      spring: SPRING,
      requestFrame,
      onComplete: () => completed++,
    });

    // Снап — та же семантика, что политика reduced: стиль = финал, ноль кадров.
    expect(requestFrame).not.toHaveBeenCalled();
    expect(target.writes).toContainEqual({
      prop: 'transform',
      value: 'translateX(100px)',
    });
    expect(target.writes).toContainEqual({ prop: 'width', value: '100px' });
    await controls.finished;
    expect(completed).toBe(1);
  });
});

describe('animate маршрутизация: engine зовётся ровно для непредставимых групп', () => {
  it('смешанный вызов: WAAPI-цель едет юнитом, цель без WAAPI — engine', async () => {
    const waapi = fakeEl({}, true);
    const bare = fakeEl();
    const { engine, calls } = spyEngine();
    const clock = makeClock();
    const now = makeNow();
    const timer = makeTimer();
    const controls = animate([waapi.el, bare.el], { x: 100 }, {
      spring: SPRING,
      engine,
      now: now.now,
      setTimer: timer.setTimer,
      requestFrame: clock.requestFrame,
    });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.el).toBe(bare.el);
    expect(calls[0]!.reason).toBe('no-waapi');
    expect(waapi.animateCalls).toHaveLength(1);
    controls.cancel();
  });

  it('v0-mismatch на WAAPI-цели: группа честно уходит в engine', async () => {
    const target = fakeEl({}, true);
    const { engine, calls } = spyEngine();
    const clock = makeClock();
    const now = makeNow();
    const timer = makeTimer();
    animate(target.el, { x: 100 }, {
      spring: SPRING,
      engine,
      now: now.now,
      setTimer: timer.setTimer,
      requestFrame: clock.requestFrame,
    });
    await Promise.resolve(); // физический старт юнита (microtask-коммит)
    now.advance(100); // середина полёта: x несёт импульс

    // y холодный (v0=0), x — с импульсом: единой WAAPI-кривой группы нет.
    const second = animate(target.el, { x: 200, y: 300 }, {
      spring: SPRING,
      engine,
      now: now.now,
      setTimer: timer.setTimer,
      requestFrame: clock.requestFrame,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.reason).toBe('v0-mismatch');
    expect(calls[0]!.el).toBe(target.el);
    second.cancel();
  });
});
