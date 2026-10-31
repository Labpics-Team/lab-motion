import { tryParseValue } from '../value/parse.js';
import { settleTimeUpperBound } from '../spring.js';
import { sampleSpringBasisUnchecked, type MutableSpringBasis } from '../internal/solver.js';
import { tryCompileSpringExecutionArtifactTupleUnchecked, type SpringExecutionArtifactTuple } from '../compositor/curve.js';
import { sampleSerializedSpringIntoUnchecked } from '../compositor/sample.js';
import { failMotion, number, type Timing } from './model.js';
import type { MotionScalar } from './types.js';

export const SPRING_POSITION_TOLERANCE = 0.05;
export const TRANSFORMS: Readonly<Record<string, number>> = { x: 0, y: 0, rotate: 0, skewX: 0, skewY: 0, scaleX: 1, scaleY: 1 };
export const isTransform = (key: string): boolean => Object.hasOwn(TRANSFORMS, key);
const PIXELS = /^(?:width|height|min-width|max-width|min-height|max-height|top|right|bottom|left|margin(?:-.+)?|padding(?:-.+)?|gap|row-gap|column-gap|border(?:-.+)?-width|border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius|font-size|letter-spacing|outline-width|outline-offset)$/;

export interface Point { readonly _coordinates: readonly number[]; readonly _unit: string }
export function point(key: string, input: MotionScalar, reference?: Point): Point {
  if (isTransform(key) || key === 'opacity') return { _coordinates: [number(input, key)], _unit: '' };
  const ast = tryParseValue(input);
  if (!ast) failMotion(`${key}: неподдерживаемый CSS ${String(input)}`);
  if (ast.kind === 'unit') return { _coordinates: [ast.value], _unit: typeof input === 'number' && PIXELS.test(key) ? 'px' : ast.unit };
  if (ast.kind === 'relative') {
    if (!reference || reference._coordinates.length !== 1 || ast.unit && ast.unit !== reference._unit)
      failMotion(`${key}: несовместимая единица относительного значения`);
    return { _coordinates: [reference._coordinates[0]! + (ast.op === '+' ? ast.amount : -ast.amount)], _unit: reference._unit };
  }
  if (ast.kind === 'color') return { _coordinates: [ast.r * ast.r, ast.g * ast.g, ast.b * ast.b, ast.a], _unit: 'color' };
  failMotion(`${key}: неразрешённая CSS-переменная`);
}
function colorChannel(value: number): number { return Math.sqrt(Math.max(0, Math.min(65025, value))); }

export function format(key: string, value: readonly number[], unit: string): string {
  if (unit === 'color') {
    return `rgba(${colorChannel(value[0]!)},${colorChannel(value[1]!)},${colorChannel(value[2]!)},${Math.max(0, Math.min(1, value[3]!))})`;
  }
  const n = key === 'opacity' ? Math.max(0, Math.min(1, value[0]!)) : value[0]!;
  return `${n}${unit}`;
}
export function transform(values: Readonly<Record<string, number>>, translationOnly = false): string {
  const translation = `translate(${values.x ?? 0}px,${values.y ?? 0}px)`;
  // Полная топология сохраняется для любой активной оси помимо x/y.
  return translationOnly ? translation : `${translation} rotate(${values.rotate ?? 0}deg) skew(${values.skewX ?? 0}deg,${values.skewY ?? 0}deg) scale(${values.scaleX ?? 1},${values.scaleY ?? 1})`;
}

export interface Segment {
  readonly _at: number;
  readonly _end: number;
  readonly _from: readonly number[];
  readonly _to: readonly number[];
  readonly _velocity: readonly number[];
  readonly _timing: Timing;
  readonly _artifact: SpringExecutionArtifactTuple | undefined;
}
export interface Program {
  readonly _key: string;
  readonly _unit: string;
  readonly _segments: readonly Segment[];
  readonly _duration: number;
  readonly _final: readonly number[];
  /** Только точная форма, доступная нативному исполнителю. */
  readonly _nativeEase: string | undefined;
  readonly _identity: readonly unknown[] | undefined;
}

function segment(from: Point, to: Point, velocity: readonly number[], timing: Timing, at: number, duration?: number): Segment {
  if (from._unit !== to._unit || from._coordinates.length !== to._coordinates.length)
    failMotion('Разные единицы from/to');
  let normalized: number | undefined;
  let aligned = true, extent = 1;
  for (let i = 0; i < from._coordinates.length; i++) {
    const distance = to._coordinates[i]! - from._coordinates[i]!;
    if (!Number.isFinite(distance)) failMotion('Диапазон вне Number');
    const v = velocity[i] ?? 0;
    extent = Math.max(extent, Math.abs(distance));
    if (distance === 0) { if (v !== 0) aligned = false; }
    else if (normalized === undefined) normalized = v / distance;
    else if (normalized !== v / distance) aligned = false;
  }
  let artifact: SpringExecutionArtifactTuple | undefined;
  let length = duration ?? timing._duration ?? 0;
  if (timing._spring) {
    if (aligned && Number.isFinite(normalized ?? 0)) artifact = tryCompileSpringExecutionArtifactTupleUnchecked(timing._spring, normalized ?? 0, Math.min(0.001, SPRING_POSITION_TOLERANCE / extent));
    const energy = velocity.reduce((max, v) => Math.max(max, Math.abs(v)), 0) / extent;
    length = artifact?.[2] ?? settleTimeUpperBound(timing._spring, energy) * 1000;
  }
  if (!Number.isFinite(length) || length < 0 || !Number.isFinite(at + length) || length > 0 && at + length === at) failMotion('Непредставимая длительность');
  return { _at: at, _end: at + length, _from: from._coordinates, _to: to._coordinates, _velocity: velocity, _timing: timing, _artifact: artifact };
}

export function program(key: string, from: Point, values: readonly MotionScalar[], authored: boolean, timing: Timing, initialVelocity: readonly number[], offset = 0): Program {
  // _draft уже разобрал первый authored keyframe; используем готовый снимок.
  const resolved: Point[] = [from];
  let current = from;
  for (let i = authored ? 1 : 0; i < values.length; i++) {
    current = point(key, values[i]!, current); resolved.push(current);
  }
  const times = authored ? timing._times : undefined;
  if (times && times.length !== resolved.length) failMotion('times: другая длина');
  if (timing._spring && resolved.length > 2) failMotion('keyframes: задайте duration/ease');
  // _draft и layout передают собственный снимок; Segment читает его без мутаций.
  const _segments: Segment[] = [];
  const duration = timing._duration ?? 0;
  for (let i = 0; i < resolved.length - 1; i++) {
    const a = times?.[i] ?? i / (resolved.length - 1);
    const b = times?.[i + 1] ?? (i + 1) / (resolved.length - 1);
    _segments.push(segment(resolved[i]!, resolved[i + 1]!, i === 0 ? initialVelocity : resolved[i]!._coordinates.map(() => 0), timing,
      offset + timing._delay + a * duration, (b - a) * duration));
  }
  const last = _segments.at(-1)!;
  const first = _segments[0]!;
  const _identity = authored ? undefined : [from._unit, ...last._to, timing._spring?.mass, timing._spring?.stiffness, timing._spring?.damping,
    timing._duration, timing._cssEase ?? timing._ease, timing._delay + offset];
  return { _key: key, _unit: from._unit, _segments, _duration: last._end, _final: last._to,
    _nativeEase: from._unit === 'color' || key === 'opacity' && resolved.some(p => p._coordinates[0]! < 0 || p._coordinates[0]! > 1) ? undefined : _segments.length === 1 ? first._artifact?.[0] ?? (timing._spring ? undefined : timing._cssEase) : undefined,
    _identity };
}

const basis: MutableSpringBasis = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };
const springSample = { value: 0, velocity: 0 };
export function sample(program: Program, time: number, value: number[], velocity: number[], rate: number = 1): void {
  const _segments = program._segments;
  if (time >= program._duration) {
    for (let i = 0; i < program._final.length; i++) { value[i] = program._final[i]!; velocity[i] = 0; }
    return;
  }
  let at = 0;
  while (at + 1 < _segments.length && time >= _segments[at + 1]!._at) at++;
  const segment = _segments[at]!;
  const _elapsed = Math.max(0, time - segment._at), duration = segment._end - segment._at;
  if (time >= segment._end) {
    for (let i = 0; i < segment._to.length; i++) { value[i] = segment._to[i]!; velocity[i] = 0; }
    return;
  }
  let p = duration === 0 ? 1 : Math.min(1, _elapsed / duration), dp = 0;
  if (segment._artifact) {
    sampleSerializedSpringIntoUnchecked(segment._artifact[1], duration, _elapsed, 0, springSample);
    p = springSample.value; dp = springSample.velocity;
  } else if (segment._timing._spring) {
    sampleSpringBasisUnchecked(segment._timing._spring, _elapsed / 1000, basis);
  } else if (_elapsed > 0 && p < 1) {
    const low = Math.max(0, p - 0.001), high = Math.min(1, p + 0.001);
    const ease = segment._timing._ease;
    dp = (ease(high) - ease(low)) * 1000 / ((high - low) * duration);
    p = ease(p);
  }
  if (!Number.isFinite(p) || !Number.isFinite(dp)) failMotion('easing: не число');
  for (let i = 0; i < segment._from.length; i++) {
    const a = segment._from[i]!, distance = segment._to[i]! - a;
    if (_elapsed === 0) { value[i] = a; velocity[i] = time < segment._at ? 0 : segment._velocity[i] ?? 0; }
    else if (segment._timing._spring && !segment._artifact) {
      value[i] = a + distance * basis._value + (segment._velocity[i] ?? 0) * basis._valueV0;
      velocity[i] = distance * basis._velocity + (segment._velocity[i] ?? 0) * basis._velocityV0;
    } else { value[i] = a + distance * p; velocity[i] = distance * dp; }
    if (rate !== 1) velocity[i] = rate === 0 ? 0 : velocity[i]! * rate;
    if (!Number.isFinite(value[i]) || !Number.isFinite(velocity[i])) failMotion('Переполнение при sample');
  }
}
