/**
 * preact/index.ts — Preact-биндинг (subpath ./preact, S19).
 *
 * Зеркало react-биндинга поверх `preact/hooks` (сигнатуры хуков идентичны;
 * preact — optional peerDependency, ядро о фреймворке не знает). Отдельный
 * субпуть, а не алиас: у Preact свой рантайм, preact/compat не требуется.
 *
 * Reduced-motion — смена ХАРАКТЕРА (инвариант пакета): при
 * prefers-reduced-motion useSpring снапает значение к цели немедленно;
 * 'fade' с точки зрения значения идентичен — мягкость добавляет потребитель
 * CSS-переходом.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { MotionValue, MotionValueOptions } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
import { MotionParamError } from '../errors.js';
import { type SpringParams } from '../spring.js';

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Стабильный MotionValue: создаётся один раз, разрушается на unmount.
 * Анимация — через mv.setTarget(value).
 */
export function useMotionValue(
  initial: number,
  spring: SpringParams = DEFAULT_SPRING,
  requestFrame?: MotionValueOptions['requestFrame'],
): MotionValue {
  const mvRef = useRef<MotionValue | null>(null);

  if (mvRef.current === null) {
    mvRef.current = createBoundValue({ initial, spring, requestFrame });
  }

  useEffect(() => {
    return () => {
      mvRef.current?.destroy();
      mvRef.current = null;
    };
  }, []);

  return mvRef.current;
}

/**
 * Числовое значение, анимируемое пружиной к `target`; ре-таргет mid-flight
 * подхватывает скорость.
 *
 * @example
 * ```tsx
 * const x = useSpring(open ? 100 : 0, { mass: 1, stiffness: 300, damping: 30 });
 * <div style={{ transform: `translateX(${x}px)` }} />
 * ```
 */
export function useSpring(
  target: number,
  spring: SpringParams = DEFAULT_SPRING,
  reducedMotionMode: 'instant' | 'fade' = 'instant',
  requestFrame?: MotionValueOptions['requestFrame'],
): number {
  const [value, setValue] = useState<number>(target);
  const mv = useMotionValue(target, spring, requestFrame);

  useEffect(() => {
    return mv.onChange((v) => {
      setValue(v);
    });
  }, [mv]);

  useEffect(() => {
    if (prefersReducedMotion()) {
      // Снап пишет в стейт в обход ядра — валидация зеркалит mv.setTarget,
      // иначе NaN/Infinity пролезли бы в наблюдаемое значение (инвариант CSS-safe).
      if (!Number.isFinite(target)) {
        throw new MotionParamError(`useSpring: target должен быть конечным, получено ${target}`);
      }
      setValue(target); // характер: снап ('fade' — CSS потребителя)
    } else {
      mv.setTarget(target);
    }
  }, [mv, target, reducedMotionMode]);

  return value;
}
