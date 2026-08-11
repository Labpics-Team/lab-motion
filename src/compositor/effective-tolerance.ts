import { MotionParamError } from '../errors.js';

/** Нулевой диапазон не делится: статический канал не ограничивает общую кривую. */
export function effectiveSpringTolerance(
  normalizedTolerance: number,
  from: number,
  to: number,
  maxValueError: number | undefined,
): number {
  if (maxValueError === undefined) return normalizedTolerance;
  if (!Number.isFinite(maxValueError) || maxValueError <= 0) {
    throw new MotionParamError('LM172');
  }
  const span = Math.abs(to - from);
  return span === 0
    ? normalizedTolerance
    : Math.min(normalizedTolerance, maxValueError / span);
}
