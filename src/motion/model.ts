import { DEFAULT_DURATION_MS, DEFAULT_SPRING, STANDARD_EASING_COORDS } from '../internal/motion-defaults.js';
import { cubicBezierUnchecked } from '../internal/cubic-bezier.js';
import { validateSpringForFrameLoop, type SpringParams } from '../spring.js';
import type { MotionOptions, MotionProperties, MotionScalar, MotionSpring, MotionResult } from './types.js';

export class MotionError extends Error {
  constructor(message: string) { super(message); this.name = 'MotionError'; }
}
export function failMotion(message: string): never { throw new MotionError(message); }
export const MAX_CHANNELS = 100_000;
export const FINISHED: MotionResult = Object.freeze({ status: 'finished' as const });
export const STOPPED: MotionResult = Object.freeze({ status: 'stopped' as const });
const linear = (t: number): number => t;
const EASES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  standard: STANDARD_EASING_COORDS, ease: [.25, .1, .25, 1],
  'ease-in': [.42, 0, 1, 1], 'ease-out': [0, 0, .58, 1], 'ease-in-out': [.42, 0, .58, 1],
};
const standard: (t: number) => number = /* @__PURE__ */ cubicBezierUnchecked(...STANDARD_EASING_COORDS);
const standardCss = `cubic-bezier(${STANDARD_EASING_COORDS.join(',')})`;

export function number(value: unknown, name: string, minimum: number = -Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    failMotion(`${name}: нужно конечное число${minimum === -Infinity ? '' : ` не меньше ${minimum}`}`);
  return value;
}
export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failMotion(`${name}: нужен объект`);
  return value as Record<string, unknown>;
}
export function snapshot<T>(input: readonly T[], name: string, minimum = 0): T[] {
  if (!Array.isArray(input)) failMotion(`${name}: нужен массив`);
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < minimum || length > MAX_CHANNELS)
    failMotion(`${name}: недопустимая длина`);
  const result: T[] = [];
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(input, i)) failMotion(`${name}: пропущено значение ${i}`);
    result.push(input[i]!);
  }
  return result;
}

/** Внутренний снимок: пользовательские getters больше не читаются исполнителем. */
export interface Timing {
  readonly _defaultMotion: boolean;
  readonly _defaultEase: boolean;
  readonly _spring: SpringParams | undefined;
  readonly _duration: number | undefined;
  readonly _ease: (progress: number) => number;
  readonly _cssEase: string | undefined;
  readonly _delay: number;
  readonly _stagger: number;
  readonly _times: readonly number[] | undefined;
  readonly _reduced: boolean;
}

export function physics(input: MotionSpring | undefined): SpringParams {
  if (input === undefined) return { ...DEFAULT_SPRING };
  const source = record(input, 'spring');
  const keys = Object.keys(source);
  if (keys.some(key => !['mass', 'stiffness', 'damping', 'response', 'bounce'].includes(key)))
    failMotion('spring: неизвестное поле');
  const { mass, stiffness, damping, response, bounce } = source;
  let result: SpringParams;
  if (mass !== undefined || stiffness !== undefined || damping !== undefined) {
    if (response !== undefined || bounce !== undefined) failMotion('spring: смешаны схемы параметров');
    result = { mass: number(mass, 'mass', Number.MIN_VALUE), stiffness: number(stiffness, 'stiffness', Number.MIN_VALUE), damping: number(damping, 'damping', Number.MIN_VALUE) };
  } else {
    const period = number(response ?? 320, 'response', Number.MIN_VALUE);
    const b = number(bounce ?? 0, 'bounce', 0);
    if (b >= 1) failMotion('bounce должен быть меньше 1');
    const frequency = (2 * Math.PI * 1000) / period;
    result = { mass: 1, stiffness: frequency * frequency, damping: 2 * (1 - b) * frequency };
  }
  validateSpringForFrameLoop(result);
  return result;
}

export function timing(input: MotionOptions | undefined): Timing {
  const source = input === undefined ? {} : record(input, 'options');
  for (const key of Object.keys(source)) {
    if (!['spring', 'duration', 'ease', 'delay', 'stagger', 'times', 'reducedMotion'].includes(key))
      failMotion(`Неизвестная опция ${key}`);
  }
  const { spring, duration, ease, delay, stagger, times, reducedMotion } = source;
  if (spring !== undefined && (duration !== undefined || ease !== undefined))
    failMotion('Задайте spring или duration/ease');
  if (reducedMotion !== undefined && reducedMotion !== 'user' && reducedMotion !== 'always')
    failMotion('reducedMotion: user|always');
  let easeFunction: (p: number) => number = standard;
  let _cssEase: string | undefined = standardCss;
  if (ease !== undefined) {
    if (typeof ease === 'function') { easeFunction = ease as (p: number) => number; _cssEase = undefined; }
    else if (ease === 'linear') { easeFunction = linear; _cssEase = 'linear'; }
    else {
      const points = typeof ease === 'string' && Object.hasOwn(EASES, ease) ? EASES[ease] : ease;
      const values = snapshot(points as readonly number[], 'ease', 4);
      if (values.length !== 4) failMotion('ease: нужны 4 координаты');
      values.forEach((v, i) => number(v, `ease[${i}]`));
      if (values[0]! < 0 || values[0]! > 1 || values[2]! < 0 || values[2]! > 1)
        failMotion('ease: X вне [0,1]');
      easeFunction = cubicBezierUnchecked(values[0]!, values[1]!, values[2]!, values[3]!);
      _cssEase = `cubic-bezier(${values.join(',')})`;
    }
  }
  const stops = times === undefined ? undefined : snapshot(times as readonly number[], 'times', 2);
  if (stops) for (let i = 0; i < stops.length; i++) {
    const stop = number(stops[i], `times[${i}]`, 0);
    if (stop > 1 || (i === 0 ? stop !== 0 : stop <= stops[i - 1]!) || i === stops.length - 1 && stop !== 1)
      failMotion('times: рост в [0,1]');
  }
  return {
    _defaultMotion: spring === undefined && duration === undefined && ease === undefined,
    _defaultEase: ease === undefined,
    _spring: duration !== undefined || ease !== undefined ? undefined : physics(spring as MotionSpring | undefined),
    _duration: duration === undefined ? ease !== undefined ? DEFAULT_DURATION_MS : undefined : number(duration, 'duration', 0),
    _ease: easeFunction, _cssEase, _delay: number(delay ?? 0, 'delay', 0), _stagger: number(stagger ?? 0, 'stagger', 0),
    _times: stops, _reduced: reducedMotion === 'always',
  };
}

/** Авторская траектория выбирает собственные defaults без повторного чтения опций. */
export function authoredTiming(clock: Timing): Timing {
  return { ...clock,
    _spring: clock._defaultMotion ? undefined : clock._spring,
    _duration: clock._defaultMotion ? DEFAULT_DURATION_MS : clock._duration,
    _ease: clock._defaultEase ? linear : clock._ease,
    _cssEase: clock._defaultEase ? 'linear' : clock._cssEase,
  };
}

export interface PropertyInput { readonly _key: string; readonly _values: readonly MotionScalar[]; readonly _authored: boolean }
export function properties(input: MotionProperties): PropertyInput[] {
  const source = record(input, 'properties');
  const keys = Object.keys(source);
  if (keys.length > MAX_CHANNELS) failMotion('Слишком много свойств');
  const result: PropertyInput[] = [], declared = new Set<string>();
  let count = 0;
  for (const key of keys) {
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype' || key === 'transform')
      failMotion(`Недопустимое свойство ${key}`);
    const value = source[key], authored = Array.isArray(value);
    const values = authored ? snapshot(value, key, 2) : [value];
    for (const entry of values) {
      if (typeof entry !== 'number' && typeof entry !== 'string' || typeof entry === 'number' && !Number.isFinite(entry))
        failMotion(`${key}: нужно конечное число или CSS`);
    }
    const name = key.startsWith('--') ? key : key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    const normalized = name === 'scale-x' ? 'scaleX' : name === 'scale-y' ? 'scaleY'
      : name === 'skew-x' ? 'skewX' : name === 'skew-y' ? 'skewY' : name;
    const channels = key === 'scale' ? ['scaleX', 'scaleY'] : [normalized];
    count += values.length * channels.length;
    if (count > MAX_CHANNELS) failMotion('Лимит значений');
    if (key === 'scale' && (Object.hasOwn(source, 'scaleX') || Object.hasOwn(source, 'scaleY')))
      failMotion('scale конфликтует с scaleX/Y');
    for (const channel of channels) {
      if (declared.has(channel)) failMotion(`Свойство ${channel} задано несколько раз`);
      declared.add(channel);
      result.push({ _key: channel, _values: values as MotionScalar[], _authored: authored });
    }
  }
  return result;
}
