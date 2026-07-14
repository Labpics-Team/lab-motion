import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelAt, sharedV0, type NumericChannel } from '../src/animate/channels.js';
import { animate, type AnimateProps } from '../src/animate/index.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import { sampleSerializedSpring } from '../src/compositor/sample.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';
import {
  fakeEl,
  makeClock,
  makeNow,
  makeTimer,
  type StyleWrite,
} from './animate-facade-helpers.js';

const LINEAR = (value: number): number => value;
const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const UNDERDAMPED: SpringParams = { mass: 1, stiffness: 170, damping: 10 };

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

function lastTransform(writes: readonly StyleWrite[]): string {
  return writes.filter((write) => write.prop === 'transform').at(-1)?.value ?? '';
}

function scaleAxes(transform: string): { x: number; y: number } {
  const read = (name: string): number | undefined => {
    const match = new RegExp(`${name}\\(([^)]+)\\)`).exec(transform);
    return match === null ? undefined : Number(match[1]);
  };
  const uniform = read('scale');
  return {
    x: uniform ?? read('scaleX') ?? 1,
    y: uniform ?? read('scaleY') ?? 1,
  };
}

function scaleFrames(writes: readonly StyleWrite[], from = 0): { x: number; y: number }[] {
  return writes
    .filter((write) => write.prop === 'transform')
    .slice(from)
    .map((write) => scaleAxes(write.value));
}

describe('animate: конфликт uniform и осевого scale', () => {
  it('края сохраняют точные operands, включая знак IEEE-ноля', () => {
    const cases = [
      { from: -0, to: Number.MIN_VALUE, progress: 0, expected: -0 },
      { from: Number.MIN_VALUE, to: -0, progress: 1, expected: -0 },
      { from: -0, to: +0, progress: 1, expected: +0 },
      { from: +0, to: -0, progress: 1, expected: -0 },
    ];
    for (const { from, to, progress, expected } of cases) {
      const channel = { _from: from, _to: to } as NumericChannel;
      expect(Object.is(channelAt(channel, progress), expected)).toBe(true);
    }
  });

  it('точный static-канал неподвижен для любого конечного progress', () => {
    const values = [
      -Number.MAX_VALUE,
      -1e308,
      -1,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1,
      1e308,
      Number.MAX_VALUE,
    ];
    const progress = [
      -Number.MAX_VALUE,
      -1e308,
      -1,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      0.5,
      1,
      2,
      1e308,
      Number.MAX_VALUE,
    ];
    for (const value of values) {
      const staticChannel = {
        _from: value,
        _to: value,
      } as NumericChannel;
      for (const p of progress) {
        expect(Object.is(channelAt(staticChannel, p), value)).toBe(true);
      }
    }
  });

  it('WebKit не создаёт 1-ULP траекторию для static MAX scale-оси', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    });
    __resetDetectionCache();
    const target = fakeEl({}, true);
    const controls = animate(target.el, {
      scaleX: [1, 2],
      scaleY: [Number.MAX_VALUE, Number.MAX_VALUE],
    }, {
      spring: UNDERDAMPED,
      setTimer: () => () => {},
    });

    const scaleYValues = target.animateCalls[0]!.keyframes.map((frame) => {
      const token = /scaleY\(([^)]+)\)/.exec(String(frame.transform))?.[1];
      return Number(token);
    });
    expect([...new Set(scaleYValues)]).toEqual([Number.MAX_VALUE]);
    controls.cancel();
  });

  it('WebKit сохраняет знак ноля в первом и последнем явном кадре', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    });
    __resetDetectionCache();

    const endpoints = [
      { from: -0, to: Number.MIN_VALUE },
      { from: Number.MIN_VALUE, to: -0 },
      { from: -0, to: +0 },
      { from: +0, to: -0 },
    ];
    for (const { from, to } of endpoints) {
      const target = fakeEl({}, true);
      const controls = animate(target.el, { opacity: [from, to] }, {
        spring: UNDERDAMPED,
        setTimer: () => () => {},
      });
      const frames = target.animateCalls[0]!.keyframes;
      expect(Object.is(frames[0]!.opacity, from)).toBe(true);
      expect(Object.is(frames.at(-1)!.opacity, to)).toBe(true);
      controls.cancel();
    }
  });

  it('pause/play не приписывает progress-v0 IEEE-дрейфующей static-оси', () => {
    const artifact = compileSpringExecutionArtifactUnchecked(
      UNDERDAMPED,
      0,
      DEFAULT_TOLERANCE,
    );
    const durationMs = settleTimeUpperBound(UNDERDAMPED, 0) * 1_000;
    let pickupMs = -1;
    for (let tMs = 1; tMs < Math.min(durationMs, 1_000); tMs++) {
      const progress = sampleSerializedSpring(artifact.samples, durationMs, tMs).value;
      const roundedStatic =
        (1 - progress) * Number.MAX_VALUE + progress * Number.MAX_VALUE;
      if (Number.isFinite(roundedStatic) && roundedStatic !== Number.MAX_VALUE) {
        pickupMs = tMs;
        break;
      }
    }
    expect(pickupMs).toBeGreaterThan(0);

    const target = fakeEl({}, true);
    const clock = makeClock();
    let requests = 0;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        currentTime: pickupMs,
        cancel: () => { target.cancels++; },
      } as { currentTime: number; cancel: () => void };
    };
    const controls = animate(target.el, {
      scaleX: [1, 2],
      scaleY: [Number.MAX_VALUE, Number.MAX_VALUE],
    }, {
      spring: UNDERDAMPED,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    controls.pause();
    expect(lastTransform(target.writes)).toContain(`scaleY(${Number.MAX_VALUE})`);
    controls.play();

    // Точный нулевой span не зависит от общей progress-кривой: повторный
    // compositor-effect допустим, но каждый его кадр обязан держать Y точно.
    expect(target.animateCalls).toHaveLength(2);
    expect(requests).toBe(0);
    const replayY = target.animateCalls[1]!.keyframes.map((frame) =>
      Number(/scaleY\(([^)]+)\)/.exec(String(frame.transform))?.[1]),
    );
    expect([...new Set(replayY)]).toEqual([Number.MAX_VALUE]);
    controls.cancel();
  });

  it('sharedV0 отклоняет даже Number.EPSILON-разницу без tolerance', () => {
    const channel = (_v0: number): NumericChannel => ({
      _from: 0,
      _to: 1,
      _solverTo: 1,
      _velocity: _v0,
      _v0,
    }) as NumericChannel;
    expect(sharedV0([channel(1), channel(1)])).toBe(1);
    expect(sharedV0([channel(1), channel(1 + Number.EPSILON)])).toBeUndefined();
  });

  it('sharedV0 смотрит public span: живой нулевой span остаётся на main', () => {
    const impulse = {
      _from: 1.0000000074925934,
      _to: 1.0000000074925934,
      _solverTo: 1.0000000075925935,
      _velocity: 8.97e-8,
      _v0: 897,
    } as NumericChannel;
    expect(sharedV0([impulse])).toBeUndefined();
  });

  it('точный статический канал не ограничивает WAAPI-кривую движущегося', () => {
    const moving = {
      _from: 1,
      _to: 3,
      _solverTo: 3,
      _velocity: 4,
      _v0: 2,
    } as NumericChannel;
    const inert = {
      _from: 2,
      _to: 2,
      _solverTo: 2,
      _velocity: 0,
      _v0: 0,
    } as NumericChannel;
    expect(sharedV0([moving, inert])).toBe(2);
    expect(sharedV0([inert, moving])).toBe(2);
  });

  it('ненулевой sub-epsilon span остаётся движущимся и ограничивает WAAPI', () => {
    const tiny = {
      _from: 1,
      _to: 1 + Number.EPSILON,
      _solverTo: 1 + Number.EPSILON,
      _velocity: 0,
      _v0: 0,
    } as NumericChannel;
    const moving = {
      _from: 0,
      _to: 1,
      _solverTo: 1,
      _velocity: 1,
      _v0: 1,
    } as NumericChannel;
    expect(sharedV0([tiny, moving])).toBeUndefined();
  });

  it.each(['scaleX', 'scaleY'] as const)(
    'после scale:2 новый %s:3 стартует с 2 и сохраняет вторую ось',
    async (axis) => {
      const target = fakeEl();
      const clock = makeClock();
      const short = { duration: 50, ease: LINEAR, requestFrame: clock.requestFrame };

      const uniform = animate(target.el, { scale: 2 }, short);
      clock.drain();
      await uniform.finished;
      expect(lastTransform(target.writes)).toBe('scale(2)');

      const before = scaleFrames(target.writes).length;
      const axial = animate(target.el, { [axis]: 3 }, {
        duration: 100,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
      clock.step(0);
      expect(scaleFrames(target.writes, before).at(-1)).toEqual({ x: 2, y: 2 });
      clock.step(50);
      const middle = scaleFrames(target.writes, before).at(-1)!;
      expect(middle[axis === 'scaleX' ? 'x' : 'y']).toBeCloseTo(2.5, 12);
      expect(middle[axis === 'scaleX' ? 'y' : 'x']).toBe(2);
      clock.drain(50);
      await axial.finished;

      const rendered = lastTransform(target.writes);
      const end = scaleAxes(rendered);
      expect(end[axis === 'scaleX' ? 'x' : 'y']).toBe(3);
      expect(end[axis === 'scaleX' ? 'y' : 'x']).toBe(2);

      const reentered = animate(target.el, { rotate: 15 }, short);
      clock.drain();
      await reentered.finished;

      const afterReentry = lastTransform(target.writes);
      expect(scaleAxes(afterReentry)).toEqual(end);
      expect(afterReentry).toContain('rotate(15deg)');
    },
  );

  it.each([true, false])(
    'live-перехват не зависит от порядка props (axisFirst=%s) и сохраняет другие оси',
    async (axisFirst) => {
      const target = fakeEl();
      const clock = makeClock();
      const previous = animate(
        target.el,
        { x: [0, 12], scale: [1, 2], rotate: [0, 30] },
        { duration: 1_000, ease: LINEAR, requestFrame: clock.requestFrame },
      );
      clock.step(0);
      clock.step(500);

      const props: AnimateProps = axisFirst
        ? { scaleX: 3, y: 20 }
        : { y: 20, scaleX: 3 };
      const successor = animate(target.el, props, {
        duration: 50,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
      clock.drain();
      await Promise.all([previous.finished, successor.finished]);

      const rendered = lastTransform(target.writes);
      expect(rendered).toContain('translate(6px, 20px)');
      expect(scaleAxes(rendered)).toEqual({ x: 3, y: 1.5 });
      expect(rendered).toContain('rotate(15deg)');
    },
  );

  it.each([true, false])(
    'scale и scaleX в одном input имеют одну topology независимо от порядка (axisFirst=%s)',
    async (axisFirst) => {
      const target = fakeEl();
      const clock = makeClock();
      const props: AnimateProps = axisFirst
        ? { scaleX: 3, scale: 2 }
        : { scale: 2, scaleX: 3 };
      const controls = animate(target.el, props, {
        duration: 50,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
      clock.drain();
      await controls.finished;
      expect(scaleAxes(lastTransform(target.writes))).toEqual({ x: 3, y: 2 });
    },
  );

  it('uniform→scaleX переносит позицию и скорость, а scaleY замораживает в точке перехвата', () => {
    const target = fakeEl();
    const clock = makeClock();
    animate(target.el, { scale: 4 }, { spring: SPRING, requestFrame: clock.requestFrame });

    const framesBeforePickup = 7;
    for (let i = 0; i < framesBeforePickup; i++) clock.step(16);
    const t = ((framesBeforePickup - 1) * 16) / 1_000;
    const snapshot = readCompositorSpring(SPRING, { from: 1, to: 4, v0: 0, t });
    expect(scaleAxes(lastTransform(target.writes))).toEqual({
      x: snapshot.value,
      y: snapshot.value,
    });

    const before = scaleFrames(target.writes).length;
    animate(target.el, { scaleX: 6 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 4; i++) clock.step(16);

    const pickedUp = scaleFrames(target.writes, before);
    const v0 = snapshot.velocity / (6 - snapshot.value);
    for (let i = 0; i < pickedUp.length; i++) {
      const expectedX = readCompositorSpring(SPRING, {
        from: snapshot.value,
        to: 6,
        v0,
        t: (i * 16) / 1_000,
      }).value;
      expect(pickedUp[i]!.x).toBeCloseTo(expectedX, 9);
      expect(pickedUp[i]!.y).toBeCloseTo(snapshot.value, 12);
    }
  });

  it('повторный вызов во время axial-прогона не оживляет старый uniform scale', async () => {
    const target = fakeEl();
    const clock = makeClock();
    const short = { duration: 50, ease: LINEAR, requestFrame: clock.requestFrame };

    const uniform = animate(target.el, { scale: 2 }, short);
    clock.drain();
    await uniform.finished;

    const axial = animate(target.el, { scaleX: 3 }, {
      duration: 1_000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(0);
    clock.step(500);

    const reentered = animate(target.el, { rotate: 15 }, short);
    clock.drain();
    await Promise.all([axial.finished, reentered.finished]);

    const rendered = lastTransform(target.writes);
    expect(scaleAxes(rendered)).toEqual({ x: 2.5, y: 2 });
    expect(rendered).toContain('rotate(15deg)');
  });

  it('axes→uniform независимо сводит обе оси к одной цели без стартового скачка', async () => {
    const target = fakeEl();
    const clock = makeClock();
    const short = { duration: 50, ease: LINEAR, requestFrame: clock.requestFrame };

    const axial = animate(target.el, { scaleX: 2, scaleY: 3 }, short);
    clock.drain();
    await axial.finished;

    const before = scaleFrames(target.writes).length;
    const uniform = animate(target.el, { scale: 4 }, {
      duration: 100,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(0);
    expect(scaleFrames(target.writes, before).at(-1)).toEqual({ x: 2, y: 3 });
    clock.step(50);
    expect(scaleFrames(target.writes, before).at(-1)).toEqual({ x: 3, y: 3.5 });
    clock.drain(50);
    await uniform.finished;
    expect(scaleAxes(lastTransform(target.writes))).toEqual({ x: 4, y: 4 });

    const reentered = animate(target.el, { rotate: 15 }, short);
    clock.drain();
    await reentered.finished;

    const rendered = lastTransform(target.writes);
    expect(rendered).toBe('scale(4) rotate(15deg)');
  });

  it('compositor-план начинает axial-переход с прежних двух осей', async () => {
    const target = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    const options = { spring: SPRING, now: now.now, setTimer: timer.setTimer };

    const uniform = animate(target.el, { scale: 2 }, options);
    timer.fire();
    await uniform.finished;

    animate(target.el, { scaleX: 3 }, options);
    const keyframes = target.animateCalls.at(-1)!.keyframes;
    expect(scaleAxes(String(keyframes[0]!['transform']))).toEqual({ x: 2, y: 2 });
    expect(scaleAxes(String(keyframes.at(-1)!['transform']))).toEqual({ x: 3, y: 2 });
  });

  it.each([true, false])(
    'разные axial-скорости запрещают общий WAAPI-прогресс (scaleXFirst=%s)',
    async (scaleXFirst) => {
      const target = fakeEl({}, true);
      const now = makeNow();
      const timer = makeTimer();
      const options = { spring: SPRING, now: now.now, setTimer: timer.setTimer };
      const props: AnimateProps = scaleXFirst
        ? { scaleX: [1, 4], scaleY: [2, 2] }
        : { scaleY: [2, 2], scaleX: [1, 4] };

      const moving = animate(target.el, props, options);
      expect(target.animateCalls).toHaveLength(1);
      now.advance(120);

      const incompatible = animate(target.el, { scale: 6 }, options);
      expect(target.animateCalls).toHaveLength(1);

      incompatible.cancel();
      await Promise.all([moving.finished, incompatible.finished]);
    },
  );

  it('одинаковый live-v0 нескольких каналов сохраняет compositor-route', () => {
    const target = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    const options = { spring: SPRING, now: now.now, setTimer: timer.setTimer };

    animate(target.el, { scaleX: [1, 4], scaleY: [1, 4] }, options);
    now.advance(120);
    const compatible = animate(target.el, { scale: 6 }, options);

    expect(target.animateCalls).toHaveLength(2);
    compatible.cancel();
  });

  it('seek общей кривой не теряет compositor из-за поканального 1 ULP', () => {
    const target = fakeEl({}, true);
    const controls = animate(target.el, {
      scaleX: [2.998266875266529e-11, 9.325277294421096e-10],
      scaleY: [-1.0238667362138987e-8, -2.1550411860147135e-10],
    }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });

    expect(target.animateCalls).toHaveLength(1);
    controls.seek(120);
    // Оба канала происходят из одного serialized progress. Пересчёт
    // velocity / remainingRange даёт 8.127445620305012 и ...5010 только
    // из-за округления; структурный v0 обязан сохранить единый WAAPI effect.
    expect(target.animateCalls).toHaveLength(2);
    controls.cancel();
  });
});
