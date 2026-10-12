import type { MotionProperties, MotionScalar, MotionResult } from './types.js';

export class MotionError extends Error {
  constructor(message: string) { super(message); this.name = 'MotionError'; }
}
export const MAX_CHANNELS = 100_000;
export const FINISHED: MotionResult = Object.freeze({ status: 'finished' as const });
export const STOPPED: MotionResult = Object.freeze({ status: 'stopped' as const });
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
