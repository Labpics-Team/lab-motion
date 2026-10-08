import { tryParseValue } from '../value/parse.js';
import { settleTimeUpperBound } from '../spring.js';
import { sampleSpringBasisUnchecked, type MutableSpringBasis } from '../internal/solver.js';
import { tryCompileSpringExecutionArtifactTupleUnchecked, type SpringExecutionArtifactTuple } from '../compositor/curve.js';
import { sampleSerializedSpringIntoUnchecked } from '../compositor/sample.js';
import { MotionError, number } from './model.js';
import type { MotionScalar, Timing } from './types.js';

export const TRANSFORMS: Readonly<Record<string, number>> = { x: 0, y: 0, rotate: 0, skewX: 0, skewY: 0, scaleX: 1, scaleY: 1 };
export const isTransform = (key: string): boolean => Object.hasOwn(TRANSFORMS, key);
const PIXELS = /^(?:width|height|min-width|max-width|min-height|max-height|top|right|bottom|left|margin(?:-.+)?|padding(?:-.+)?|gap|row-gap|column-gap|border(?:-.+)?-width|border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius|font-size|letter-spacing|outline-width|outline-offset)$/;

export interface Point { readonly _coordinates: readonly number[]; readonly unit: string }
export function point(key: string, input: MotionScalar, reference?: Point): Point {
  if (isTransform(key) || key === 'opacity') return { _coordinates: [number(input, key)], unit: '' };
  const ast = tryParseValue(input);
  if (!ast) throw new MotionError(`${key}: неподдерживаемое CSS-значение ${String(input)}`);
  if (ast.kind === 'unit') return { _coordinates: [ast.value], unit: typeof input === 'number' && PIXELS.test(key) ? 'px' : ast.unit };
  if (ast.kind === 'relative') {
    if (!reference || reference._coordinates.length !== 1 || ast.unit && ast.unit !== reference.unit)
      throw new MotionError(`${key}: относительное значение требует совместимой единицы`);
    return { _coordinates: [reference._coordinates[0]! + (ast.op === '+' ? ast.amount : -ast.amount)], unit: reference.unit };
  }
  if (ast.kind === 'color') return { _coordinates: [ast.r * ast.r, ast.g * ast.g, ast.b * ast.b, ast.a], unit: 'color' };
  throw new MotionError(`${key}: неразрешённая CSS-переменная`);
}
export function format(key: string, value: readonly number[], unit: string): string {
  if (unit === 'color') {
    const channel = (i: number): number => Math.sqrt(Math.max(0, Math.min(65025, value[i]!)));
    return `rgba(${channel(0)},${channel(1)},${channel(2)},${Math.max(0, Math.min(1, value[3]!))})`;
  }
  const n = key === 'opacity' ? Math.max(0, Math.min(1, value[0]!)) : value[0]!;
  return `${n === 0 ? 0 : n}${unit}`;
}
export function transform(values: Readonly<Record<string, number>>): string {
  // Одинаковая топология сохраняет независимые оси и авторские полные обороты.
  return `translate(${values.x ?? 0}px,${values.y ?? 0}px) rotate(${values.rotate ?? 0}deg) skew(${values.skewX ?? 0}deg,${values.skewY ?? 0}deg) scale(${values.scaleX ?? 1},${values.scaleY ?? 1})`;
}

export interface Segment {
  readonly at: number;
  readonly end: number;
  readonly from: readonly number[];
  readonly to: readonly number[];
  readonly velocity: readonly number[];
  readonly timing: Timing;
  readonly artifact: SpringExecutionArtifactTuple | undefined;
}
export interface Program {
  readonly key: string;
  readonly unit: string;
  readonly _segments: readonly Segment[];
  readonly duration: number;
  readonly final: readonly number[];
  /** Только точная форма, доступная нативному исполнителю. */
  readonly _nativeEase: string | undefined;
  readonly _identity: readonly unknown[] | undefined;
}

function segment(from: Point, to: Point, velocity: readonly number[], timing: Timing, at: number, duration?: number): Segment {
  if (from.unit !== to.unit || from._coordinates.length !== to._coordinates.length)
    throw new MotionError('Начальное и конечное значения должны иметь совместимые единицы');
  let normalized: number | undefined;
  let aligned = true, extent = 1;
  for (let i = 0; i < from._coordinates.length; i++) {
    const distance = to._coordinates[i]! - from._coordinates[i]!;
    if (!Number.isFinite(distance)) throw new MotionError('Диапазон движения превышает представимые значения');
    const v = velocity[i] ?? 0;
    extent = Math.max(extent, Math.abs(distance));
    if (distance === 0) { if (v !== 0) aligned = false; }
    else if (normalized === undefined) normalized = v / distance;
    else if (normalized !== v / distance) aligned = false;
  }
  let artifact: SpringExecutionArtifactTuple | undefined;
  let length = duration ?? timing.duration ?? 0;
  if (timing.spring) {
    if (aligned && Number.isFinite(normalized ?? 0)) artifact = tryCompileSpringExecutionArtifactTupleUnchecked(timing.spring, normalized ?? 0, Math.min(0.001, 0.05 / extent));
    const energy = velocity.reduce((max, v) => Math.max(max, Math.abs(v)), 0) / extent;
    length = artifact?.[2] ?? settleTimeUpperBound(timing.spring, energy) * 1000;
  }
  if (!Number.isFinite(length) || length < 0 || !Number.isFinite(at + length)) throw new MotionError('Непредставимая длительность движения');
  return { at, end: at + length, from: from._coordinates, to: to._coordinates, velocity, timing, artifact };
}

export function program(key: string, from: Point, values: readonly MotionScalar[], authored: boolean, timing: Timing, initialVelocity: readonly number[], offset = 0): Program {
  const resolved: Point[] = [];
  let current = from;
  for (const input of values) { current = point(key, input, current); resolved.push(current); }
  if (!authored) resolved.unshift(from);
  const times = authored ? timing.times : undefined;
  if (times && times.length !== resolved.length) throw new MotionError('Число times должно совпадать с числом значений');
  if (timing.spring && resolved.length > 2) throw new MotionError('Многоточечная траектория использует duration/ease');
  const velocity = authored ? resolved[0]!._coordinates.map(() => 0) : [...initialVelocity];
  const _segments: Segment[] = [];
  const duration = timing.duration ?? 0;
  for (let i = 0; i < resolved.length - 1; i++) {
    const a = times?.[i] ?? i / (resolved.length - 1);
    const b = times?.[i + 1] ?? (i + 1) / (resolved.length - 1);
    _segments.push(segment(resolved[i]!, resolved[i + 1]!, i === 0 ? velocity : resolved[i]!._coordinates.map(() => 0), timing,
      offset + timing.delay + a * duration, (b - a) * duration));
  }
  const last = _segments.at(-1)!;
  const first = _segments[0]!;
  const _identity = authored ? undefined : [resolved[0]!.unit, ...last.to, timing.spring?.mass, timing.spring?.stiffness, timing.spring?.damping,
    timing.duration, timing.cssEase ?? timing.ease, timing.delay + offset];
  return { key, unit: resolved[0]!.unit, _segments, duration: last.end, final: last.to,
    _nativeEase: resolved[0]!.unit === 'color' || key === 'opacity' && resolved.some(p => p._coordinates[0]! < 0 || p._coordinates[0]! > 1) ? undefined : _segments.length === 1 ? first.artifact?.[0] ?? (timing.spring ? undefined : timing.cssEase) : undefined,
    _identity };
}

const basis: MutableSpringBasis = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };
const springSample = { value: 0, velocity: 0 };
export function sample(program: Program, time: number, value: number[], velocity: number[]): void {
  const _segments = program._segments;
  if (time >= program.duration) {
    for (let i = 0; i < program.final.length; i++) { value[i] = program.final[i]!; velocity[i] = 0; }
    return;
  }
  let at = 0;
  while (at + 1 < _segments.length && time >= _segments[at + 1]!.at) at++;
  const segment = _segments[at]!;
  const _elapsed = Math.max(0, time - segment.at), duration = segment.end - segment.at;
  if (time >= segment.end) {
    for (let i = 0; i < segment.to.length; i++) { value[i] = segment.to[i]!; velocity[i] = 0; }
    return;
  }
  let p = duration === 0 ? 1 : Math.min(1, _elapsed / duration), dp = 0;
  if (segment.artifact) {
    sampleSerializedSpringIntoUnchecked(segment.artifact[1], duration, _elapsed, 0, springSample);
    p = springSample.value; dp = springSample.velocity;
  } else if (segment.timing.spring) {
    sampleSpringBasisUnchecked(segment.timing.spring, _elapsed / 1000, basis);
  } else if (_elapsed > 0 && p < 1) {
    const low = Math.max(0, p - 0.001), high = Math.min(1, p + 0.001);
    const ease = segment.timing.ease;
    dp = (ease(high) - ease(low)) * 1000 / ((high - low) * duration);
    p = ease(p);
  }
  if (!Number.isFinite(p) || !Number.isFinite(dp)) throw new MotionError('Easing вернул нечисловой результат');
  for (let i = 0; i < segment.from.length; i++) {
    const a = segment.from[i]!, distance = segment.to[i]! - a;
    if (_elapsed === 0) { value[i] = a; velocity[i] = time < segment.at ? 0 : segment.velocity[i] ?? 0; }
    else if (segment.timing.spring && !segment.artifact) {
      value[i] = a + distance * basis._value + (segment.velocity[i] ?? 0) * basis._valueV0;
      velocity[i] = distance * basis._velocity + (segment.velocity[i] ?? 0) * basis._velocityV0;
    } else { value[i] = a + distance * p; velocity[i] = distance * dp; }
    if (!Number.isFinite(value[i]) || !Number.isFinite(velocity[i])) throw new MotionError('Движение вышло за представимый диапазон');
  }
}
