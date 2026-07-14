import { describe, expect, it, vi } from 'vitest';
import { groupRecord } from '../src/animate/channels.js';
import { animate } from '../src/animate/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const LINEAR = (value: number): number => value;

describe('animate: инвариант остаточного transform', () => {
  it('живой owner фиксирует residual до публикации main-successor', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { rotate: [0, 90] }, {
      duration: 1_000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(0);
    clock.step(100);

    const record = groupRecord(f.el, 'transform');
    expect(record._numeric.has('rotate')).toBe(false);

    const successor = animate(f.el, { x: [0, 50] }, {
      duration: 1_000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });

    expect(record._numeric.get('rotate')?._value).toBeCloseTo(9, 12);
    successor.cancel();
  });

  it('тот же owner-инвариант питает reduced commit без отдельной копии residual', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { rotate: [0, 90] }, {
      duration: 1_000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(0);
    clock.step(100);

    animate(f.el, { x: 50 }, {
      duration: 1_000,
      ease: LINEAR,
      matchMedia: () => ({ matches: true }),
    });

    const record = groupRecord(f.el, 'transform');
    expect(record._numeric.get('rotate')?._value).toBeCloseTo(9, 12);
    expect(record._numeric.get('x')?._value).toBe(50);
    expect(f.writes.at(-1)?.value).toContain('rotate(9deg)');
  });

  it('WAAPI-owner фиксирует residual до публикации compositor-successor', () => {
    __resetDetectionCache();
    vi.stubGlobal('CSS', { supports: () => true });
    try {
      const f = fakeEl({}, true);
      let now = 0;
      animate(f.el, { rotate: [0, 90] }, {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        now: () => now,
        setTimer: () => () => {},
      });

      const record = groupRecord(f.el, 'transform');
      expect(record._numeric.has('rotate')).toBe(false);
      now = 100;

      const successor = animate(f.el, { x: [0, 50] }, {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        now: () => now,
        setTimer: () => () => {},
      });

      expect(record._numeric.get('rotate')?._value).toBeGreaterThan(0);
      successor.cancel();
    } finally {
      vi.unstubAllGlobals();
      __resetDetectionCache();
    }
  });
});
