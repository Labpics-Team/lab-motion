import { BASE_GRID_MAX, impulseSamples } from '../compositor/segmenter.js';
import { sample, SPRING_POSITION_TOLERANCE, type Program } from './program.js';

export interface TranslationPath {
  readonly frames: Keyframe[];
  readonly duration: number;
  readonly x: Program;
  readonly y: Program;
}

function prepare(axis: Program): Program | undefined {
  const seg = axis._segments[0]!, physics = seg._timing._spring;
  if (axis._segments.length !== 1 || !physics || seg._at !== 0 || seg._end !== axis._duration) return;
  const extent = Math.abs(seg._to[0]!) + Math.hypot(seg._to[0]! - seg._from[0]!, seg._velocity[0]! / Math.sqrt(physics.stiffness / physics.mass));
  // Keep translations inside a range where a single-precision compositor coordinate fits the budget.
  if (extent * 2 ** -23 > SPRING_POSITION_TOLERANCE) return;
  if (seg._artifact || seg._impulse) return axis;
  const speed = seg._velocity[0]!, length = seg._end - seg._at;
  if (!speed || seg._from[0] !== seg._to[0]) return;
  const impulse = impulseSamples(physics, speed, length / 1000, SPRING_POSITION_TOLERANCE);
  if (!impulse) return;
  return { ...axis, _segments: [{ ...seg, _impulse: impulse }] };
}

export function compileTranslationPath(horizontal: Program, vertical: Program): TranslationPath | undefined {
  const x = prepare(horizontal), y = prepare(vertical);
  if (!x || !y) return;
  const duration = Math.max(x._duration, y._duration);
  const times = new Set([0, duration]);
  for (const program of [x, y]) {
    const seg = program._segments[0]!, stops = seg._impulse ?? seg._artifact![1];
    let previous = 0;
    for (let i = 2; i < stops.length; i += 2) {
      const time = i === stops.length - 2 ? seg._end : stops[i]! / 100 * seg._end;
      const offset = time / duration;
      if (!(offset > previous)) return;
      times.add(time);
      previous = offset;
    }
  }
  if (times.size > BASE_GRID_MAX) return;
  const a = [0], b = [0], velocity = [0];
  const frames = [...times].sort((first, second) => first - second).map(time => {
    sample(x, time, a, velocity);
    sample(y, time, b, velocity);
    return { offset: time / duration, transform: `translate(${a[0]}px,${b[0]}px)` };
  });
  return { frames, duration, x, y };
}
