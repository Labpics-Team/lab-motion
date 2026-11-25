import { expect, it, vi } from 'vitest';
import { program, sample } from '../src/motion/program.js';
import { timing } from '../src/motion/model.js';

it('shares pure curve coefficients across distinct bindings and durations, with exact velocity arithmetic', () => {
  const clock = timing({ duration: 1000, ease: [.2, -.3, .8, 1.4] });
  const evaluate = vi.fn(clock._ease);
  const pure = { ...clock, _ease: evaluate };
  const independent = { ...clock, _cssEase: undefined };
  const durations = [500, 1000, 2000];
  const pairs = Array.from({ length: 24 }, (_, i) => {
    const start = { _coordinates: [i - 12], _unit: 'px' }, goal = [i * 3 + 3];
    const duration = durations[i % durations.length]!;
    return [program('width', start, goal, false, { ...pure, _duration: duration }, [0]),
      program('width', start, goal, false, { ...independent, _duration: duration }, [0])] as const;
  });
  const a: number[] = [], da: number[] = [], b: number[] = [], db: number[] = [];
  for (const [shared, reference] of pairs) {
    for (const phase of [.125, .625]) {
      for (const rate of [1, -.5, 0]) {
        sample(shared, shared._duration * phase, a, da, rate);
        sample(reference, reference._duration * phase, b, db, rate);
        expect(Object.is(a[0], b[0])).toBe(true);
        expect(Object.is(da[0], db[0])).toBe(true);
      }
    }
  }
  expect(evaluate).toHaveBeenCalledTimes(6);
});

it('effectful easing never reuses values or suppresses callbacks, including nested sampling', () => {
  const inner = program('width', { _coordinates: [0], _unit: 'px' }, [20], false, timing({ duration: 1000, ease: 'standard' }), [0]);
  const nested: number[] = [], nestedVelocity: number[] = [];
  let calls = 0;
  const clock = timing({ duration: 1000, ease: t => {
    sample(inner, 300, nested, nestedVelocity);
    return t + ++calls / 1000;
  } });
  const outer = program('width', { _coordinates: [0], _unit: 'px' }, [100], false, clock, [0]);
  const first: number[] = [], second: number[] = [], velocity: number[] = [];
  sample(outer, 500, first, velocity);
  sample(outer, 500, second, velocity);
  expect(calls).toBe(6);
  expect(first[0]).toBeCloseTo(50.3, 12);
  expect(second[0]).toBeCloseTo(50.6, 12);
});
