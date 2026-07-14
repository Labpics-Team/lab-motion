import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/index.js';
import { DEFAULT_TOLERANCE, tryCompileSpringExecutionArtifactTupleUnchecked } from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { fakeEl, makeClock, makeNow, makeTimer, readTranslateX } from './animate-facade-helpers.js';

const SPRING = { mass: 1, stiffness: 100, damping: 10 };

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('animate: трёхвариантный execution-план', () => {
  it('каждая сумма плана коммитится ровно одним исполнителем', () => {
    const reduced = fakeEl({}, true);
    animate(
      reduced.el,
      { x: 100 },
      { spring: SPRING, matchMedia: () => ({ matches: true }) },
    );
    expect(reduced.writes).toHaveLength(1);
    expect(reduced.animateCalls).toHaveLength(0);

    const compositor = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    const compositorControls = animate(
      compositor.el,
      { x: 100 },
      {
        spring: SPRING,
        matchMedia: () => ({ matches: false }),
        now: now.now,
        setTimer: timer.setTimer,
      },
    );
    expect(compositor.animateCalls).toHaveLength(1);
    expect(compositor.writes).toHaveLength(0);

    const main = fakeEl({}, true);
    const clock = makeClock();
    const mainControls = animate(
      main.el,
      { x: 100 },
      {
        duration: 100,
        requestFrame: clock.requestFrame,
        matchMedia: () => ({ matches: false }),
      },
    );
    expect(main.animateCalls).toHaveLength(0);
    expect(main.writes).toHaveLength(0);
    clock.step(0);
    expect(main.writes).toHaveLength(1);

    compositorControls.cancel();
    mainControls.cancel();
  });

  it('undefined artifact означает main fallback, а не reduced или compositor', () => {
    const target = fakeEl({}, true);
    const clock = makeClock();

    const first = animate(
      target.el,
      { x: [0, 100] },
      {
        duration: 100,
        ease: (t) => t,
        requestFrame: clock.requestFrame,
        matchMedia: () => ({ matches: false }),
      },
    );
    clock.step(0);
    clock.step(10);
    const from = readTranslateX(target.writes.at(-1)!.value)!;
    const to = from + 0.1;
    const v0 = 1000 / (to - from);

    expect(tryCompileSpringExecutionArtifactTupleUnchecked(
      SPRING,
      v0,
      DEFAULT_TOLERANCE,
    )).toBeUndefined();

    const writesBefore = target.writes.length;
    const second = animate(
      target.el,
      { x: to },
      {
        spring: SPRING,
        requestFrame: clock.requestFrame,
        matchMedia: () => ({ matches: false }),
      },
    );

    expect(target.animateCalls).toHaveLength(0);
    expect(target.writes).toHaveLength(writesBefore);
    clock.step(1);
    expect(target.writes.length).toBeGreaterThan(writesBefore);
    expect(readTranslateX(target.writes.at(-1)!.value)).toBe(from);

    first.cancel();
    second.cancel();
  });

  it('hostile global matchMedia делегируется единственному guard и не меняет compositor-route', () => {
    vi.stubGlobal('matchMedia', 1);
    const target = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();

    const controls = animate(
      target.el,
      { x: 100 },
      { spring: SPRING, now: now.now, setTimer: timer.setTimer },
    );

    expect(target.animateCalls).toHaveLength(1);
    expect(target.writes).toHaveLength(0);
    controls.cancel();
  });

  it('бросающий global matchMedia безопасно трактуется как no-preference', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('host matchMedia failed');
    });
    const target = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();

    const controls = animate(
      target.el,
      { x: 100 },
      { spring: SPRING, now: now.now, setTimer: timer.setTimer },
    );

    expect(target.animateCalls).toHaveLength(1);
    controls.cancel();
  });
});
