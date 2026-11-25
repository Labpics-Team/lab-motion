import { expect, it, vi } from 'vitest';
import { cubicBezierUnchecked } from '../src/internal/cubic-bezier.js';
import { timing } from '../src/motion/model.js';
import { program, sample } from '../src/motion/program.js';

it('shares two exact normalized curve samples across independent bindings and durations', () => {
  const points = [.2, -.3, .8, 1.4] as const;
  const clock = timing({ duration: 1000, ease: points });
  const curve = clock._curve, raw = cubicBezierUnchecked(...points);
  const first = curve[1](.125), second = curve[1](.625);
  expect(first).not.toBe(second);
  expect(curve[1](.125)).toBe(first);
  expect(curve[1](.625)).toBe(second);
  for (const [p, phase] of [[.125, first], [.625, second]] as const) {
    const lo = Math.max(0, p - .001), hi = Math.min(1, p + .001);
    expect(phase).toEqual([p, raw(p), (raw(hi) - raw(lo)) * 1000, hi - lo]);
  }
  const value: number[] = [], velocity: number[] = [];
  for (let i = 0; i < 40; i++) {
    const duration = [500, 1000, 2000][i % 3]!, a = i - 12, b = i * 3 + 3;
    const path = program('width', { _coordinates: [a], _unit: 'px' }, [b], false, { ...clock, _duration: duration }, []);
    for (const p of [.125, .625]) for (const rate of [1, -.5, 0]) {
      sample(path, duration * p, value, velocity, rate);
      const lo = Math.max(0, p - .001), hi = Math.min(1, p + .001);
      const dp = (raw(hi) - raw(lo)) * 1000 / ((hi - lo) * duration);
      expect(Object.is(value[0], a + (b - a) * raw(p))).toBe(true);
      const v = (b - a) * dp;
      expect(Object.is(velocity[0], rate === 0 ? 0 : v * rate)).toBe(true);
    }
  }
});

it('does not memoize, mutate, or change the call order of effectful user easing', () => {
  let count = 0;
  const inner = timing({ duration: 1000, ease: 'standard' })._curve;
  const fn = vi.fn((p: number) => { inner[1](.4); return p + ++count / 1000; });
  Object.freeze(fn);
  const clock = timing({ duration: 1000, ease: fn });
  expect(clock._curve[0]).toBe(fn);
  const path = program('width', { _coordinates: [0], _unit: 'px' }, [100], false, clock, []);
  const a: number[] = [], b: number[] = [], v: number[] = [];
  sample(path, 500, a, v);
  sample(path, 500, b, v);
  expect(fn.mock.calls).toEqual([[.501], [.499], [.5], [.501], [.499], [.5]]);
  expect(a[0]).toBeCloseTo(50.3, 12); expect(b[0]).toBeCloseTo(50.6, 12);
});
