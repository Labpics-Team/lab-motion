/**
 * angular/index.ts — Angular-биндинг (subpath ./angular, S19).
 *
 * Тонкий адаптер headless-ядра к Angular Signals (v16+): ядро о фреймворке
 * не знает, @angular/core — optional peerDependency. Идиома Angular для
 * контекстных примитивов — inject*-функции: вызываются в injection context
 * (конструктор/инициализатор поля), уборка регистрируется через
 * DestroyRef.onDestroy; вне контекста assertInInjectionContext даёт честную
 * NG0203-ошибку вместо тихой утечки.
 *
 * Reduced-motion — смена ХАРАКТЕРА (инвариант пакета): доменный
 * MotionValue.snapTo синхронно эмитит в сигнал, гасит прежний полёт
 * и централизует finite-валидацию (CSS-safe).
 */

import { assertInInjectionContext, DestroyRef, inject, signal, type Signal } from '@angular/core';
import type { MotionValue, MotionValueOptions } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
import { type SpringParams } from '../spring.js';

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Живой MotionValue, разрушаемый вместе со скоупом (DestroyRef).
 * Только в injection context (конструктор/инициализатор поля).
 */
export function injectMotionValue(
  initial: number,
  spring: SpringParams = DEFAULT_SPRING,
  requestFrame?: MotionValueOptions['requestFrame'],
): MotionValue {
  assertInInjectionContext(injectMotionValue);
  const mv = createBoundValue({ initial, spring, requestFrame });
  inject(DestroyRef).onDestroy(() => {
    mv.destroy();
  });
  return mv;
}

/**
 * Readonly-сигнал, анимируемый пружиной к цели.
 *
 * @returns [value, setTarget] — сигнал значения (читается вызовом) и
 *   установка цели (mid-flight подхватывает скорость).
 *
 * @example
 * ```ts
 * @Component({ template: `<div [style.transform]="'translateX(' + x() + 'px)'"></div>` })
 * class Box {
 *   readonly [x, setX] = ... // поле-инициализатор: injectSpring(0)
 * }
 * ```
 */
export function injectSpring(
  initial: number,
  spring: SpringParams = DEFAULT_SPRING,
  reducedMotionMode: 'instant' | 'fade' = 'instant',
  requestFrame?: MotionValueOptions['requestFrame'],
): [Signal<number>, (target: number) => void] {
  assertInInjectionContext(injectSpring);
  const value = signal(initial);
  const mv = injectMotionValue(initial, spring, requestFrame);

  mv.onChange((v) => {
    value.set(v);
  });

  let destroyed = false;
  inject(DestroyRef).onDestroy(() => {
    destroyed = true;
  });

  const setTarget = (target: number): void => {
    if (destroyed) return;
    if (prefersReducedMotion()) {
      // onChange уже пишет в Angular Signal; ядро централизует
      // finite-валидацию и инвалидацию queued-кадра прежнего полёта.
      mv.snapTo(target);
      void reducedMotionMode;
    } else {
      mv.setTarget(target);
    }
  };

  return [value.asReadonly(), setTarget];
}
