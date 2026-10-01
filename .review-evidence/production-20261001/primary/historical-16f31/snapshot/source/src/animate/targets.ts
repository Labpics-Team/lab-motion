/**
 * Общая защитная граница списков целей для full/mini/native animate.
 * Модуль не касается DOM и безопасен при серверном импорте.
 */

import { MotionParamError } from '../errors.js';

/** Единый предел публичных animate-входов. */
export const MAX_ANIMATE_TARGETS = 100_000;

/**
 * Единая первая граница full/mini/native: невалидные options не должны
 * разрешать ни target, ни props и тем более запускать host-методы.
 */
export function requireAnimateOptions<T extends object>(options: T): T {
  if (options === null || typeof options !== 'object') {
    throw new MotionParamError('LM156');
  }
  return options;
}

/** Общая runtime-граница props: массив не является записью CSS-каналов. */
export function requireAnimateProps<T extends object>(props: T): T {
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    throw new MotionParamError('LM151');
  }
  return props;
}

/**
 * Снимает bounded array-like ровно один раз. Отдельный snapshot не позволяет
 * stateful getters сменить длину или элементы между валидацией и plan-фазой.
 */
export function collectBoundedArrayLike(source: unknown): unknown[] {
  const rawLength = (source as { readonly length?: unknown } | null)?.length;
  if (
    typeof rawLength !== 'number' ||
    !Number.isSafeInteger(rawLength) ||
    rawLength < 0 ||
    rawLength > MAX_ANIMATE_TARGETS
  ) {
    throw new MotionParamError('LM146');
  }

  const snapshot = new Array<unknown>(rawLength);
  const list = source as ArrayLike<unknown>;
  for (let i = 0; i < rawLength; i++) snapshot[i] = list[i];
  return snapshot;
}
