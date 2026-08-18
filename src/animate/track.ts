/**
 * animate/track.ts — чистый IR/семплер N-keyframe трека фасада (#205).
 *
 * Один маленький pure-модуль владеет ВСЕЙ топологией трека: offsets
 * (равномерные либо authored times), right-biased выбор сегмента на
 * дубликатах (скачок нулевой ширины) и per-segment easing. Числовые и
 * CSS-каналы используют ОДИН просмотр (trackProgressAt) — коды значений
 * остаются в channels.ts (transform/value SSOT не копируются).
 *
 * Законы (#205):
 *   - без times offsets равномерные по числу стопов канала;
 *   - duplicate offsets разрешены; на самом offset выигрывает ПОЗДНИЙ
 *     сегмент (right-bias) — скачок нулевой ширины;
 *   - scalar ease применяется К КАЖДОМУ сегменту (для 2-стопового трека
 *     это совпадает с глобальным ease — согласованность с pair-путём);
 *   - эндпоинты точны: k≤0 → первый стоп, k≥1 → последний стоп.
 *
 * Инварианты: zero-DOM, детерминизм; ноль аллокаций в семпле — результат
 * пишется в переиспользуемый out-набор вызывающего (канон MutableSpringBasis).
 */

/** Прогресс-функция сегмента (u∈[0,1] → прогресс; не-конечное → u). */
export type SegmentEase = (u: number) => number;

/** Переиспользуемый результат просмотра трека (аллоцируется вызывающим). */
export interface TrackAt {
  _segment: number;
  _progress: number;
}

/** Равномерные offsets для count стопов: 0, 1/(n−1), …, 1. */
export function uniformOffsets(count: number): number[] {
  const offsets = new Array<number>(count);
  const last = count - 1;
  for (let i = 0; i < count; i++) offsets[i] = i / last;
  offsets[last] = 1;
  return offsets;
}

/**
 * Right-biased сегмент + eased-прогресс при глобальном k (сырое время /
 * длительность). Сегмент — наибольший i с offsets[i] ≤ k (поиск с конца,
 * дубликат отдаёт поздний сегмент); нулевая ширина → прогресс 1 (right-bias).
 * Не-конечный выход ease деградирует к линейному u (канон tween-ветки).
 */
export function trackProgressAt(
  offsets: readonly number[],
  k: number,
  easeFor: (segment: number) => SegmentEase | undefined,
  out: TrackAt,
): void {
  const last = offsets.length - 2;
  if (k <= 0) {
    out._segment = 0;
    out._progress = 0;
    return;
  }
  if (k >= 1) {
    out._segment = last;
    out._progress = 1;
    return;
  }
  let segment = 0;
  for (let i = last; i > 0; i--) {
    if (k >= offsets[i]!) {
      segment = i;
      break;
    }
  }
  const start = offsets[segment]!;
  const span = offsets[segment + 1]! - start;
  let progress = span > 0 ? Math.min(1, Math.max(0, (k - start) / span)) : 1;
  const ease = easeFor(segment);
  if (ease !== undefined) {
    const eased = ease(progress);
    if (Number.isFinite(eased)) progress = eased;
  }
  out._segment = segment;
  out._progress = progress;
}

/**
 * Числовое значение трека при k. Взвешенная форма сегмента зеркалит channelAt:
 * эндпоинты сегмента точны, переполнение деградирует к позднему стопу.
 */
export function sampleNumericTrack(
  stops: readonly number[],
  offsets: readonly number[],
  k: number,
  easeFor: (segment: number) => SegmentEase | undefined,
  at: TrackAt,
): number {
  trackProgressAt(offsets, k, easeFor, at);
  const from = stops[at._segment]!;
  const to = stops[at._segment + 1]!;
  const progress = at._progress;
  if (progress === 1) return to;
  if (progress === 0 || from === to) return from;
  const value = (1 - progress) * from + progress * to;
  return Number.isFinite(value) ? value : to;
}
