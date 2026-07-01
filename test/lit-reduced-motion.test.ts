/**
 * test/lit-reduced-motion.test.ts
 * Классы: А (unit CHARACTER-switch) + differential (reduce vs normal)
 *         + Д (mutation RED-proof).
 *
 * Invariant 4/5 — MotionController.setTarget() reduced-motion:
 *   CHARACTER-switch (snap-to-target, СИНХРОННО), НЕ hard-off, НЕ обычная
 *   multi-frame пружина. matchMedia — инъектируемый seam (как в ./driver),
 *   НЕ прямой window.matchMedia на верхнем уровне модуля.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Убрать ветку `if (prefersReducedMotion(...)) { this._value = target; ... return; }`
 * из MotionController.setTarget() (src/lit/controller.ts):
 *   → reduce=true передаст управление в this._mv.setTarget(target), который
 *     анимирует МНОГОКАДРОВО (requestUpdate вызывается >1 раз через onChange)
 *     вместо ровно 1 синхронного снэпа →
 *     тест «ровно 1 синхронный requestUpdate до дренажа очереди» = RED.
 *
 * Проверка ДО дренирования virtual-clock очереди — единственное место, где
 * reduce (синхронный снэп) строго отличим от normal (асинхронная пружина,
 * requestUpdate только после первого тика очереди).
 */

import { describe, expect, it } from 'vitest';
import { MotionController } from '../src/lit/controller.js';

const STD_SPRING = { mass: 1, stiffness: 100, damping: 20 };

function makeVirtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length; // ненулевой handle → без setTimeout-fallback
  };
  const drainAll = (max = 3000): void => {
    let i = 0;
    while (queue.length > 0 && i++ < max) {
      const cb = queue.shift()!;
      clock += 1000 / 60;
      cb(clock);
    }
  };
  return { requestFrame, drainAll };
}

function makeReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList =>
    ({
      matches: true,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

function makeNoReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList =>
    ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

function makeFakeHost() {
  let requestUpdateCalls = 0;
  const host = {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {
      requestUpdateCalls++;
    },
    updateComplete: Promise.resolve(true),
  };
  return { host, getCalls: () => requestUpdateCalls };
}

describe('MotionController reduced-motion: CHARACTER-switch (reduce=true)', () => {
  /**
   * Mutation RED (убрать reduce-ветку): setTarget уйдёт в _mv.setTarget →
   *   requestFrame планирует кадр, но НИЧЕГО не эмитируется синхронно (onChange
   *   ждёт первого tick очереди) → requestUpdateCalls===0 сразу после setTarget
   *   → тест `toBe(1)` (синхронно) падает.
   */
  it('setTarget: снэпает value синхронно и вызывает requestUpdate РОВНО 1 раз до drain', () => {
    const clock = makeVirtualClock();
    const { host, getCalls } = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      matchMedia: makeReduceMedia(),
    });

    // hostConnected эмитирует initial value синхронно (onChange contract) — сбрасываем счётчик.
    controller.hostConnected();
    const callsBeforeSetTarget = getCalls();

    controller.setTarget(100);

    // ─── СИНХРОННАЯ проверка (до drain очереди) ──────────────────────────────
    expect(controller.value, 'reduce: value снэпнуто к target синхронно').toBe(100);
    expect(
      getCalls() - callsBeforeSetTarget,
      'reduce: ровно 1 доп. requestUpdate (синхронный снэп, без rAF)',
    ).toBe(1);

    clock.drainAll();

    // После drain состояние не меняется — пружина не была задействована.
    expect(controller.value, 'после drain: value не изменилось').toBe(100);
  });

  it('не hard-off: value реально достигает target (не остаётся на initial)', () => {
    const clock = makeVirtualClock();
    const { host } = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      matchMedia: makeReduceMedia(),
    });
    controller.hostConnected();

    controller.setTarget(100);

    // Hard-off бы означал value осталось 0 (initial) — здесь оно 100.
    expect(controller.value).not.toBe(0);
    expect(controller.value).toBe(100);
  });

  it('value всегда конечно (CSS-safe) даже при экстремальных target', () => {
    const clock = makeVirtualClock();
    const { host } = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      matchMedia: makeReduceMedia(),
    });
    controller.hostConnected();
    controller.setTarget(1e300);
    expect(Number.isFinite(controller.value)).toBe(true);
  });
});

describe('MotionController: нормальная анимация (reduce=false)', () => {
  it('setTarget: НЕ снэпает синхронно — value остаётся на initial до drain', () => {
    const clock = makeVirtualClock();
    const { host, getCalls } = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      matchMedia: makeNoReduceMedia(),
    });
    controller.hostConnected();
    const callsBefore = getCalls();

    controller.setTarget(100);

    // Normal path: пружина ещё не сделала ни одного тика — value НЕ изменилось.
    expect(controller.value, 'normal: value не меняется синхронно').toBe(0);
    expect(getCalls() - callsBefore, 'normal: requestUpdate не вызван синхронно').toBe(0);

    clock.drainAll();

    // После drain пружина сошлась к target.
    expect(controller.value, 'normal: после drain пружина сошлась к target').toBe(100);
    expect(getCalls() - callsBefore, 'normal: requestUpdate вызван много раз (multi-frame)').toBeGreaterThan(1);
  });
});

describe('MotionController: differential reduce vs normal (синхронная граница)', () => {
  it('reduce: requestUpdate++ синхронно; normal: requestUpdate синхронно НЕ меняется', () => {
    const reduceClock = makeVirtualClock();
    const normalClock = makeVirtualClock();
    const reduceHost = makeFakeHost();
    const normalHost = makeFakeHost();

    const reduceController = new MotionController(reduceHost.host, 0, {
      spring: STD_SPRING,
      requestFrame: reduceClock.requestFrame,
      matchMedia: makeReduceMedia(),
    });
    reduceController.hostConnected();
    const reduceBefore = reduceHost.getCalls();

    const normalController = new MotionController(normalHost.host, 0, {
      spring: STD_SPRING,
      requestFrame: normalClock.requestFrame,
      matchMedia: makeNoReduceMedia(),
    });
    normalController.hostConnected();
    const normalBefore = normalHost.getCalls();

    reduceController.setTarget(100);
    normalController.setTarget(100);

    expect(reduceHost.getCalls() - reduceBefore, 'reduce: +1 синхронно').toBe(1);
    expect(normalHost.getCalls() - normalBefore, 'normal: +0 синхронно').toBe(0);
  });
});

describe('MotionController: SSR/Node без matchMedia (нет window)', () => {
  it('без явного matchMedia и без window — reduced-motion трактуется как false (не бросает)', () => {
    const clock = makeVirtualClock();
    const { host } = makeFakeHost();
    // typeof window === 'undefined' в этом test-окружении (vitest environment: 'node').
    expect(typeof window).toBe('undefined');

    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      // matchMedia не передан.
    });
    controller.hostConnected();

    expect(() => controller.setTarget(50)).not.toThrow();
    // Без reduce-preference — обычная (async) пружина, value ещё не 50 синхронно.
    expect(controller.value).toBe(0);

    clock.drainAll();
    expect(controller.value).toBe(50);
  });
});
