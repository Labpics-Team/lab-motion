import { describe, expect, it } from 'vitest';
import { createStateCascade, type StateCascadeLayer } from '../src/behaviors/index.js';
import { MotionValue } from '../src/motion-value.js';
import { makeClock, lcg } from './projection-helpers.js';

// Interface, не только type alias: публичный generic не требует index signature.
interface Visual { x: number; opacity: number }

describe('каскад: независимая модель и настоящий потребитель', () => {
  it('8192 перехода совпадают с полным merge активных слоёв и patch-mirror', () => {
    type Values = Record<string, unknown>;
    const random = lcg(0x12345678);
    const state = createStateCascade<Values>();
    const slots: { handle: StateCascadeLayer<Values>; target?: Values; disposed: boolean }[] = [];
    const mirror: Values = Object.create(null) as Values;
    const keys = ['x', 'opacity', '__proto__', 'constructor'];
    const values: unknown[] = [0, -0, 1, undefined, NaN, 'accent'];
    state.subscribe(({ changed, removed }) => {
      for (const key of removed) delete mirror[key];
      Object.assign(mirror, changed);
    });
    for (let step = 0; step < 8192; step++) {
      const operation = Math.floor(random() * 5);
      if (operation === 0 || slots.length === 0) {
        slots.push({ handle: state.createLayer(), disposed: false });
      } else {
        const slot = slots[Math.floor(random() * slots.length)]!;
        if (operation === 1) {
          slot.handle.clear();
          if (!slot.disposed) delete slot.target;
        } else if (operation === 2) {
          slot.handle.destroy();
          delete slot.target;
          slot.disposed = true;
        } else {
          const target: Values = Object.create(null) as Values;
          for (const key of keys) {
            if (random() < 0.5) target[key] = values[Math.floor(random() * values.length)];
          }
          slot.handle.set(target);
          if (!slot.disposed) slot.target = { ...target };
          target['x'] = 'external mutation';
        }
      }
      // Иная модель: полный shallow merge всех слоёв; не повторяет affected-key scan.
      const expected = Object.assign(Object.create(null) as Values, ...slots.map(slot => slot.target));
      const actual = state.snapshot();
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      expect(Object.keys(mirror).sort()).toEqual(Object.keys(expected).sort());
      for (const key of keys) {
        expect(Object.is(actual[key], expected[key])).toBe(true);
        expect(Object.is(mirror[key], expected[key])).toBe(true);
        expect(Object.is(state.get(key), expected[key])).toBe(true);
      }
    }
    state.destroy();
    expect(slots.every(slot => !slot.handle.active)).toBe(true);
  });

  it('настоящий MotionValue получает последний target, скрытые updates не перезапускают его', () => {
    const clock = makeClock();
    const value = new MotionValue({
      initial: 0, spring: { mass: 1, stiffness: 170, damping: 26 }, requestFrame: clock.requestFrame,
    });
    const state = createStateCascade<Visual>();
    const base = state.createLayer({ x: 0 });
    const press = state.createLayer();
    let targetWrites = 0;
    state.subscribe(({ changed }) => {
      if (changed.x === 1) press.set({ x: 2 });
    });
    const off = state.subscribe(({ changed }) => {
      if (changed.x !== undefined) { targetWrites++; value.setTarget(changed.x); }
    });
    press.set({ x: 1 });
    for (let i = 1; i <= 1000; i++) base.set({ x: i });
    expect(targetWrites).toBe(2);
    clock.drain();
    expect(value.value).toBe(2);
    press.clear();
    expect(targetWrites).toBe(3);
    clock.drain();
    expect(value.value).toBe(1000);
    off();
    state.destroy();
    value.destroy();
  });
});
