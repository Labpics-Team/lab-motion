import { DEFAULT_DURATION_MS, DEFAULT_SPRING, STANDARD_EASING_COORDS } from '../internal/motion-defaults.js';
import { cubicBezierUnchecked } from '../internal/cubic-bezier.js';
import { validateSpringForFrameLoop, type SpringParams } from '../spring.js';
import { MotionError, number, record, snapshot } from './model.js';
import { readRepeat, type RepeatOptions } from './repeat.js';
import type { MotionOptions, MotionSpring } from './types.js';

/** Внутренний снимок: пользовательские getters больше не читаются исполнителем. */
export interface Timing {
  readonly _defaultMotion: boolean;
  readonly _defaultEase: boolean;
  readonly spring: SpringParams | undefined;
  readonly duration: number | undefined;
  readonly ease: (progress: number) => number;
  readonly cssEase: string | undefined;
  readonly delay: number;
  readonly stagger: number;
  readonly times: readonly number[] | undefined;
  readonly reduced: boolean;
  readonly _repeat?: RepeatOptions;
}
const linear = (t: number): number => t;
const EASES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  standard: STANDARD_EASING_COORDS, ease: [.25, .1, .25, 1],
  'ease-in': [.42, 0, 1, 1], 'ease-out': [0, 0, .58, 1], 'ease-in-out': [.42, 0, .58, 1],
};
const standard: (t: number) => number = cubicBezierUnchecked(...STANDARD_EASING_COORDS);
const standardCss = `cubic-bezier(${STANDARD_EASING_COORDS.join(',')})`;

export function physics(input: MotionSpring | undefined): SpringParams {
  if (input === undefined) return { ...DEFAULT_SPRING };
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

export function timing(input: MotionOptions | undefined, authored = false, repeatable = false): Timing {
  const source = input === undefined ? {} : record(input, 'options');
  for (const key of Object.keys(source)) {
    if (!['spring', 'duration', 'ease', 'delay', 'stagger', 'times', 'reducedMotion'].includes(key) &&
      !(repeatable && ['repeat', 'repeatType', 'repeatDelay'].includes(key)))
      throw new MotionError(`Неизвестная опция ${key}`);
  }
  const { spring, duration, ease, delay, stagger, times, reducedMotion } = source;
  const repetition = repeatable ? readRepeat(source.repeat, source.repeatType, source.repeatDelay) : undefined;
  if (spring !== undefined && (duration !== undefined || ease !== undefined))
    throw new MotionError('Задайте spring или duration/ease');
  if (reducedMotion !== undefined && reducedMotion !== 'user' && reducedMotion !== 'always')
    throw new MotionError('reducedMotion: user или always');
  let easeFunction: (p: number) => number = authored ? linear : standard;
  let cssEase: string | undefined = authored ? 'linear' : standardCss;
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
    _defaultMotion: spring === undefined && duration === undefined && ease === undefined,
    _defaultEase: ease === undefined,
    spring: duration !== undefined || ease !== undefined || authored && spring === undefined ? undefined : physics(spring as MotionSpring | undefined),
    duration: duration === undefined ? authored || ease !== undefined ? DEFAULT_DURATION_MS : undefined : number(duration, 'duration', 0),
    ease: easeFunction, cssEase, delay: number(delay ?? 0, 'delay', 0), stagger: number(stagger ?? 0, 'stagger', 0),
    times: stops, reduced: reducedMotion === 'always',
    ...(repetition ? { _repeat: repetition } : {}),
  };
}

/** Авторская траектория выбирает собственные defaults без повторного чтения опций. */
export function authoredTiming(clock: Timing): Timing {
  return { ...clock,
    spring: clock._defaultMotion ? undefined : clock.spring,
    duration: clock._defaultMotion ? DEFAULT_DURATION_MS : clock.duration,
    ease: clock._defaultEase ? linear : clock.ease,
    cssEase: clock._defaultEase ? 'linear' : clock.cssEase,
  };
}

