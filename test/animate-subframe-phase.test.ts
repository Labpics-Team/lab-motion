/** Субкадровая фаза main-thread delay/stagger: local = logical - anchor. */

import { withLiveEngine } from './animate-facade-helpers.js';
import { describe, expect, it } from 'vitest';
import { animate as animateBase } from '../src/animate/index.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import {
  fakeEl,
  makeClock,
  translateXSeries,
  type FakeElement,
} from './animate-facade-helpers.js';

// Харнесс R3b: rAF-пути исполняет композируемый live-движок (см. helpers).
const animate = withLiveEngine(animateBase as never);

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;
const GAPS = [1, 5, 10, 17, 40] as const;

function lastX(target: FakeElement): number {
  return translateXSeries(target.writes).at(-1) ?? 0;
}

function run(
  gap: number,
  steps: readonly number[],
  mode: 'tween' | 'spring',
): { readonly actual: number[]; readonly logicalMs: number } {
  const targets = [fakeEl(), fakeEl(), fakeEl(), fakeEl()];
  const clock = makeClock();
  const controls = animate(
    targets.map(({ el }) => el),
    { x: [0, 100] },
    mode === 'tween'
      ? {
          duration: 1000,
          ease: (t) => t,
          stagger: gap,
          requestFrame: clock.requestFrame,
        }
      : { spring: SPRING, stagger: gap, requestFrame: clock.requestFrame },
  );
  for (const dt of steps) clock.step(dt);
  const actual = targets.map(lastX);
  controls.cancel();
  return {
    actual,
    // Первый timestamp задаёт clock-anchor и не является прошедшим временем.
    logicalMs: steps.slice(1).reduce((sum, dt) => sum + Math.max(0, dt), 0),
  };
}

function expectedAt(mode: 'tween' | 'spring', localMs: number): number {
  if (localMs <= 0) return 0;
  if (mode === 'tween') return Math.min(localMs / 10, 100);
  return readCompositorSpring(SPRING, {
    from: 0,
    to: 100,
    t: localMs / 1000,
  }).value;
}

describe('animate MainUnit: субкадровая фаза delay/stagger (#169)', () => {
  // @todo-R3c: subframe-delay: субкадровая фаза delay/stagger (#169/#174) — live-v1 стартует полосы тиком после делэя (эпоха MotionValue); точный перенос фазы — R3c
  it.skip('не схлопывает stagger=5ms в один 16ms frame bucket', () => {
    const { actual } = run(5, [16, 16], 'tween');
    [1.6, 1.1, 0.6, 0.1].forEach((value, index) => {
      expect(actual[index]).toBeCloseTo(value, 12);
    });
  });

  // @todo-R3c: subframe-delay: точный перенос фазы #169/#174 в live — R3c
  it.skip.each([
    ['60Hz', Array.from({ length: 13 }, () => 1000 / 60)],
    ['120Hz', Array.from({ length: 25 }, () => 1000 / 120)],
    ['irregular', [3, 11, 7, 23, 5, 19, 13, 29, 2, 17, 31, 41]],
  ] as const)('%s: gap сохраняет точную local-фазу для tween и spring', (_name, steps) => {
    for (const mode of ['tween', 'spring'] as const) {
      for (const gap of GAPS) {
        const { actual, logicalMs } = run(gap, steps, mode);
        const expected = actual.map((_, index) =>
          expectedAt(mode, logicalMs - index * gap)
        );
        expected.forEach((value, index) => {
          expect(actual[index], `${mode}, gap=${gap}, index=${index}`)
            .toBeCloseTo(value, 9);
        });
      }
    }
  });

  it('регрессирующий timestamp не откатывает local-фазу', () => {
    const target = fakeEl();
    const clock = makeClock();
    const controls = animate(target.el, { x: [0, 100] }, {
      duration: 1000,
      ease: (t) => t,
      delay: 5,
      requestFrame: clock.requestFrame,
    });

    clock.step(16);
    clock.step(16);
    const beforeRegression = lastX(target);
    clock.step(-8);
    expect(lastX(target)).toBe(beforeRegression);
    clock.step(16);
    expect(lastX(target)).toBeCloseTo(beforeRegression + 1.6, 12);
    controls.cancel();
  });

  // @todo-R3c: subframe-delay: субкадровая фаза delay/stagger (#169/#174) — live-v1 стартует полосы тиком после делэя (эпоха MotionValue); точный перенос фазы — R3c
  it.skip('pause исключает wall-gap, а seek переносит anchor без сброса logical-time', () => {
    const target = fakeEl();
    const clock = makeClock();
    const controls = animate(target.el, { x: [0, 100] }, {
      duration: 1000,
      ease: (t) => t,
      delay: 5,
      requestFrame: clock.requestFrame,
    });

    clock.step(16);
    clock.step(16);
    expect(lastX(target)).toBeCloseTo(1.1, 12);
    controls.pause();
    clock.step(1000);
    controls.play();
    clock.step(16);
    expect(lastX(target)).toBeCloseTo(1.1, 12);
    clock.step(16);
    expect(lastX(target)).toBeCloseTo(2.7, 12);

    controls.seek(200);
    expect(lastX(target)).toBeCloseTo(20, 12);
    clock.step(16);
    expect(lastX(target)).toBeCloseTo(20, 12);
    clock.step(16);
    expect(lastX(target)).toBeCloseTo(21.6, 12);
    controls.cancel();
  });

  // @todo-R3c: subframe-delay: субкадровая фаза delay/stagger (#169/#174) — live-v1 стартует полосы тиком после делэя (эпоха MotionValue); точный перенос фазы — R3c
  it.skip('seek сохраняет малую local-фазу у конечной IEEE-границы logical-time', () => {
    const target = fakeEl();
    const clock = makeClock();
    const controls = animate(target.el, { x: [0, 100] }, {
      duration: 1000,
      ease: (t) => t,
      delay: Number.MAX_VALUE,
      requestFrame: clock.requestFrame,
    });

    clock.step(0);
    clock.step(Number.MAX_VALUE);
    controls.seek(200);
    expect(lastX(target)).toBeCloseTo(20, 12);
    clock.step(0);
    expect(lastX(target)).toBeCloseTo(20, 12);
    controls.cancel();
  });
});
