/** SSOT дефолтов фасада и публичных motion-токенов. */

import type { SpringParams } from './types.js';

export const DEFAULT_DURATION_MS = 200;
export const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
export const STANDARD_EASING_COORDS = [0.2, 0, 0, 1] as const;

/**
 * Развёрнутый solver ровно для cubic-bezier(0.2, 0, 0, 1).
 * Кусочно-линейное начальное приближение ограничивает худшую ошибку, поэтому
 * пяти Newton-шагов хватает для машинной точности без таблицы и bisection.
 */
export const STANDARD_EASING = (input: number): number => {
  if (!(input > 0)) return 0;
  if (input >= 1) return 1;
  let u = Math.min(1, input / 0.6);
  for (let i = 0; i < 5; i++) {
    const x = u * (0.6 + u * (-1.2 + 1.6 * u));
    const dx = 0.6 + u * (-2.4 + 4.8 * u);
    u -= (x - input) / dx;
  }
  return u * u * (3 - 2 * u);
};
