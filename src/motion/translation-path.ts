import { sampleSerializedSpringIntoUnchecked } from '../compositor/sample.js';
import { BASE_GRID_MAX } from '../compositor/segmenter.js';
import { sampleSpringBasisUnchecked } from '../internal/solver.js';
import { sample, SPRING_POSITION_TOLERANCE, type Program } from './program.js';

export interface TranslationPath {
  frames: Keyframe[];
  duration: number;
  x: Float64Array;
  y: Float64Array;
}
const basis = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };
const sampled = { value: 0, velocity: 0 };

function axisStops(program: Program, times: Set<number>): number | undefined {
  const seg = program._segments[0]!, spring = seg._timing._spring;
  if (program._segments.length !== 1 || !spring || program._duration !== seg._end) return;
  const start = seg._from[0]!, end = seg._to[0]!, speed = seg._velocity[0]!;
  if (Math.max(Math.abs(start), Math.abs(end)) * Number.EPSILON > SPRING_POSITION_TOLERANCE / 8) return;
  times.add(seg._at); times.add(seg._end);
  if (seg._artifact) {
    const points = seg._artifact[1];
    for (let i = 2; i < points.length - 2; i += 2) times.add(seg._at + points[i]! / 100 * seg._artifact[2]);
    return seg._at;
  }
  if (start !== end || speed === 0) return;
  const omega = Math.sqrt(spring.stiffness / spring.mass);
  const acceleration = Math.hypot(omega, spring.damping / spring.mass);
  let t = seg._at, tangent = t;
  for (;;) {
    sampleSpringBasisUnchecked(spring, (t - seg._at) / 1000, basis);
    const displacement = speed * basis._valueV0;
    if (t === seg._end) return Math.abs(displacement) <= SPRING_POSITION_TOLERANCE / 4 ? tangent : undefined;
    // Energy decreases throughout the remaining interval, so this bounds |x''| even between samples.
    const bound = acceleration * Math.hypot(omega * displacement, speed * basis._velocityV0);
    const first = t === seg._at;
    const step = 1000 * Math.sqrt((first ? .5 : 4) * SPRING_POSITION_TOLERANCE / bound);
    const next = Math.min(seg._end, t + step);
    if (!(next > t) || times.size >= BASE_GRID_MAX) return;
    if (first) tangent = next;
    times.add(next);
    t = next;
  }
}
export function compileTranslationPath(x: Program, y: Program): TranslationPath | undefined {
  const duration = Math.max(x._duration,y._duration), times = new Set([0,duration]);
  const tx = axisStops(x,times), ty = axisStops(y,times);
  if (tx === undefined || ty === undefined || times.size > BASE_GRID_MAX) return;
  const offsets = [...times].sort((a,b)=>a-b);
  const xs = new Float64Array(2*offsets.length), ys = new Float64Array(xs.length);
  const value = [0], velocity = [0];
  function coordinate(program:Program,tangent:number,time:number):number {
    const seg=program._segments[0]!;
    if (time > seg._at && time <= tangent && time < seg._end) return seg._from[0]! + seg._velocity[0]! * ((time-seg._at)/1000);
    sample(program,time,value,velocity);
    return value[0]!;
  }
  const frames=offsets.map((time,i)=>{
    const offset=time/duration, index=i*2;
    xs[index]=ys[index]=offset*100;
    const a=xs[index+1]=coordinate(x,tx,time), b=ys[index+1]=coordinate(y,ty,time);
    return {offset,transform:`translate(${a}px,${b}px)`};
  });
  return {frames,duration,x:xs,y:ys};
}
export function sampleTranslationPath(path:TranslationPath,axis:'x'|'y',time:number,value:number[],velocity:number[],rate:number):void {
  sampleSerializedSpringIntoUnchecked(path[axis],path.duration,time,0,sampled);
  value[0]=sampled.value;
  velocity[0]=rate*sampled.velocity;
}
