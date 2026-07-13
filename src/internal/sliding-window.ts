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

/**
 * Двигает курсор живого окна без slice на каждом input-событии. Не возвращается
 * левее start, поэтому уже вытесненные сэмплы не воскресают при немонотонном времени.
 * Редкая in-place compaction ограничивает retained heap; её стоимость амортизирована O(1).
 */
export function advanceSlidingWindow<T extends TimedSample>(
  samples: T[],
  start: number,
  windowSec: number,
): number {
  const n = samples.length;
  if (n === 0) return 0;
  const cutoff = samples[n - 1]!.t - windowSec;
  // n-2 — конструктивный гард правила «всегда держать последнюю пару».
  while (start < n - 2 && samples[start]!.t < cutoff) start++;
  if (start > 32 && start * 2 > n) {
    samples.copyWithin(0, start);
    samples.length = n - start;
    return 0;
  }
  return start;
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
