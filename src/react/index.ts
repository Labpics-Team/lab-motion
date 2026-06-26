import { useState, useEffect } from 'react';
import { MotionValue } from '../motion-value.js';
import { type SpringParams } from '../spring.js';

export function useMotionValue(initial: number | string): MotionValue {
  const [mv] = useState(() => new MotionValue(initial));
  useEffect(() => {
    return () => mv.destroy();
  }, [mv]);
  return mv;
}

export function useSpring(
  targetValue: number | string,
  params?: SpringParams,
): number | string {
  const mv = useMotionValue(targetValue);
  const [val, setVal] = useState(targetValue);

  useEffect(() => {
    if (params) {
      mv.setSpringParams(params);
    }
  }, [mv, params]);

  useEffect(() => {
    mv.setTarget(targetValue);
  }, [mv, targetValue]);

  useEffect(() => {
    return mv.onChange((latest) => {
      setVal(latest);
    });
  }, [mv]);

  return val;
}
