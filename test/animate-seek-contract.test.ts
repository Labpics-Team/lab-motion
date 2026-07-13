/**
 * Единый контракт контролов full WAAPI, full main и mini:
 * pause -> seek меняет позу, но не возобновляет время; play продолжает с неё.
 * Нефинитное виртуальное время не меняет ни позу, ни жизненный цикл.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate as animateFull } from '../src/animate/index.js';
import { animate as animateMini } from '../src/animate/mini/index.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { sampleSerializedSpring } from '../src/compositor/sample.js';
import { settleTimeUpperBound } from '../src/spring.js';
import {
  fakeEl,
  makeClock,
  makeTimer,
  translateXSeries,
  type AnimateFn,
} from './animate-facade-helpers.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function executionValue(tMs: number): number {
  const artifact = compileSpringExecutionArtifactUnchecked(
    SPRING,
    0,
    DEFAULT_TOLERANCE,
  );
  return sampleSerializedSpring(
    artifact.samples,
    settleTimeUpperBound(SPRING, 0) * 1000,
    tMs,
  ).value * 100;
}

beforeEach(() => {
  __resetDetectionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('animate: единый pause -> seek -> play', () => {
  it.each([
    ['full main', animateFull as AnimateFn],
    ['mini', animateMini as AnimateFn],
  ])('%s: seek меняет позу и сохраняет паузу', async (_name, animate) => {
    const target = fakeEl();
    const clock = makeClock();
    const controls = animate(target.el, { x: [0, 100] }, {
      duration: 400,
      ease: (t: number) => t,
      requestFrame: clock.requestFrame,
    });

    clock.step(16);
    controls.pause();
    controls.seek(200);
    expect(translateXSeries(target.writes).at(-1)).toBeCloseTo(50, 9);

    const writesAtSeek = target.writes.length;
    for (let i = 0; i < 4; i++) clock.step(16);
    expect(target.writes).toHaveLength(writesAtSeek);

    controls.play();
    clock.drain(16);
    await controls.finished;
    expect(translateXSeries(target.writes).at(-1)).toBe(100);
  });

  it('full WAAPI: seek на паузе фиксирует позу без скрытого re-emit', () => {
    const target = fakeEl({}, true);
    const timer = makeTimer();
    let now = 0;
    const controls = animateFull(target.el, { x: [0, 100] }, {
      spring: SPRING,
      now: () => now,
      setTimer: timer.setTimer,
    });

    now = 80;
    controls.pause();
    expect(target.animateCalls).toHaveLength(1);
    expect(target.cancels).toBe(1);

    controls.seek(200);
    const sought = executionValue(200);
    expect(translateXSeries(target.writes).at(-1)).toBeCloseTo(sought, 9);
    expect(target.animateCalls).toHaveLength(1);
    expect(target.cancels).toBe(1);

    const writesAtSeek = target.writes.length;
    timer.fire();
    expect(target.writes).toHaveLength(writesAtSeek);
    expect(target.animateCalls).toHaveLength(1);

    controls.play();
    expect(target.animateCalls).toHaveLength(2);
    const resumed = String(target.animateCalls[1]!.keyframes[0]!['transform']);
    expect(Number(/translateX\((-?[\d.eE+]+)px\)/.exec(resumed)?.[1])).toBeCloseTo(sought, 9);
    controls.cancel();
  });

  it.each([
    ['full main', animateFull as AnimateFn, false],
    ['full WAAPI', animateFull as AnimateFn, true],
    ['mini', animateMini as AnimateFn, false],
  ])('%s: seek(NaN | +/-Infinity) — полный no-op', (_name, animate, withWaapi) => {
    const target = fakeEl({}, withWaapi);
    const clock = makeClock();
    const timer = makeTimer();
    const controls = animate(target.el, { x: [0, 100] }, withWaapi
      ? { spring: SPRING, now: () => 0, setTimer: timer.setTimer }
      : { duration: 400, ease: (t: number) => t, requestFrame: clock.requestFrame });

    clock.step(16);
    const writes = target.writes.length;
    const animations = target.animateCalls.length;
    const cancels = target.cancels;
    controls.seek(Number.NaN);
    controls.seek(Number.POSITIVE_INFINITY);
    controls.seek(Number.NEGATIVE_INFINITY);

    expect(target.writes).toHaveLength(writes);
    expect(target.animateCalls).toHaveLength(animations);
    expect(target.cancels).toBe(cancels);
    controls.cancel();
  });
});
