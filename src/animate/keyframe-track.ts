/** Данные авторского track: никакого DOM, owner, scheduler или повторного solver. */
import { MotionParamError } from '../errors.js';
import { keyframeSegment } from '../internal/keyframe-position.js';

export type TrackEasing = (t: number) => number;
export type TrackEase = TrackEasing | readonly TrackEasing[] | undefined;
export const MAX_TRACK_STOPS = 100_000;

export interface KeyframeTrack<T> {
  readonly _values: readonly T[];
  readonly _times: readonly number[];
  readonly _ease: TrackEase;
}

/** Фиксированная длина, own slots и единственное чтение каждого getter. */
export function snapshotTrackArray(source: unknown, maximum: number = MAX_TRACK_STOPS, minimum: number = 1): unknown[] {
  if (!Array.isArray(source)) throw new MotionParamError('LM173');
  const n = source.length;
  if (minimum === 2 && n < 2) throw new MotionParamError('LM141');
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new MotionParamError('LM173');
  const result = new Array<unknown>(n);
  for (let i = 0; i < n; i++) {
    // Дырка не превращается в легальный stop через Array.prototype.
    if (!Object.hasOwn(source, i)) throw new MotionParamError('LM173');
    result[i] = source[i];
  }
  return result;
}

export function trackTimes(n: number, times: readonly number[] | undefined): readonly number[] {
  if (times === undefined) return Array.from({ length: n }, (_, i) => i / (n - 1));
  if (times.length !== n) throw new MotionParamError('LM035');
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(times[i])) throw new MotionParamError('LM036');
    if (i && times[i]! < times[i - 1]!) throw new MotionParamError('LM037');
  }
  if (times[0] !== 0) throw new MotionParamError('LM038');
  if (times[n - 1] !== 1) throw new MotionParamError('LM039');
  return times;
}

export function makeTrack<T>(values: readonly T[], times?: readonly number[], ease?: TrackEase): KeyframeTrack<T> {
  if (Array.isArray(ease) && ease.length !== values.length - 1) throw new MotionParamError('LM040');
  return { _values: values, _times: trackTimes(values.length, times), _ease: ease };
}

function easingAt(ease: TrackEase, segment: number): TrackEasing | undefined {
  return typeof ease === 'function' ? ease : ease?.[segment];
}

/** Только выбор сегмента общий с ./keyframes; codecs принадлежат потребителю. */
export function sampleTrack<T, R>(track: KeyframeTrack<T>, p: number, mix: (a: T, b: T, p: number) => R): R {
  const values = track._values;
  const last = values.length - 1;
  if (p <= 0) return mix(values[0]!, values[0]!, 0);
  if (p >= 1) return mix(values[last]!, values[last]!, 1);
  const s = keyframeSegment(track._times, p);
  const from = values[s]!, to = values[s + 1]!;
  const local = (p - track._times[s]!) / (track._times[s + 1]! - track._times[s]!);
  const eased = easingAt(track._ease, s)?.(local) ?? local;
  return mix(from, to, Number.isFinite(eased) ? eased : local);
}

/** Ограниченная разность: прежний binary64 порядок full-animate tween. */
export function easingRate(ease: TrackEasing, p: number, duration: number): number {
  const low = Math.max(0, p - 1e-3), high = Math.min(1, p + 1e-3);
  const raw = ((ease(high) - ease(low)) * 1000) / ((high - low) * duration);
  return Number.isFinite(raw) ? raw : 0;
}

/** Производная внутри одного правого сегмента, никогда сквозь zero-width jump. */
export function trackVelocity<T>(track: KeyframeTrack<T>, p: number, durationMs: number): { _from: T; _to: T; _dpdt: number } {
  const times = track._times;
  const s = p >= 1 ? times.length - 2 : keyframeSegment(times, Math.max(0, p));
  const width = times[s + 1]! - times[s]!;
  let rate = 0;
  if (p >= 0 && p < 1 && width > 0 && !(p === 0 && times[1] === 0)) {
    const local = (p - times[s]!) / width;
    const ease = easingAt(track._ease, s);
    rate = ease ? easingRate(ease, local, durationMs * width) : (1000 / durationMs) / width;
  }
  return { _from: track._values[s]!, _to: track._values[s + 1]!, _dpdt: Number.isFinite(rate) ? rate : 0 };
}
