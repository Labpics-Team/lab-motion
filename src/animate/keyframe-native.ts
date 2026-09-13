/** Native lowering только доказуемо линейных numeric surfaces. */
import { buildTransform } from '../value/transform.js';
import { mixChannel, type BoundGroup } from './channels.js';
import { sampleTrack, MAX_TRACK_STOPS } from './keyframe-track.js';

export interface KeyframeArtifact {
  readonly _frames: Record<string, string | number>[];
  readonly _durationMs: number;
}

export function nativeKeyframeArtifact(bound: BoundGroup, group: string, durationMs: number): KeyframeArtifact | undefined {
  if (bound._css || (group !== 'transform' && group !== 'opacity')) return undefined;
  const offsets = new Set<number>();
  for (const ch of bound._numeric) {
    const track = ch._track!;
    // Произвольную JS-функцию нельзя сертифицировать конечным sampling.
    if (track._ease !== undefined) return undefined;
    for (let i = 0; i < track._times.length; i++) {
      const t = track._times[i]!;
      // Endpoint-pin и zero-width jump оставляем точному shared sampler.
      if (i && (t <= track._times[i - 1]! || !Number.isFinite(track._values[i]! - track._values[i - 1]!))) return undefined;
      offsets.add(t);
    }
  }
  // Объединение различных topology не должно квадратично раздувать native data.
  // Точный sampler хранит исходные tracks без этой Cartesian expansion.
  if (offsets.size * bound._numeric.length > MAX_TRACK_STOPS) return undefined;
  const frames: KeyframeArtifact['_frames'] = [];
  let signature = '';
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    let value: string | number;
    if (group === 'transform') {
      const state = bound._transform!;
      for (const ch of bound._numeric) state[ch._key] = sampleTrack(ch._track!, offset, mixChannel);
      value = buildTransform(state);
      // Разные function-lists заставляют WAAPI перейти к matrix decomposition;
      // это уже не независимая интерполяция осей. 'none' — законная identity.
      const shape = value === 'none' ? '' : value.replace(/\([^)]*\)/g, '');
      if (signature && shape && signature !== shape) return undefined;
      signature ||= shape;
    } else value = sampleTrack(bound._numeric[0]!._track!, offset, mixChannel);
    frames.push({ offset, [group]: value });
  }
  // Повторный play использует тот же owned artifact: duck-host не может
  // незаметно переписать authored track через полученный keyframe-массив.
  for (const frame of frames) Object.freeze(frame);
  Object.freeze(frames);
  return { _frames: frames, _durationMs: durationMs };
}
