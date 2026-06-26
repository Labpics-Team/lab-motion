import { MotionValue } from '../motion-value.js';
import { type SpringParams } from '../spring.js';

export interface SvelteStore<T> {
  subscribe(run: (value: T) => void): () => void;
  set(value: T, customParams?: SpringParams): Promise<void>;
  update(updater: (value: T) => T, customParams?: SpringParams): Promise<void>;
}

export function springStore(
  initialValue: number | string,
  params?: SpringParams,
): SvelteStore<number | string> {
  const mv = new MotionValue(initialValue, params);

  return {
    subscribe(run) {
      run(mv.value);
      return mv.onChange(run);
    },
    set(value, customParams) {
      if (customParams) {
        mv.setSpringParams(customParams);
      }
      return mv.setTarget(value);
    },
    async update(updater, customParams) {
      const nextValue = updater(mv.value);
      if (customParams) {
        mv.setSpringParams(customParams);
      }
      return mv.setTarget(nextValue);
    },
  };
}
