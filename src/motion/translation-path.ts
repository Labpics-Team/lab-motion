import { tryCompileSpringExecutionArtifactTupleUnchecked as curve, type SpringExecutionArtifactTuple } from '../compositor/curve.js';
import { sampleSerializedSpringIntoUnchecked as sample } from '../compositor/sample.js';
import { BASE_GRID_MAX } from '../compositor/segmenter.js';
import { SPRING_POSITION_TOLERANCE, type Program } from './program.js';

interface Axis {
  _base: number;
  _span: number;
  _delay: number;
  _curve: SpringExecutionArtifactTuple;
  _subtract?: SpringExecutionArtifactTuple;
}
export interface TranslationPath {
  readonly frames: Keyframe[];
  readonly duration: number;
  readonly x: Axis;
  readonly y: Axis;
}
function axis(program: Program): Axis | undefined {
  if (program._segments.length !== 1) return;
  const seg = program._segments[0]!, physics = seg._timing._spring;
  if (!physics || program._duration !== seg._end) return;
  const start = seg._from[0]!, end = seg._to[0]!, velocity = seg._velocity[0]!;
  if (Math.max(Math.abs(start), Math.abs(end)) * Number.EPSILON > SPRING_POSITION_TOLERANCE / 8) return;
  if (seg._artifact) return { _base:start, _span:end-start, _delay:seg._at, _curve:seg._artifact };
  if (start !== end || !velocity) return;
  const omega = Math.sqrt(physics.stiffness/physics.mass);
  const span = velocity/omega;
  const tolerance = Math.min(.001, SPRING_POSITION_TOLERANCE/(4*Math.abs(span)));
  if (!Number.isFinite(span) || !tolerance || Math.abs(span)*Number.EPSILON > SPRING_POSITION_TOLERANCE/8) return;
  // Difference of two unit responses cancels their positional term and leaves only momentum.
  const a = curve(physics, omega, tolerance), b = curve(physics, 0, tolerance);
  if (!a || !b || seg._at + Math.max(a[2], b[2]) > seg._end) return;
  return { _base:start, _span:span, _delay:seg._at, _curve:a, _subtract:b };
}
const state = {value:0,velocity:0}, zero = {value:0, velocity:0};
function at(axis: Axis, time: number, out: {value:number; velocity:number}): void {
  const first = axis._curve, second=axis._subtract;
  sample(first[1],first[2],time,axis._delay,out);
  if (second) {
    sample(second[1],second[2],time,axis._delay,zero);
    out.value -= zero.value;
    out.velocity -= zero.velocity;
  }
  out.value = axis._base + axis._span*out.value;
  out.velocity *= axis._span;
}
export function compileTranslationPath(px: Program, py: Program): TranslationPath | undefined {
  const x=axis(px), y=axis(py);
  if (!x || !y) return;
  const duration=Math.max(px._duration,py._duration), times=new Set([0,duration]);
  for (const coord of [x,y]) for (const part of [coord._curve,coord._subtract]) {
    if (!part) continue;
    for (let i=0;i<part[1].length;i+=2) times.add(coord._delay + part[1][i]!/100*part[2]);
    if (times.size > BASE_GRID_MAX) return;
  }
  const frames = [...times].sort((a,b)=>a-b).map(time=>{
    at(x,time,state);
    const horizontal=state.value;
    at(y,time,state);
    return {offset:time/duration,transform:`translate(${horizontal}px,${state.value}px)`};
  });
  return {x,y,duration,frames};
}
export function sampleTranslationPath(path: TranslationPath, key: 'x'|'y', time:number, value:number[], velocity:number[], rate:number):void {
  at(path[key],time,state);
  value[0]=state.value;
  velocity[0]=state.velocity*rate;
}
