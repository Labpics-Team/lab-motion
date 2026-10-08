import { cubicBezierUnchecked } from '../internal/cubic-bezier.js';
import { validateSpringForFrameLoop, type SpringParams } from '../spring.js';
import type { MotionOptions, MotionProperties, MotionScalar, MotionSpring, Timing, MotionResult } from './types.js';

export class MotionError extends Error {
  constructor(message: string) { super(message); this.name = 'MotionError'; }
}
export const MAX_CHANNELS = 100_000;
export const FINISHED: MotionResult = Object.freeze({ status: 'finished' as const });
export const STOPPED: MotionResult = Object.freeze({ status: 'stopped' as const });
const linear = (t: number): number => t;
const EASES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  standard: [.2, 0, 0, 1], ease: [.25, .1, .25, 1],
  'ease-in': [.42, 0, 1, 1], 'ease-out': [0, 0, .58, 1], 'ease-in-out': [.42, 0, .58, 1],
};
const standard: (t: number) => number = cubicBezierUnchecked(.2, 0, 0, 1);

export function number(value: unknown, name: string, minimum: number = -Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    throw new MotionError(`${name}: ожидается конечное число${minimum === -Infinity ? '' : ` не меньше ${minimum}`}`);
  return value;
}
export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MotionError(`${name}: ожидается объект`);
  return value as Record<string, unknown>;
}
export function snapshot<T>(input: readonly T[], name: string, minimum = 0): T[] {
  if (!Array.isArray(input)) throw new MotionError(`${name}: ожидается массив`);
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < minimum || length > MAX_CHANNELS)
    throw new MotionError(`${name}: недопустимая длина`);
  const result: T[] = [];
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(input, i)) throw new MotionError(`${name}: пропущено значение ${i}`);
    result.push(input[i]!);
  }
  return result;
}

export function physics(input: MotionSpring | undefined): SpringParams {
  if (input === undefined) return { mass: 1, stiffness: 170, damping: 26 };
  const source = record(input, 'spring');
  const keys = Object.keys(source);
  if (keys.some(key => !['mass', 'stiffness', 'damping', 'response', 'bounce'].includes(key)))
    throw new MotionError('spring: неизвестный параметр');
  const { mass, stiffness, damping, response, bounce } = source;
  let result: SpringParams;
  if (mass !== undefined || stiffness !== undefined || damping !== undefined) {
    if (response !== undefined || bounce !== undefined) throw new MotionError('spring: выберите response/bounce или физические параметры');
    result = { mass: number(mass, 'mass', Number.MIN_VALUE), stiffness: number(stiffness, 'stiffness', Number.MIN_VALUE), damping: number(damping, 'damping', Number.MIN_VALUE) };
  } else {
    const period = number(response ?? 320, 'response', Number.MIN_VALUE);
    const b = number(bounce ?? 0, 'bounce', 0);
    if (b >= 1) throw new MotionError('bounce должен быть меньше 1');
    const frequency = (2 * Math.PI * 1000) / period;
    result = { mass: 1, stiffness: frequency * frequency, damping: 2 * (1 - b) * frequency };
  }
  validateSpringForFrameLoop(result);
  return result;
}

export function timing(input: MotionOptions | undefined, authored = false): Timing {
  const source = input === undefined ? {} : record(input, 'options');
  for (const key of Object.keys(source)) {
    if (!['spring', 'duration', 'ease', 'delay', 'stagger', 'times', 'reducedMotion'].includes(key))
      throw new MotionError(`Неизвестная опция ${key}`);
  }
  const { spring, duration, ease, delay, stagger, times, reducedMotion } = source;
  if (spring !== undefined && (duration !== undefined || ease !== undefined))
    throw new MotionError('Задайте spring или duration/ease');
  if (reducedMotion !== undefined && reducedMotion !== 'user' && reducedMotion !== 'always')
    throw new MotionError('reducedMotion: user или always');
  let easeFunction: (p: number) => number = authored ? linear : standard;
  let cssEase: string | undefined = authored ? 'linear' : 'cubic-bezier(0.2,0,0,1)';
  if (ease !== undefined) {
    if (typeof ease === 'function') { easeFunction = ease as (p: number) => number; cssEase = undefined; }
    else if (ease === 'linear') { easeFunction = linear; cssEase = 'linear'; }
    else {
      const points = typeof ease === 'string' && Object.hasOwn(EASES, ease) ? EASES[ease] : ease;
      const values = snapshot(points as readonly number[], 'ease', 4);
      if (values.length !== 4) throw new MotionError('ease: нужны четыре координаты cubic-bezier');
      values.forEach((v, i) => number(v, `ease[${i}]`));
      if (values[0]! < 0 || values[0]! > 1 || values[2]! < 0 || values[2]! > 1)
        throw new MotionError('X-координаты ease должны находиться от 0 до 1');
      easeFunction = cubicBezierUnchecked(values[0]!, values[1]!, values[2]!, values[3]!);
      cssEase = `cubic-bezier(${values.join(',')})`;
    }
  }
  const stops = times === undefined ? undefined : snapshot(times as readonly number[], 'times', 2);
  if (stops) {
    stops.forEach((v, i) => { number(v, `times[${i}]`, 0); if (v > 1 || i > 0 && v <= stops[i - 1]!) throw new MotionError('times должны строго возрастать от 0 до 1'); });
    if (stops[0] !== 0 || stops.at(-1) !== 1) throw new MotionError('times должны начинаться с 0 и заканчиваться 1');
  }
  return {
    spring: duration !== undefined || ease !== undefined || authored && spring === undefined ? undefined : physics(spring as MotionSpring | undefined),
    duration: duration === undefined ? authored || ease !== undefined ? 200 : undefined : number(duration, 'duration', 0),
    ease: easeFunction, cssEase, delay: number(delay ?? 0, 'delay', 0), stagger: number(stagger ?? 0, 'stagger', 0),
    times: stops, reduced: reducedMotion === 'always',
  };
}

export interface PropertyInput { readonly key: string; readonly values: readonly MotionScalar[]; readonly authored: boolean }
export function properties(input: MotionProperties): PropertyInput[] {
  const source = record(input, 'properties');
  const keys = Object.keys(source);
  if (keys.length > MAX_CHANNELS) throw new MotionError('Слишком много свойств');
  const result: PropertyInput[] = [];
  for (const key of keys) {
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype' || key === 'transform') throw new MotionError(`Недопустимое свойство ${key}`);
    const value = source[key];
    const authored = Array.isArray(value);
    const values = authored ? snapshot(value, key, 2) : [value];
    for (const entry of values) {
      if (typeof entry !== 'number' && typeof entry !== 'string' || typeof entry === 'number' && !Number.isFinite(entry))
        throw new MotionError(`${key}: нужны конечные числа или CSS-строки`);
    }
    if (key === 'scale') {
      if (Object.hasOwn(source, 'scaleX') || Object.hasOwn(source, 'scaleY')) throw new MotionError('scale уже задаёт scaleX и scaleY');
      result.push({ key: 'scaleX', values: values as MotionScalar[], authored }, { key: 'scaleY', values: values as MotionScalar[], authored });
    } else result.push({ key: key.startsWith('--') ? key : key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), values: values as MotionScalar[], authored });
  }
  if (result.reduce((sum, entry) => sum + entry.values.length, 0) > MAX_CHANNELS) throw new MotionError('Слишком много значений');
  const normalized = result.map(entry => ({ ...entry, key: entry.key === 'scale-x' ? 'scaleX' : entry.key === 'scale-y' ? 'scaleY' : entry.key === 'skew-x' ? 'skewX' : entry.key === 'skew-y' ? 'skewY' : entry.key }));
  const declared = new Set<string>();
  for (const entry of normalized) {
    if (declared.has(entry.key)) throw new MotionError(`Свойство ${entry.key} задано несколько раз`);
    declared.add(entry.key);
  }
  return normalized;
}
