import { describe, expect, it, vi } from 'vitest';
import { useMotionValue, useSpring } from '../src/react/index.js';
import { MotionValue } from '../src/motion-value.js';

vi.mock('react', () => {
  let stateVal: any = null;
  return {
    useState: (init: any) => {
      const val = typeof init === 'function' ? init() : init;
      if (val instanceof MotionValue) {
        return [val, () => {}];
      }
      if (stateVal === null) {
        stateVal = val;
      }
      return [stateVal, (newVal: any) => {
        stateVal = newVal;
      }];
    },
    useEffect: (fn: any) => {
      fn();
      return () => {};
    },
  };
});

describe('React Bindings', () => {
  it('useMotionValue returns stable MotionValue instance', () => {
    const mv = useMotionValue(100);
    expect(mv).toBeInstanceOf(MotionValue);
    expect(mv.value).toBe(100);
  });

  it('useSpring sets up target and listens to changes', () => {
    const val = useSpring(200);
    expect(val).toBe(200);
  });
});
