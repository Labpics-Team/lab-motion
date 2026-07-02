/**
 * solid/index.ts — Solid-биндинг (subpath ./solid, S19).
 *
 * Тонкий адаптер headless-ядра к сигналам Solid: ядро ничего не знает о
 * фреймворке, solid-js — optional peerDependency. Идиома Solid — create*-
 * примитивы, значение читается вызовом аксессора: `x()`.
 *
 * Уборка двухканальная: onCleanup регистрируется ТОЛЬКО при живом owner'е
 * (getOwner() — вне реактивного корня onCleanup никогда не выполнится и
 * сыплет dev-предупреждение), плюс всегда возвращается явный destroy для
 * ownerless-использования.
 *
 * Reduced-motion — смена ХАРАКТЕРА (инвариант пакета): при
 * prefers-reduced-motion setTarget снапает значение синхронно, без пружины;
 * 'fade' с точки зрения сигнала идентичен — мягкость добавляет потребитель
 * CSS-переходом на своём элементе.
 */

import { createSignal, getOwner, onCleanup } from 'solid-js';
import { MotionValue, type MotionValueOptions } from '../motion-value.js';
import { type SpringParams } from '../spring.js';

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Живой MotionValue + dispose. Для продвинутого управления (velocity,
 * onChange-подписки); в компоненте уборка автоматическая через onCleanup.
 */
export function createMotionValue(
  initial: number,
  spring: SpringParams = DEFAULT_SPRING,
  requestFrame?: MotionValueOptions['requestFrame'],
): [MotionValue, () => void] {
  const mv = new MotionValue({ initial, spring, requestFrame });
  const dispose = (): void => {
    mv.destroy();
  };
  if (getOwner() !== null) onCleanup(dispose);
  return [mv, dispose];
}

/**
 * Числовой сигнал, анимируемый пружиной к цели.
 *
 * @returns [value, setTarget, destroy] — аксессор значения, установка цели
 *   (mid-flight подхватывает скорость), явная уборка для ownerless-кода.
 *
 * @example
 * ```tsx
 * const [x, setX] = createSpring(0, { mass: 1, stiffness: 300, damping: 30 });
 * <div style={{ transform: `translateX(${x()}px)` }} onClick={() => setX(100)} />
 * ```
 */
export function createSpring(
  initial: number,
  spring: SpringParams = DEFAULT_SPRING,
  reducedMotionMode: 'instant' | 'fade' = 'instant',
  requestFrame?: MotionValueOptions['requestFrame'],
): [() => number, (target: number) => void, () => void] {
  const [value, setValue] = createSignal(initial);
  const [mv, disposeMv] = createMotionValue(initial, spring, requestFrame);

  const unsubscribe = mv.onChange((v) => {
    setValue(v);
  });

  let destroyed = false;
  const destroy = (): void => {
    destroyed = true;
    unsubscribe();
    disposeMv();
  };
  // createMotionValue уже зарегистрировал disposeMv в onCleanup; здесь
  // добавляется только отписка и флаг (двойной destroy MotionValue безопасен).
  if (getOwner() !== null) {
    onCleanup(() => {
      destroyed = true;
      unsubscribe();
    });
  }

  const setTarget = (target: number): void => {
    if (destroyed) return;
    if (prefersReducedMotion()) {
      setValue(target); // характер: снап, без кадров ('fade' — CSS потребителя)
      void reducedMotionMode;
    } else {
      mv.setTarget(target);
    }
  };

  return [value, setTarget, destroy];
}
