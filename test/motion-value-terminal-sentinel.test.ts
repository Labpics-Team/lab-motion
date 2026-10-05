import { describe, expect, it, vi } from 'vitest';
import { MotionValue, type RequestFrameFn } from '../src/motion-value.js';
import { MotionParamError } from '../src/errors.js';

const spring = { mass: 1, stiffness: 170, damping: 26 };

describe('MotionValue: terminal scheduler-owner', () => {
  it.each([0, false])('malformed scheduler %s не подменяет terminal и не обходит numeric validator', requestFrame => {
    // JS consumer может передать неверный seam. Его поздний host failure не
    // разрешает молча принять NaN как вызов уничтоженного контроллера.
    const value = new MotionValue({ initial: 0, spring, requestFrame: requestFrame as unknown as RequestFrameFn });
    const listener = vi.fn();
    const off = value.onChange(listener);
    expect(listener).toHaveBeenCalledWith(0);
    expect(() => value.setTarget(Number.NaN)).toThrow(MotionParamError);
    expect(() => value.snapTo(Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
    expect(() => value.setTarget(1)).toThrow(TypeError);
    value.destroy();
    expect(() => value.setTarget(Number.NaN)).not.toThrow();
    const late = vi.fn();
    const lateOff = value.onChange(late);
    off(); off(); lateOff(); lateOff();
    expect(late).not.toHaveBeenCalled();
  });

  it('destroy из первичной доставки не оставляет подписку и поздний вызов ничего не доставляет', () => {
    const value = new MotionValue({ initial: 0, spring });
    const off = value.onChange(() => value.destroy());
    const late = vi.fn();
    value.onChange(late);
    off(); off();
    expect(late).not.toHaveBeenCalled();
    expect(value.value).toBe(0);
  });

  it.each([undefined, 0, false, Number.NaN])('сохраняет первый thrown value %s и доставляет соседям', first => {
    const value = new MotionValue({ initial: 0, spring });
    let armed = false;
    value.onChange(() => { if (armed) throw first; });
    value.onChange(() => { if (armed) throw new Error('later failure'); });
    const healthy = vi.fn();
    value.onChange(healthy);
    armed = true;
    let caught: unknown;
    let failed = false;
    try { value.snapTo(1); } catch (error) { failed = true; caught = error; }
    expect(failed).toBe(true);
    expect(Object.is(caught, first)).toBe(true);
    expect(healthy).toHaveBeenLastCalledWith(1);
    expect(() => value.snapTo(2)).not.toThrow();
    expect(healthy).toHaveBeenLastCalledWith(2);
    value.destroy();
  });
});
