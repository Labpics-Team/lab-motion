import { BASE_GRID_MAX, impulseSamples } from '../compositor/segmenter.js';
import { SPRING_POSITION_TOLERANCE, type Program } from './program.js';

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

function cursor(program: Program) {
  const seg = program._segments[0]!, stops = seg._impulse ?? seg._artifact![1];
  const start = seg._from[0]!, goal = seg._to[0]!, span = seg._impulse ? 1 : goal - start;
  let index = 0, previous = 0;
  const stream = {
    _next: 0,
    _read(time: number): number {
      if (time === stream._next) {
        if (time) index += 2;
        previous = time;
        const after = index + 2;
        stream._next = after >= stops.length ? Infinity :
          after === stops.length - 2 ? seg._end : stops[after]! / 100 * seg._end;
      }
      if (time >= seg._end) return goal;
      const fraction = (time - previous) / (stream._next - previous);
      return start + span * ((1 - fraction) * stops[index + 1]! + fraction * stops[index + 3]!);
    },
  };
  return stream;
}

export function compileTranslationPath(horizontal: Program, vertical: Program): TranslationPath | undefined {
  const x = prepare(horizontal), y = prepare(vertical);
  if (!x || !y) return;
  const duration = Math.max(x._duration, y._duration), a = cursor(x), b = cursor(y);
  const frames: Keyframe[] = [];
  let time = 0, previous = -1;
  while (frames.length < BASE_GRID_MAX) {
    const offset = time / duration;
    if (!(offset > previous)) return;
    frames.push({offset, transform: `translate(${a._read(time)}px,${b._read(time)}px)`});
    if (offset === 1) return {frames, duration, x, y};
    previous = offset;
    time = Math.min(a._next, b._next);
  }
  return;
}
