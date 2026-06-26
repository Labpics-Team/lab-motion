import { describe, expect, it } from 'vitest';
import { drive, parseColor, interpolateColor, resolveToken } from '../src/index.js';

function fullMatchMedia(matches: false): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

describe('design tokens and color interpolation', () => {
  it('parses colors in different formats correctly', () => {
    expect(parseColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#ff0000ff')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#f00f')).toEqual({ r: 255, g: 0, b: 0, a: 1 });

    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });

    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('hsla(0, 100%, 50%, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });

    expect(parseColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('interpolates colors correctly', () => {
    const from = { r: 255, g: 0, b: 0, a: 1 };
    const to = { r: 0, g: 0, b: 255, a: 1 };

    expect(interpolateColor(from, to, 0)).toBe('rgba(255, 0, 0, 1.000)');
    expect(interpolateColor(from, to, 0.5)).toBe('rgba(128, 0, 128, 1.000)');
    expect(interpolateColor(from, to, 1)).toBe('rgba(0, 0, 255, 1.000)');
  });

  it('resolves tokens correctly', () => {
    const customTokens = {
      primary: '#ff0000',
      secondary: '#0000ff',
      spacing: 16,
    };

    expect(resolveToken('primary', undefined, customTokens)).toBe('#ff0000');
    expect(resolveToken('secondary', undefined, customTokens)).toBe('#0000ff');
    expect(resolveToken('spacing', undefined, customTokens)).toBe(16);
    expect(resolveToken('nonexistent', undefined, customTokens)).toBe('nonexistent');
  });

  it('resolves CSS variables if target and window are available', () => {
    const target = {} as Element;

    const originalWindow = global.window;
    global.window = {
      getComputedStyle: () => ({
        getPropertyValue: (prop: string) => {
          if (prop === '--color-primary') return '#ff0000';
          return '';
        },
      }),
    } as any;

    expect(resolveToken('var(--color-primary)', target)).toBe('#ff0000');

    global.window = originalWindow;
  });

  it('animates color transitions and supports retargeting with seamless continuity', async () => {
    const target = {} as Element;
    const values1: string[] = [];
    const values2: string[] = [];
    const frameQueue: Array<(ts: number) => void> = [];
    let frameTs = 0;

    const stepClock = (cb: (ts: number) => void): number => {
      frameQueue.push(cb);
      return frameQueue.length;
    };

    const done1 = drive({
      from: 'red',
      to: 'blue',
      target,
      matchMedia: fullMatchMedia(false),
      onStep: (v) => values1.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: stepClock as unknown as (cb: () => void) => number,
    });

    for (let i = 0; i < 3; i++) {
      frameTs += 16;
      const cb = frameQueue.shift();
      cb?.(frameTs);
    }

    expect(values1.length).toBe(3);
    const lastValue1 = values1[values1.length - 1];
    expect(lastValue1).toContain('rgba');

    const done2 = drive({
      from: 'blue',
      to: 'green',
      target,
      matchMedia: fullMatchMedia(false),
      onStep: (v) => values2.push(v),
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: stepClock as unknown as (cb: () => void) => number,
    });

    await done1;

    for (let i = 0; i < 200 && frameQueue.length > 0; i++) {
      frameTs += 16;
      const cb = frameQueue.shift();
      cb?.(frameTs);
    }

    await done2;

    expect(values2[0]).toBe(lastValue1);
    expect(values2[values2.length - 1]).toBe('green');
  });
});
