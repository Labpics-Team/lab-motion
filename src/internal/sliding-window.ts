/**
 * internal/sliding-window.ts — общий трим скользящего окна для оценщиков
 * скорости (./gestures 2D и ./scroll 1D). НЕ публичный subpath.
 *
 * Правило: ≥2 сэмплов внутри окна → мерим строго по окну (старьё долой);
 * <2 (события реже окна) → держим последнюю пару, чтобы скорость через
 * разрыв была честной средней, а не ложным нулём.
 */

/** Сэмпл со временем (секунды). */
export interface TimedSample {
  readonly t: number;
}

/** Вернуть обрезанный по окну массив (исходный не мутируется). */
export function trimSlidingWindow<T extends TimedSample>(samples: readonly T[], windowSec: number): T[] {
  const n = samples.length;
  if (n === 0) return [];
  const cutoff = samples[n - 1].t - windowSec;
  let k = 0;
  while (k < n && samples[k].t < cutoff) k++;
  const from = n - k >= 2 ? k : Math.max(0, n - 2);
  return samples.slice(from);
}
