/** Tiny host-free numeric core shared by MotionProgram parsing and web runtimes. */

export const SCHEDULE_V1_INT32_MAX = 0x7fff_ffff;
export const SCHEDULE_V1_MAX_EXACT_ITERATION = Number.MAX_SAFE_INTEGER;
export const SCHEDULE_V1_ITERATION_OUT_OF_RANGE = -1;

const BINARY64_MIN_NORMAL = 2 ** -1022;

/** Maximum adjacent binary64 gap in the binade of an absolute magnitude. */
export function scheduleV1Binary64Gap(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < BINARY64_MIN_NORMAL) return Number.MIN_VALUE;
  let exponent = Math.min(1023, Math.floor(Math.log2(magnitude)));
  const lower = 2 ** exponent;
  if (magnitude < lower) exponent--;
  else if (magnitude >= lower * 2) exponent++;
  return 2 ** (exponent - 52);
}

/** Canonical RN64 order: multiply the cycle first, then add absolute start. */
export function scheduleV1IterationBoundary(
  start: number,
  cycle: number,
  iteration: number,
): number {
  return iteration * cycle + start;
}

/**
 * Greatest canonical absolute boundary not after `time` for a prevalidated
 * schedule and a finite sample at/after `start`.
 *
 * The quotient is only a fast candidate. Absolute RN64 boundaries own the
 * answer: a failed local sandwich falls back to a bounded binary search. For
 * the infinite wire (`repeat === -1`) the first boundary beyond the largest
 * exactly representable integer is the exclusive horizon. This keeps parity
 * portable without BigInt or modulo guesses in any host.
 */
export function scheduleV1GreatestIterationAtOrBefore(
  start: number,
  cycle: number,
  repeat: number,
  time: number,
): number {
  const infinite = repeat === -1;
  const highLimit = infinite ? SCHEDULE_V1_MAX_EXACT_ITERATION : repeat;
  const quotient = Math.floor((time - start) / cycle);
  if (
    infinite &&
    scheduleV1IterationBoundary(
      start,
      cycle,
      SCHEDULE_V1_MAX_EXACT_ITERATION + 1,
    ) <= time
  ) return SCHEDULE_V1_ITERATION_OUT_OF_RANGE;

  const candidate = quotient <= 0
    ? 0
    : quotient >= highLimit
      ? highLimit
      : quotient;
  const boundary = scheduleV1IterationBoundary(start, cycle, candidate);
  if (
    boundary <= time &&
    (candidate === highLimit ||
      scheduleV1IterationBoundary(start, cycle, candidate + 1) > time)
  ) return candidate;

  // At most 31 probes for finite int32 repeat and 53 for infinite schedules.
  let low = 0;
  let high = highLimit;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (scheduleV1IterationBoundary(start, cycle, middle) <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Proves that every non-zero finite V1 phase remains distinguishable after
 * absolute binary64 placement. `repeat === -1` is the portable infinite wire.
 */
export function isScheduleV1Representable(
  start: number,
  duration: number,
  repeat: number,
  repeatDelay: number,
): boolean {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isFinite(repeatDelay) ||
    repeatDelay < 0 ||
    (repeat !== -1 && (
      !Number.isInteger(repeat) || repeat < 0 || repeat > SCHEDULE_V1_INT32_MAX
    ))
  ) return false;

  const firstEnd = start + duration;
  if (
    !Number.isFinite(firstEnd) ||
    (duration > 0 && firstEnd === start)
  ) return false;

  // With no additional iteration, repeatDelay has no boundary to describe.
  // Keep accepting the finite wire value, but do not let its magnitude reject
  // an otherwise representable one-shot track.
  if (repeat === 0) return true;

  const cycle = duration + repeatDelay;
  if (
    !Number.isFinite(cycle) ||
    (duration > 0 && repeatDelay > 0 &&
      (cycle === duration || cycle === repeatDelay)) ||
    (cycle > 0 && start + cycle === start)
  ) return false;

  if (repeat === -1) return cycle > 0;

  const product = repeat * cycle;
  const lastStart = scheduleV1IterationBoundary(start, cycle, repeat);
  const terminal = lastStart + duration;
  if (
    !Number.isFinite(product) ||
    !Number.isFinite(lastStart) ||
    !Number.isFinite(terminal) ||
    (duration > 0 && !(terminal > lastStart))
  ) return false;

  const previousStart = scheduleV1IterationBoundary(start, cycle, repeat - 1);
  const previousEnd = repeatDelay === 0 ? lastStart : previousStart + duration;
  const maxAbsolute = Math.max(Math.abs(start), Math.abs(lastStart), Math.abs(terminal));
  const resolutionBudget =
    scheduleV1Binary64Gap(product) + 2 * scheduleV1Binary64Gap(maxAbsolute);
  const representedDelay = cycle - duration;
  return (
    (!(cycle > 0) || lastStart > previousStart) &&
    (repeatDelay === 0 || previousEnd < lastStart) &&
    (duration === 0 || duration > resolutionBudget) &&
    (repeatDelay === 0 || representedDelay > resolutionBudget)
  );
}
