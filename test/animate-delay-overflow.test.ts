/** Full animate обязан материализовать весь schedule до любых host-effects. */

import { describe, expect, it, vi } from 'vitest';
import {
  animate,
  type AnimateControls,
  type AnimatableElement,
} from '../src/animate/index.js';
import { MotionParamError } from '../src/errors.js';

interface ObservedTarget {
  readonly el: AnimatableElement & {
    animate(
      keyframes: Record<string, string | number>[],
      timing: Record<string, unknown>,
    ): { cancel(): void };
  };
  readonly reads: ReturnType<typeof vi.fn>;
  readonly writes: ReturnType<typeof vi.fn>;
  readonly animations: ReturnType<typeof vi.fn>;
}

function observedTarget(): ObservedTarget {
  const reads = vi.fn(() => '0');
  const writes = vi.fn();
  const animations = vi.fn(() => ({ cancel() {} }));
  return {
    reads,
    writes,
    animations,
    el: {
      style: {
        getPropertyValue: reads,
        setProperty: writes,
      },
      animate: animations,
    },
  };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('animate: конечность итоговой delay', () => {
  it.each([
    ['linear', Number.MAX_VALUE],
    ['from=last', { gap: Number.MAX_VALUE, from: 'last' as const }],
    ['grid', { gap: Number.MAX_VALUE, grid: { columns: 1 } }],
    ['finite huge easing', { gap: 2, easing: () => Number.MAX_VALUE }],
    ['NaN easing', { easing: () => Number.NaN }],
    ['non-number easing', { easing: () => Symbol('delay') as never }],
  ])('%s: derived stagger overflow падает LM139 до plan/host', (_name, stagger) => {
    const targets = [observedTarget(), observedTarget(), observedTarget()];
    const matchMedia = vi.fn(() => ({ matches: false }));
    const requestFrame = vi.fn(() => 1);
    const now = vi.fn(() => 0);
    const setTimer = vi.fn(() => () => {});

    const error = thrownBy(() => animate(
      targets.map(({ el }) => el),
      { opacity: [1, 0] },
      {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        stagger,
        matchMedia,
        requestFrame,
        now,
        setTimer,
      },
    ));

    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe('LM139');
    expect(targets.flatMap((target) => [
      ...target.reads.mock.calls,
      ...target.writes.mock.calls,
      ...target.animations.mock.calls,
    ])).toEqual([]);
    expect(matchMedia).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('base + stagger overflow падает LM139 до plan/scheduler/host effects', () => {
    const targets = [observedTarget(), observedTarget(), observedTarget()];
    const matchMedia = vi.fn(() => ({ matches: false }));
    const requestFrame = vi.fn(() => 1);
    const now = vi.fn(() => 0);
    const setTimer = vi.fn(() => () => {});
    let controls: AnimateControls | undefined;

    const error = thrownBy(() => {
      controls = animate(
        targets.map(({ el }) => el),
        { opacity: [1, 0] },
        {
          spring: { mass: 1, stiffness: 170, damping: 26 },
          delay: Number.MAX_VALUE,
          stagger: Number.MAX_VALUE,
          matchMedia,
          requestFrame,
          now,
          setTimer,
        },
      );
    });
    const effectsBeforeCleanup = {
      reads: targets.reduce((sum, target) => sum + target.reads.mock.calls.length, 0),
      writes: targets.reduce((sum, target) => sum + target.writes.mock.calls.length, 0),
      animations: targets.reduce(
        (sum, target) => sum + target.animations.mock.calls.length,
        0,
      ),
      matchMedia: matchMedia.mock.calls.length,
      requestFrame: requestFrame.mock.calls.length,
      now: now.mock.calls.length,
      setTimer: setTimer.mock.calls.length,
    };
    try { controls?.cancel(); } catch { /* RED-path cleanup не скрывает наблюдение. */ }

    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe('LM139');
    expect(effectsBeforeCleanup).toEqual({
      reads: 0,
      writes: 0,
      animations: 0,
      matchMedia: 0,
      requestFrame: 0,
      now: 0,
      setTimer: 0,
    });
  });

  it.each([
    ['base delay', { delay: -1 }],
    ['numeric stagger', { stagger: -1 }],
  ] as const)('отрицательный %s сохраняет ранний LM139', (_name, invalid) => {
    const target = observedTarget();
    const requestFrame = vi.fn(() => 1);
    const error = thrownBy(() => animate(
      [target.el, target.el],
      { opacity: [1, 0] },
      { duration: 100, requestFrame, ...invalid },
    ));

    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe('LM139');
    expect(target.reads).not.toHaveBeenCalled();
    expect(target.writes).not.toHaveBeenCalled();
    expect(target.animations).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('тот же MAX schedule не даёт ложного overflow для нуля и одной цели', async () => {
    const empty = animate([], { opacity: [1, 0] }, {
      duration: 100,
      delay: Number.MAX_VALUE,
      stagger: Number.MAX_VALUE,
    });
    await expect(empty.finished).resolves.toBeUndefined();

    const target = observedTarget();
    const requestFrame = vi.fn(() => 1);
    const single = animate(target.el, { opacity: [1, 0] }, {
      duration: 100,
      delay: Number.MAX_VALUE,
      stagger: Number.MAX_VALUE,
      requestFrame,
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    single.cancel();
  });

  it('stagger reducedMotion обнуляет schedule до strict-easing', () => {
    const targets = [observedTarget(), observedTarget(), observedTarget()];
    const easing = vi.fn(() => Number.NaN);
    const requestFrame = vi.fn(() => 1);
    const controls = animate(
      targets.map(({ el }) => el),
      { opacity: [1, 0] },
      {
        duration: 100,
        stagger: {
          gap: Number.MAX_VALUE,
          easing,
          grid: { columns: 2 },
          from: 'last',
          reducedMotion: true,
        },
        requestFrame,
      },
    );

    expect(easing).not.toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    controls.cancel();
  });
});
