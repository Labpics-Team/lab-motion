type Easing = (t: number) => number;

/** Prevalidated, allocation-free keyframe hot path shared by headless runtimes. */
export function sampleKeyframesUnchecked(
  values: readonly number[],
  times: readonly number[],
  easings: readonly Easing[],
  progress: number,
  mirrored = false,
): number {
  const n = values.length;
  const p = Number.isFinite(progress)
    ? progress
    : progress === Infinity
      ? 1
      : 0;
  if (p <= times[0]!) return values[mirrored ? n - 1 : 0]!;
  if (p >= times[n - 1]!) return values[mirrored ? 0 : n - 1]!;

  let segment = 0;
  if (n > 10) {
    let high = n - 1;
    while (high - segment > 1) {
      const middle = (segment + high) >>> 1;
      if (p < times[middle]!) high = middle;
      else segment = middle;
    }
  } else {
    // p < times[last] from the endpoint guard, so the sentinel stops the scan.
    while (p >= times[segment + 1]!) segment++;
  }

  const start = times[segment]!;
  const end = times[segment + 1]!;
  const fromIndex = mirrored ? n - 1 - segment : segment;
  const toIndex = mirrored ? fromIndex - 1 : fromIndex + 1;
  // Capture both endpoints before user easing: reentry/mutation cannot splice
  // two authored states into one sample.
  const from = values[fromIndex]!;
  const to = values[toIndex]!;
  // Validated nondecreasing times plus right-biased lookup make this segment
  // strictly positive-width and local progress finite in [0, 1).
  const local = (p - start) / (end - start);
  let eased = easings[segment]!(local);
  // Keep this guard in the hot function: a separate one-use helper is inlined
  // by Terser as a per-sample FunctionExpression/IIFE in the shipped artifact.
  if (!Number.isFinite(eased)) {
    if (Number.isNaN(eased)) eased = 0;
    else eased = eased > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
  }
  const value = from + (to - from) * eased;
  return Number.isFinite(value) ? value : to;
}
