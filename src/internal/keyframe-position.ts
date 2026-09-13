/** Правый сегмент неубывающей шкалы; caller отдельно обрабатывает endpoints. */
export function keyframeSegment(times: readonly number[], p: number): number {
  let segment = 0;
  let high = times.length - 1;
  if (high > 9) {
    while (high - segment > 1) {
      const middle = (segment + high) >>> 1;
      if (p < times[middle]!) high = middle;
      else segment = middle;
    }
  } else {
    while (p >= times[segment + 1]!) segment++;
  }
  return segment;
}
