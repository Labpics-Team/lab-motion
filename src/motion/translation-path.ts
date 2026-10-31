import { BASE_GRID_MAX } from '../compositor/segmenter.js';
import { emitArtifact } from '../compositor/curve.js';
import { motionSpringNodes } from './spring-artifact.js';
import { sample, SPRING_POSITION_TOLERANCE, type Program } from './program.js';

export interface TranslationPath {
  readonly frames: Keyframe[];
  readonly duration: number;
  readonly x: Program;
  readonly y: Program;
}

function prepare(axis: Program): Program | undefined {
  const seg = axis._segments[0]!, physics = seg._timing._spring;
  if (axis._segments.length !== 1 || !physics || seg._end !== axis._duration) return;
  if (Math.max(Math.abs(seg._from[0]!), Math.abs(seg._to[0]!)) * Number.EPSILON > SPRING_POSITION_TOLERANCE / 8) return;
  if (seg._artifact || seg._impulse) return axis;
  const speed = seg._velocity[0]!, length = seg._end - seg._at;
  if (!speed || seg._from[0] !== seg._to[0]) return;
  const nodes = motionSpringNodes(physics, 0, speed, length/1000, SPRING_POSITION_TOLERANCE);
  if (!nodes) return;
  const impulse = emitArtifact(nodes, SPRING_POSITION_TOLERANCE, length)[1];
  return { ...axis, _segments: [{ ...seg, _impulse: impulse }] };
}

export function compileTranslationPath(horizontal: Program, vertical: Program): TranslationPath | undefined {
  const x = prepare(horizontal), y = prepare(vertical);
  if (!x || !y) return;
  const duration = Math.max(x._duration, y._duration), times = new Set([0, duration]);
  for (const program of [x, y]) {
    const seg = program._segments[0]!, stops = seg._impulse ?? seg._artifact![1];
    times.add(seg._at); times.add(seg._end);
    for (let i = 2; i < stops.length - 2; i += 2) times.add(seg._at + stops[i]!/100 * (seg._end - seg._at));
  }
  if (times.size > BASE_GRID_MAX) return;
  const a = [0], b = [0], velocity = [0];
  const frames = [...times].sort((first,second)=>first-second).map(time => {
    sample(x,time,a,velocity); sample(y,time,b,velocity);
    return { offset:time/duration, transform:`translate(${a[0]}px,${b[0]}px)` };
  });
  return { frames, duration, x, y };
}
