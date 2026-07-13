/**
 * Транзакционные границы WAAPI-юнита фасада: host-швы могут бросать или
 * завершать прогон до возврата конструктора, но реестр и compositor не должны
 * сохранять полусозданного владельца.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/index.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { sampleSerializedSpring } from '../src/compositor/sample.js';
import { MotionParamError } from '../src/errors.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';
import { spring } from '../src/tokens/index.js';
import { fakeEl, makeClock, makeTimer, translateXSeries } from './animate-facade-helpers.js';

beforeEach(() => {
  __resetDetectionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

function executionSnapshot(
  physics: SpringParams,
  from: number,
  to: number,
  tMs: number,
): { value: number; velocity: number } {
  const artifact = compileSpringExecutionArtifactUnchecked(
    physics,
    0,
    DEFAULT_TOLERANCE,
  );
  const sample = sampleSerializedSpring(
    artifact.samples,
    settleTimeUpperBound(physics, 0) * 1000,
    tMs,
  );
  return {
    value: (1 - sample.value) * from + sample.value * to,
    velocity: sample.velocity * to - sample.velocity * from,
  };
}

function firstSlope(linear: string, durationMs: number): number {
  const [, stop] = linear.slice(7, -1).split(', ');
  const [progress, percent] = stop!.split(' ');
  return Number(progress) / (Number(percent!.slice(0, -1)) / 100 * durationMs / 1000);
}

function firstSerializedTargetCrossingMs(physics: SpringParams): number {
  const artifact = compileSpringExecutionArtifactUnchecked(
    physics,
    0,
    DEFAULT_TOLERANCE,
  );
  const samples = artifact.samples;
  const durationMs = settleTimeUpperBound(physics, 0) * 1000;
  for (let i = 0; i + 3 < samples.length; i += 2) {
    const p0 = samples[i + 1]!;
    const p1 = samples[i + 3]!;
    if (p0 < 1 && p1 >= 1) {
      const u = (1 - p0) / (p1 - p0);
      return (samples[i]! + u * (samples[i + 2]! - samples[i]!)) / 100 * durationMs;
    }
  }
  throw new Error('serialized target crossing not found');
}

function nextDown(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return view.getFloat64(0);
}

describe('animate: жизненный цикл WAAPI-юнита', () => {
  it('валидный native currentTime не трогает бросающий fallback now', () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel: () => { target.cancels++; },
        currentTime: 100,
      } as { cancel: () => void };
    };
    let nowCalls = 0;
    animate(target.el, { x: [0, 100] }, {
      spring: physics,
      now: () => {
        if (nowCalls++ === 0) return 0;
        throw new Error('fallback clock unavailable');
      },
      setTimer: () => () => {},
    });

    delete target.el.animate;
    const clock = makeClock();
    const next = animate(target.el, { x: 200 }, {
      spring: physics,
      requestFrame: clock.requestFrame,
    });
    expect(nowCalls).toBe(1);
    clock.step(16);
    expect(translateXSeries(target.writes).at(-1))
      .toBeCloseTo(executionSnapshot(physics, 0, 100, 100).value, 10);
    next.cancel();
  });

  it('live-delegate после неудачного play остаётся повторяемо paused', () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    let queue: Array<(ts?: number) => void> = [];
    let fail = false;
    const requestFrame = (cb: (ts?: number) => void): number => {
      if (fail) throw new Error('delegate resume failed');
      queue.push(cb);
      return 1;
    };
    const emit = (ts: number): void => {
      const batch = queue;
      queue = [];
      for (const cb of batch) cb(ts);
    };
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame,
    });
    controls.seek(firstSerializedTargetCrossingMs(physics));
    controls.pause();
    emit(0); // гасит callback остановленного delegate

    fail = true;
    expect(() => controls.play()).toThrow('delegate resume failed');
    fail = false;
    controls.play();
    expect(queue).toHaveLength(1);
    controls.cancel();
  });

  it('paused WAAPI после сбоя now при replay допускает повторный play', async () => {
    const target = fakeEl({}, true);
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel: () => { target.cancels++; },
        currentTime: 100,
      } as { cancel: () => void };
    };
    let nowCalls = 0;
    let failResume = true;
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => {
        if (nowCalls++ === 0) return 0;
        if (failResume) {
          failResume = false;
          throw new Error('resume clock failed');
        }
        return 100;
      },
      setTimer: () => () => {},
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });
    controls.pause();

    expect(() => controls.play()).toThrow('resume clock failed');
    expect(target.animateCalls).toHaveLength(1);
    for (let index = 0; index < 3; index++) await Promise.resolve();
    expect(settled).toBe(false);
    controls.play();
    expect(target.animateCalls).toHaveLength(2);
    controls.cancel();
  });

  it('active seek после сбоя now терминализирует снятый effect и освобождает owner', async () => {
    const target = fakeEl({}, true);
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel: () => { target.cancels++; },
        currentTime: 100,
      } as { cancel: () => void; currentTime: number };
    };
    const cancelTimer = vi.fn();
    const onComplete = vi.fn();
    let nowCalls = 0;
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => {
        if (nowCalls++ === 0) return 0;
        throw new Error('active seek clock failed');
      },
      setTimer: () => cancelTimer,
      onComplete,
    });

    expect(() => controls.seek(100)).toThrow('active seek clock failed');
    await expect(controls.finished).resolves.toBeUndefined();
    expect(target.cancels).toBe(1);
    expect(cancelTimer).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    const next = animate(target.el, { x: 200 }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => 0,
      setTimer: () => () => {},
    });
    expect(target.animateCalls).toHaveLength(2);
    next.cancel();
  });

  it('initial now-сбой не создаёт effect и не оставляет owner', () => {
    const target = fakeEl({}, true);

    expect(() => animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => { throw new Error('initial clock failed'); },
      setTimer: () => () => {},
    })).toThrow('initial clock failed');
    expect(target.animateCalls).toHaveLength(0);
    expect(target.cancels).toBe(0);

    const next = animate(target.el, { x: 200 }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => 0,
      setTimer: () => () => {},
    });
    expect(target.animateCalls).toHaveLength(1);
    next.cancel();
  });

  it('paused WAAPI после сбоя Element.animate при replay остаётся повторяемо живым', async () => {
    const target = fakeEl({}, true);
    const initialCancel = vi.fn();
    const recoveredCancel = vi.fn();
    let animateCalls = 0;
    let failReplay = true;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      animateCalls++;
      if (animateCalls === 2 && failReplay) throw new Error('replay animate failed');
      return {
        cancel: animateCalls === 1 ? initialCancel : recoveredCancel,
        currentTime: 100,
      } as { cancel: () => void; currentTime: number };
    };
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => 0,
      setTimer: () => () => {},
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });
    controls.pause();

    expect(() => controls.play()).toThrow('replay animate failed');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(initialCancel).toHaveBeenCalledTimes(1);

    failReplay = false;
    controls.play();
    expect(animateCalls).toBe(3);
    await Promise.resolve();
    expect(settled).toBe(false);

    controls.cancel();
    expect(recoveredCancel).toHaveBeenCalledTimes(1);
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('paused WAAPI очищает частичный replay после сбоя setTimer и допускает retry', async () => {
    const target = fakeEl({}, true);
    const animationCancels = [vi.fn(), vi.fn(), vi.fn()];
    let animateCalls = 0;
    let failedTimerCallback: (() => void) | undefined;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      const index = animateCalls++;
      if (index === 2) failedTimerCallback!(); // stale callback реентрантен в retry
      return {
        cancel: animationCancels[index],
        currentTime: 100,
      } as { cancel: () => void; currentTime: number };
    };
    const timerCancels = [vi.fn(), vi.fn()];
    let timerCalls = 0;
    const onComplete = vi.fn();
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => 0,
      onComplete,
      setTimer: (callback) => {
        timerCalls++;
        if (timerCalls === 2) {
          failedTimerCallback = callback;
          callback();
          throw new Error('replay timer failed');
        }
        return timerCancels[timerCalls === 1 ? 0 : 1]!;
      },
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });
    controls.pause();

    expect(() => controls.play()).toThrow('replay timer failed');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(animationCancels[1]).toHaveBeenCalledTimes(1);

    controls.play();
    expect(animateCalls).toBe(3);
    expect(timerCalls).toBe(3);
    failedTimerCallback!(); // отменённый host-callback не трогает новый replay
    for (let index = 0; index < 3; index++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    controls.cancel();
    expect(animationCancels[2]).toHaveBeenCalledTimes(1);
    expect(timerCancels[1]).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('stale timer не завершает replay, даже если host переиспользует cancel-функцию', async () => {
    const target = fakeEl({}, true);
    const animationCancels = [vi.fn(), vi.fn()];
    let animateCalls = 0;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      const index = animateCalls++;
      return {
        cancel: animationCancels[index],
        currentTime: 100,
      } as { cancel: () => void; currentTime: number };
    };
    const callbacks: Array<() => void> = [];
    const sharedCancel = vi.fn();
    const onComplete = vi.fn();
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => 0,
      setTimer: (callback) => {
        callbacks.push(callback);
        return sharedCancel;
      },
      onComplete,
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });
    controls.pause();
    controls.play();

    callbacks[0]!();
    for (let index = 0; index < 3; index++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(animationCancels[1]).not.toHaveBeenCalled();

    controls.cancel();
    expect(sharedCancel).toHaveBeenCalledTimes(2);
    expect(animationCancels[1]).toHaveBeenCalledTimes(1);
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('active seek после host-сбоя остаётся терминальным, когда старый effect уже снят', async () => {
    const target = fakeEl({}, true);
    const animationCancels = [vi.fn(), vi.fn()];
    let animateCalls = 0;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      const index = animateCalls++;
      return {
        cancel: animationCancels[index],
        currentTime: 100,
      } as { cancel: () => void; currentTime: number };
    };
    let timerCalls = 0;
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => 0,
      setTimer: () => {
        if (++timerCalls === 2) throw new Error('active seek timer failed');
        return () => {};
      },
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    expect(() => controls.seek(100)).toThrow('active seek timer failed');
    for (let index = 0; index < 3; index++) await Promise.resolve();

    expect(settled).toBe(true);
    expect(animationCancels[0]).toHaveBeenCalledTimes(1);
    expect(animationCancels[1]).toHaveBeenCalledTimes(1);
  });

  it('pause → play корректно завершает replay с синхронным setTimer', async () => {
    const target = fakeEl({}, true);
    const firstCancel = vi.fn();
    const replayCancel = vi.fn();
    const onComplete = vi.fn();
    let timerCalls = 0;
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => 0,
      setTimer: (callback) => {
        timerCalls++;
        if (timerCalls === 1) return firstCancel;
        callback();
        return replayCancel;
      },
      onComplete,
    });
    controls.pause();
    controls.play();

    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(replayCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('невалидный native currentTime и бросающий now дают pre-start без импульса', () => {
    const target = fakeEl({}, true);
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        cancel: () => { target.cancels++; },
        currentTime: NaN,
      } as { cancel: () => void };
    };
    let nowCalls = 0;
    animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      now: () => {
        if (nowCalls++ === 0) return 0;
        throw new Error('fallback clock unavailable');
      },
      setTimer: () => () => {},
    });

    delete target.el.animate;
    const clock = makeClock();
    const next = animate(target.el, { x: 200 }, {
      spring: spring.default,
      requestFrame: clock.requestFrame,
    });
    clock.step(16);
    clock.step(16);
    expect(translateXSeries(target.writes).at(-1))
      .toBeCloseTo(readCompositorSpring(spring.default, {
        from: 0,
        to: 200,
        v0: 0,
        t: 0.016,
      }).value, 8);
    next.cancel();
  });

  it.each([NaN, Infinity, -Infinity])(
    'нефинитный now=%s остаётся pre-start при delayed snapshot без native currentTime',
    (hostNow) => {
      const target = fakeEl({}, true);
      const clock = makeClock();
      const source = animate(target.el, { x: [0, 100] }, {
        duration: 400,
        ease: (t) => t,
        requestFrame: clock.requestFrame,
      });
      source.seek(200); // value=50, velocity=250 units/s

      animate(target.el, { x: 300 }, {
        spring: { mass: 1, stiffness: 100, damping: 10 },
        delay: 500,
        now: () => hostNow,
        setTimer: () => () => {},
      });
      const next = animate(target.el, { x: 500 }, {
        spring: { mass: 1, stiffness: 100, damping: 10 },
        now: () => hostNow,
        setTimer: () => () => {},
      });

      expect(target.animateCalls).toHaveLength(2);
      expect(target.animateCalls[1]!.keyframes[0]!['transform']).toBe('translateX(50px)');
      expect(target.animateCalls[1]!.keyframes.every((frame) =>
        !/NaN|Infinity/.test(String(frame['transform'])),
      )).toBe(true);
      next.cancel();
    },
  );

  it('active seek у serialized-пересечения цели сохраняет импульс через lazy live-handoff', () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    const clock = makeClock();
    let requests = 0;
    const controls = animate(target.el, { opacity: [0, 1] }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    // Чистый compositor не создаёт и не планирует frame-loop заранее.
    expect(requests).toBe(0);
    const crossingMs = firstSerializedTargetCrossingMs(physics);
    const expected = executionSnapshot(physics, 0, 1, crossingMs);
    controls.seek(crossingMs);

    expect(target.cancels).toBe(1);
    expect(target.animateCalls).toHaveLength(1);
    expect(requests).toBe(1);
    expect(Number(target.writes.at(-1)?.value)).toBe(1);

    clock.step(1); // t=0: C0
    const p0 = Number(target.writes.at(-1)?.value);
    clock.step(0.001);
    const p1 = Number(target.writes.at(-1)?.value);
    expect(p0).toBe(1);
    expect((p1 - p0) / 0.000001).toBeCloseTo(expected.velocity, 4);
    controls.cancel();
  });

  it('pause → seek(target crossing) не тикает до play и продолжает C1 в live', async () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    const crossingMs = firstSerializedTargetCrossingMs(physics);
    const expected = executionSnapshot(physics, 0, 100, crossingMs);
    const clock = makeClock();
    let requests = 0;
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    controls.pause();
    controls.seek(crossingMs);
    expect(requests).toBe(0);
    expect(translateXSeries(target.writes).at(-1)).toBe(100);
    clock.step(16);
    expect(requests).toBe(0);

    controls.play();
    expect(requests).toBe(1);
    clock.step(1);
    const x0 = translateXSeries(target.writes).at(-1)!;
    clock.step(0.001);
    const x1 = translateXSeries(target.writes).at(-1)!;
    expect(x0).toBe(100);
    expect((x1 - x0) / 0.000001).toBeCloseTo(expected.velocity, 1);

    clock.drain(16);
    await controls.finished;
    expect(translateXSeries(target.writes).at(-1)).toBe(100);
  });

  it('два WAAPI-handoff делят один lazy frame-loop и aggregate завершается один раз', async () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    const clock = makeClock();
    const onComplete = vi.fn();
    let requests = 0;
    const controls = animate(target.el, { x: [0, 100], opacity: [0, 1] }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      onComplete,
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    expect(target.animateCalls).toHaveLength(2);
    expect(requests).toBe(0);
    controls.seek(firstSerializedTargetCrossingMs(physics));
    expect(target.cancels).toBe(2);
    expect(target.animateCalls).toHaveLength(2);
    expect(requests).toBe(1);

    clock.drain(16, 5_000);
    await controls.finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('wrapper-owner после live-handoff отдаёт снимок повторному animate и завершает первый aggregate', async () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    const clock = makeClock();
    const first = animate(target.el, { x: [0, 100] }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame: clock.requestFrame,
    });
    first.seek(firstSerializedTargetCrossingMs(physics));
    clock.step(1);

    const second = animate(target.el, { x: 200 }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame: clock.requestFrame,
    });

    await first.finished;
    expect(target.animateCalls).toHaveLength(2);
    const from = Number(
      /translateX\((-?[\d.eE+]+)px\)/.exec(
        String(target.animateCalls[1]!.keyframes[0]!['transform']),
      )?.[1],
    );
    expect(from).toBe(100);
    second.cancel();
  });

  it('adjacent-MAX outward impulse fail-closed сохраняет старую Animation', () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 1, damping: 1 };
    const from = nextDown(Number.MAX_VALUE);
    const clock = makeClock();
    let requests = 0;
    const controls = animate(target.el, { x: [from, Number.MAX_VALUE] }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    try {
      controls.seek(firstSerializedTargetCrossingMs(physics));
      expect.fail('ожидался MotionParamError');
    } catch (error) {
      expect(error).toBeInstanceOf(MotionParamError);
      expect((error as MotionParamError).code).toBe('LM150');
    }
    expect(target.cancels).toBe(0);
    expect(target.animateCalls).toHaveLength(1);
    expect(requests).toBe(0);
    expect(target.writes.every(({ value }) => !/NaN|Infinity/.test(value))).toBe(true);
    controls.cancel();
  });

  it('ошибка requestFrame при dynamic handoff терминализирует wrapper и сохраняет held state', async () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    const onComplete = vi.fn();
    const controls = animate(target.el, { x: [0, 100] }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
      onComplete,
      requestFrame() {
        throw new Error('frame host failed');
      },
    });

    expect(() => controls.seek(firstSerializedTargetCrossingMs(physics)))
      .toThrow('frame host failed');
    expect(target.cancels).toBe(1);
    expect(translateXSeries(target.writes).at(-1)).toBe(100);
    await controls.finished;
    expect(onComplete).not.toHaveBeenCalled();

    const next = animate(target.el, { x: 200 }, {
      spring: physics,
      now: () => 0,
      setTimer: () => () => {},
    });
    expect(target.animateCalls).toHaveLength(2);
    expect(target.animateCalls[1]!.keyframes[0]!['transform'])
      .toBe('translateX(100px)');
    next.cancel();
  });

  it('скорость вне бюджета кривой бесшовно уходит в один живой frame-loop', async () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    let now = 0;
    animate(target.el, { x: [0, 100] }, {
      spring: physics,
      now: () => now,
      setTimer: () => () => {},
    });
    expect(target.animateCalls).toHaveLength(1);

    now = 100;
    const snapshot = executionSnapshot(physics, 0, 100, 100);
    const clock = makeClock();
    let requests = 0;
    const controls = animate(target.el, { x: snapshot.value + 1.01e-10 }, {
      spring: physics,
      now: () => now,
      setTimer: () => () => {},
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    // Старый compositor-владелец прерван только после полного preflight; новая
    // гигантская нормализованная скорость не строит вторую WAAPI-кривую.
    expect(target.cancels).toBe(1);
    expect(target.animateCalls).toHaveLength(1);
    expect(requests).toBe(1);

    clock.step(1); // t=0: C0
    const x0 = translateXSeries(target.writes).at(-1)!;
    expect(x0).toBeCloseTo(snapshot.value, 10);
    clock.step(0.001);
    const x1 = translateXSeries(target.writes).at(-1)!;
    expect((x1 - x0) / 0.000001).toBeCloseTo(snapshot.velocity, 1); // C1

    clock.drain(16);
    await controls.finished;
    expect(translateXSeries(target.writes).at(-1)).toBe(snapshot.value + 1.01e-10);
  });

  it('нулевой новый range сохраняет абсолютный импульс в live, а не обнуляет v0', async () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 100, damping: 10 };
    let now = 0;
    animate(target.el, { x: [0, 100] }, {
      spring: physics,
      now: () => now,
      setTimer: () => () => {},
    });
    now = 100;
    const snapshot = executionSnapshot(physics, 0, 100, 100);
    const clock = makeClock();
    const controls = animate(target.el, { x: snapshot.value }, {
      spring: physics,
      now: () => now,
      requestFrame: clock.requestFrame,
    });

    expect(target.animateCalls).toHaveLength(1);
    expect(target.cancels).toBe(1);
    clock.step(1);
    const x0 = translateXSeries(target.writes).at(-1)!;
    clock.step(0.001);
    const x1 = translateXSeries(target.writes).at(-1)!;
    expect(x0).toBe(snapshot.value);
    expect((x1 - x0) / 0.000001).toBeCloseTo(snapshot.velocity, 1);
    clock.drain(16, 5_000);
    await controls.finished;
    expect(translateXSeries(target.writes).at(-1)).toBe(snapshot.value);
  });

  it('live fallback ждёт физический v0-horizon, а не телепортирует на 2000-м кадре', async () => {
    const target = fakeEl({}, true);
    const physics = { mass: 1, stiffness: 1, damping: 1 };
    let now = 0;
    animate(target.el, { x: [0, 100_000] }, {
      spring: physics,
      now: () => now,
      setTimer: () => () => {},
    });
    now = 100;
    const snapshot = executionSnapshot(physics, 0, 100_000, 100);
    const targetValue = snapshot.value + 2e-10;
    const clock = makeClock();
    const controls = animate(target.el, { x: targetValue }, {
      spring: physics,
      now: () => now,
      requestFrame: clock.requestFrame,
    });

    const frames = clock.drain(1000 / 144, 20_000);
    await controls.finished;
    const values = translateXSeries(target.writes);
    expect(frames).toBeGreaterThan(2_000);
    expect(values.at(-1)).toBe(targetValue);
    expect(Math.abs(values.at(-2)! - targetValue)).toBeLessThan(0.01);
  });

  it('отменяет уже созданную Animation, если setTimer бросает', () => {
    const target = fakeEl({}, true);

    expect(() => animate(target.el, { x: 100 }, {
      spring: spring.default,
      setTimer: () => {
        throw new Error('timer host failed');
      },
    })).toThrow('timer host failed');

    expect(target.animateCalls).toHaveLength(1);
    expect(target.cancels).toBe(1);
  });

  it('не оставляет завершённый синхронно юнит владельцем группы', async () => {
    const target = fakeEl({}, true);
    const cancelTimer = vi.fn();
    const controls = animate(target.el, { x: 100 }, {
      spring: spring.default,
      setTimer: (callback) => {
        callback();
        return cancelTimer;
      },
    });

    await expect(controls.finished).resolves.toBeUndefined();
    expect(cancelTimer).toHaveBeenCalledTimes(1);

    const timer = makeTimer();
    animate(target.el, { x: 200 }, {
      spring: spring.default,
      setTimer: timer.setTimer,
    });
    expect(target.animateCalls.at(-1)!.keyframes[0]!['transform'])
      .toBe('translateX(100px)');
  });

  it('в WebKit сохраняет overshoot явных transform-кадров', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    });
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) });
    __resetDetectionCache();
    const target = fakeEl({}, true);

    const controls = animate(target.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 170, damping: 10 },
      setTimer: () => () => {},
    });

    const call = target.animateCalls[0]!;
    expect(call.timing['easing']).toBe('linear');
    const values = call.keyframes.map((frame) => {
      const match = /translateX\((-?[\d.eE+]+)px\)/.exec(String(frame['transform']));
      return Number(match?.[1]);
    });
    expect(values.some((value) => value > 100)).toBe(true);
    controls.cancel();
  });

  it('снимает конечное mid-flight значение на диапазоне MAX ↔ -MAX', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    });
    __resetDetectionCache();
    const target = fakeEl({}, true);
    const max = Number.MAX_VALUE;
    const controls = animate(target.el, { x: [max, -max] }, {
      spring: spring.default,
      now: () => 0,
      setTimer: () => () => {},
    });

    controls.seek(100);
    const start = String(target.animateCalls.at(-1)!.keyframes[0]!['transform']);
    const value = Number(/translateX\((-?[\d.eE+]+)px\)/.exec(start)?.[1]);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).not.toBe(-max);
    controls.cancel();
  });

  it('pause/play использует native currentTime и переносит actual piecewise C0/C1', () => {
    const physics = { mass: 1, stiffness: 170, damping: 26 };
    const currentTime = 372.096622;
    let now = 0;
    const calls: Array<{
      keyframes: Record<string, string | number>[];
      timing: Record<string, unknown>;
    }> = [];
    const writes: number[] = [];
    const el = {
      style: {
        getPropertyValue: () => '0',
        setProperty(name: string, value: string) {
          if (name === 'opacity') writes.push(Number(value));
        },
      },
      animate(
        keyframes: Record<string, string | number>[],
        timing: Record<string, unknown>,
      ) {
        calls.push({ keyframes, timing });
        return {
          get currentTime() { return currentTime; },
          cancel() {},
        };
      },
    };
    const controls = animate(el, { opacity: [0, 1] }, {
      spring: physics,
      now: () => now,
      setTimer: () => () => {},
    });
    now = 100_000;
    controls.pause();

    const expected = executionSnapshot(physics, 0, 1, currentTime);
    expect(writes.at(-1)).toBe(expected.value);
    controls.play();
    expect(calls[1]!.keyframes[0]!['opacity']).toBe(expected.value);
    const seeded = firstSlope(
      String(calls[1]!.timing['easing']),
      Number(calls[1]!.timing['duration']),
    );
    expect(seeded * (1 - expected.value)).toBeCloseTo(expected.velocity, 12);
    controls.cancel();
  });
});
