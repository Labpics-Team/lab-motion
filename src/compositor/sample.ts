/** Точный sampler фактически исполняемых serialized stops. */

import { finiteOrZero } from '../internal/finite.js';
import type { SpringSerializedSamples } from './curve.js';

export interface SerializedSpringSample {
  /** Нормализованный progress. */
  value: number;
  /** Производная progress/second. */
  velocity: number;
}

export interface AnimationTimeSource {
  readonly currentTime?: number | null;
}

/**
 * Реальный `null` означает unresolved/pending local time: effect ещё не имеет
 * видимого времени и должен читаться как pre-start, а не догонять JS clock.
 * Duck-объект без свойства сохраняет детерминированный fallback старых seams.
 */
export function animationTimeOrFallback(
  animation: AnimationTimeSource | undefined,
  fallbackMs: number,
): number {
  try {
    if (animation !== undefined && 'currentTime' in animation) {
      const current = animation.currentTime;
      if (current === null) return -1;
      if (typeof current === 'number' && Number.isFinite(current)) return current;
    }
  } catch {
    // Отказ host-getter/in-trap не блокирует monotonic fallback clock.
  }
  return fallbackMs;
}

/**
 * Сэмплирует piecewise-linear easing за O(log K). На interior-kink производная
 * математически неоднозначна; upper-bound поиск выбирает правый сегмент, чтобы
 * новый tangent-anchor продолжил именно видимое движение после события.
 */
export function sampleSerializedSpring(
  samples: SpringSerializedSamples,
  durationMs: number,
  currentTimeMs: number,
  delayMs = 0,
  out?: SerializedSpringSample,
): SerializedSpringSample {
  const result = out ?? { value: 0, velocity: 0 };
  const activeMs = currentTimeMs - delayMs;
  if (activeMs < 0) {
    result.value = 0;
    result.velocity = 0;
    return result;
  }
  if (activeMs >= durationMs) {
    result.value = 1;
    result.velocity = 0;
    return result;
  }

  const percent = activeMs / durationMs * 100;
  const count = samples.length / 2;
  let lo = 1;
  let hi = count - 1;
  // upper_bound(percent): равный stop остаётся слева, поэтому slope берётся
  // справа. Stops строго возрастают по контракту сериализатора.
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid * 2]! <= percent) lo = mid + 1;
    else hi = mid;
  }
  const left = lo - 1;
  const x0 = samples[left * 2]!;
  const p0 = samples[left * 2 + 1]!;
  const x1 = samples[lo * 2]!;
  const p1 = samples[lo * 2 + 1]!;
  const q = (percent - x0) / (x1 - x0);
  const value = (1 - q) * p0 + q * p1;
  const velocity = (p1 - p0) / ((x1 - x0) * durationMs / 100_000);
  result.value = Number.isFinite(value) ? value : p1;
  result.velocity = finiteOrZero(velocity);
  return result;
}

/**
 * Денормализует slope progress/s в units/s без ложной потери adjacent-huge
 * диапазона. Конечную разность умножаем напрямую; split-products нужны только
 * когда сама разность переполнилась на MAX↔-MAX.
 */
export function scaleSerializedVelocity(
  progressVelocity: number,
  from: number,
  to: number,
): number {
  const range = to - from;
  const raw = Number.isFinite(range)
    ? progressVelocity * range
    : progressVelocity * to - progressVelocity * from;
  return finiteOrZero(raw);
}
