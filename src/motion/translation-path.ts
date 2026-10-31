import { sampleSerializedSpringIntoUnchecked } from '../compositor/sample.js';
import { BASE_GRID_MAX } from '../compositor/segmenter.js';
import { motionSpringNodes } from './spring-artifact.js';
import { sample, SPRING_POSITION_TOLERANCE, type Program } from './program.js';

export interface TranslationPath {
  frames: Keyframe[];
  duration: number;
  x: Float64Array;
  y: Float64Array;
}
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
  const length = seg._end - seg._at;
  const nodes = motionSpringNodes(spring, 0, speed, length/1000, SPRING_POSITION_TOLERANCE);
  if (!nodes) return;
  for (const node of nodes) times.add(seg._at + node.percent/100 * length);
  return seg._at + nodes[1]!.percent/100 * length;
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
