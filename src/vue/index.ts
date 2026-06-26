import { ref, watch, onUnmounted, type Ref } from 'vue';
import { MotionValue } from '../motion-value.js';
import { type SpringParams } from '../spring.js';
import { drive } from '../drive.js';

export function useSpring(
  targetValue: Ref<number | string> | (() => number | string),
  params?: SpringParams,
): Ref<number | string> {
  const initial = typeof targetValue === 'function' ? targetValue() : targetValue.value;
  const mv = new MotionValue(initial, params);
  const result = ref<number | string>(initial);

  const unsubscribe = mv.onChange((v) => {
    result.value = v;
  });

  watch(
    typeof targetValue === 'function' ? targetValue : () => targetValue.value,
    (newVal) => {
      mv.setTarget(newVal);
    },
  );

  try {
    onUnmounted(() => {
      unsubscribe();
      mv.destroy();
    });
  } catch {
    // active instance check safety
  }

  return result;
}

export const vMotion = {
  mounted(el: HTMLElement & { _motionValues?: Record<string, number | string> }, binding: any) {
    el._motionValues = el._motionValues || {};
    const params: SpringParams = binding.modifiers.stiff
      ? { mass: 0.5, stiffness: 200, damping: 15 }
      : (binding.value?.spring || { mass: 1, stiffness: 100, damping: 10 });

    animate(el, binding.value, binding.arg, params);
  },
  updated(el: HTMLElement & { _motionValues?: Record<string, number | string> }, binding: any) {
    if (binding.value === binding.oldValue) return;
    el._motionValues = el._motionValues || {};
    const params: SpringParams = binding.modifiers.stiff
      ? { mass: 0.5, stiffness: 200, damping: 15 }
      : (binding.value?.spring || { mass: 1, stiffness: 100, damping: 10 });

    animate(el, binding.value, binding.arg, params);
  }
};

function animate(
  el: HTMLElement & { _motionValues?: Record<string, number | string> },
  value: any,
  arg: string | undefined,
  spring: SpringParams,
) {
  el._motionValues = el._motionValues || {};

  if (arg) {
    const prop = arg;
    const toValue = typeof value === 'object' && value !== null ? value.value : value;
    const fromValue = el._motionValues[prop] !== undefined
      ? el._motionValues[prop]
      : (el.style[prop as any] || '0');

    el._motionValues[prop] = fromValue;

    drive({
      from: fromValue,
      to: toValue,
      spring,
      target: el,
      onStep: (v) => {
        if (el._motionValues) {
          el._motionValues[prop] = v;
        }
        el.style[prop as any] = typeof v === 'number' && (prop === 'left' || prop === 'top' || prop === 'width' || prop === 'height' || prop === 'transform')
          ? `${v}px`
          : String(v);
      },
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [prop, toValue] of Object.entries(value)) {
      if (prop === 'spring') continue;

      const fromValue = el._motionValues[prop] !== undefined
        ? el._motionValues[prop]
        : (el.style[prop as any] || '0');

      el._motionValues[prop] = fromValue;

      drive({
        from: fromValue,
        to: toValue as any,
        spring,
        target: el,
        onStep: (v) => {
          if (el._motionValues) {
            el._motionValues[prop] = v;
          }
          el.style[prop as any] = typeof v === 'number' && (prop === 'left' || prop === 'top' || prop === 'width' || prop === 'height' || prop === 'transform')
            ? `${v}px`
            : String(v);
        },
      });
    }
  }
}
