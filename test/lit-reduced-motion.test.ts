/**
 * MotionController reduced-motion CHARACTER-switch.
 *
 * The matchMedia seam is query-sensitive: asking any feature other than
 * `(prefers-reduced-motion: reduce)` returns false, so a wrong production query
 * is observably different from a correct reduced-motion read.
 */

import { describe, expect, it } from 'vitest';
import { MotionController } from '../src/lit/controller.js';
import { REDUCED_MOTION_QUERY, reducedMotionMedia } from './helpers/reduced-motion.js';

const STD_SPRING = { mass: 1, stiffness: 100, damping: 20 };

function makeVirtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length;
  };
  const drain = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      const cb = queue.shift();
      if (!cb) break;
      clock += 1000 / 60;
      cb(clock);
    }
  };
  const drainAll = (max = 3000): void => {
    let i = 0;
    while (queue.length > 0 && i++ < max) drain(1);
  };
  return { requestFrame, drain, drainAll };
}

const makeReduceMedia = () => reducedMotionMedia(true);
const makeNoReduceMedia = () => reducedMotionMedia(false);

function makeToggleableMedia(): {
  fn: (query: string) => MediaQueryList;
  setReduce: (v: boolean) => void;
} {
  let reduce = false;
  const fn = (query: string): MediaQueryList => ({
    ...reducedMotionMedia(query === REDUCED_MOTION_QUERY ? reduce : false)(query),
    matches: query === REDUCED_MOTION_QUERY ? reduce : false,
  });
  return { fn, setReduce: (v: boolean) => { reduce = v; } };
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
  it('setTarget: снэпает value синхронно и вызывает requestUpdate РОВНО 1 раз до drain', () => {
    const clock = makeVirtualClock();
    const { host, getCalls } = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      matchMedia: makeReduceMedia(),
    });

    controller.hostConnected();
    const callsBeforeSetTarget = getCalls();
    controller.setTarget(100);

    expect(controller.value).toBe(100);
    expect(getCalls() - callsBeforeSetTarget).toBe(1);
    clock.drainAll();
    expect(controller.value).toBe(100);
  });

  it('не hard-off: value реально достигает target', () => {
    const clock = makeVirtualClock();
    const { host } = makeFakeHost();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      matchMedia: makeReduceMedia(),
    });
    controller.hostConnected();
    controller.setTarget(100);
    expect(controller.value).toBe(100);
  });

  it('value всегда конечно даже при экстремальных target', () => {
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
    expect(controller.value).toBe(0);
    expect(getCalls() - callsBefore).toBe(0);

    clock.drainAll();
    expect(controller.value).toBe(100);
    expect(getCalls() - callsBefore).toBeGreaterThan(1);
  });
});

describe('MotionController: differential reduce vs normal', () => {
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

    expect(reduceHost.getCalls() - reduceBefore).toBe(1);
    expect(normalHost.getCalls() - normalBefore).toBe(0);
  });
});

describe('MotionController: reduce включается СРЕДИ полёта пружины', () => {
  it('снэп к reduced-target не переписывается зависшим кадром старой пружины', () => {
    const clock = makeVirtualClock();
    const { host } = makeFakeHost();
    const media = makeToggleableMedia();
    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
      matchMedia: media.fn,
    });
    controller.hostConnected();

    controller.setTarget(100);
    clock.drain(1);
    expect(controller.value).not.toBe(100);

    media.setReduce(true);
    controller.setTarget(50);
    expect(controller.value).toBe(50);

    clock.drainAll();
    expect(controller.value).toBe(50);
  });
});

describe('MotionController: SSR/Node без matchMedia', () => {
  it('без явного matchMedia и без window — reduced-motion трактуется как false', () => {
    const clock = makeVirtualClock();
    const { host } = makeFakeHost();
    expect(typeof window).toBe('undefined');

    const controller = new MotionController(host, 0, {
      spring: STD_SPRING,
      requestFrame: clock.requestFrame,
    });
    controller.hostConnected();

    expect(() => controller.setTarget(50)).not.toThrow();
    expect(controller.value).toBe(0);
    clock.drainAll();
    expect(controller.value).toBe(50);
  });
});
