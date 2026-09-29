import { describe, expect, it } from 'vitest';
import { keyframes, sampleKeyframes, type EasingFn } from '../src/keyframes/index.js';

const requestFrame = () => 0;
const linear: EasingFn = (t) => t;

describe('линейные keyframes без пользовательского easing', () => {
  it('не меняют IEEE-результаты, повторы, зеркалирование и совпавшие позиции', () => {
    for (const n of [3, 10, 11, 65, 1025]) {
      const values = Array.from({ length: n }, (_, i) => (i % 7 - 3) * 19);
      const times = Array.from({ length: n }, (_, i) => i / (n - 1));
      if (n > 3) times[2] = times[1]!;
      for (const repeatType of ['loop', 'reverse', 'mirror'] as const) {
        let actual = NaN;
        let explicit = NaN;
        const common = { values, times, duration: 2, repeat: 2, repeatDelay: .25, repeatType, requestFrame };
        const a = keyframes({ ...common, onStep: (v) => { actual = v; } });
        const b = keyframes({ ...common, easing: linear, onStep: (v) => { explicit = v; } });
        a.pause(); b.pause();
        for (let i = 0; i <= 256; i++) {
          const t = (i % 2 ? 256 - i : i) / 40;
          a.seek(t); b.seek(t);
          expect(Object.is(actual, explicit)).toBe(true);
        }
        a.cancel(); b.cancel();
      }
    }
  });

  it('публичный sampler нормализует нечисловой progress до вызова easing', () => {
    let calls = 0;
    const easing = () => { calls++; return .25; };
    const values = [-0, 17, -29];
    for (const p of [NaN, -Infinity, Infinity]) {
      expect(Object.is(sampleKeyframes(values, [0, .4, 1], [easing, easing], p),
        p === Infinity ? -29 : -0)).toBe(true);
    }
    expect(calls).toBe(0);
    expect(sampleKeyframes(values, [0, .4, 1], [easing, easing], .2)).toBe(4.25);
    expect(calls).toBe(1);
  });

  it('сохраняет receiver и число вызовов общей пользовательской функции', () => {
    const receivers: unknown[] = [];
    function easing(this: unknown, t: number): number { receivers.push(this); return t * t; }
    const controls = keyframes({ values: [0, 10, 0, 30], easing, requestFrame });
    controls.pause(); controls.seek(.2); controls.seek(.8);
    expect(receivers).toHaveLength(2);
    expect(Array.isArray(receivers[0])).toBe(true);
    expect(receivers[0]).toBe(receivers[1]);
    expect(receivers[0]).toEqual([easing, easing, easing]);
    controls.cancel();
  });

  it('не копирует и не отвязывает явно переданный массив easing', () => {
    let receiver: unknown;
    let value = NaN;
    function easing(this: unknown): number { receiver = this; return .25; }
    const easings = [easing, easing];
    const controls = keyframes({ values: [0, 100, 0], easing: easings, requestFrame, onStep: (v) => { value = v; } });
    controls.pause(); controls.seek(.25);
    expect(receiver).toBe(easings);
    expect(value).toBe(25);
    easings[0] = () => .75;
    controls.seek(.25);
    expect(value).toBe(75);
    controls.cancel();
  });

  it('сохраняет точные концы и конечный результат при переполнении диапазона', () => {
    for (const values of [[-0, 0, -0], [-Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]]) {
      let actual = NaN;
      const controls = keyframes({ values, requestFrame, onStep: (v) => { actual = v; } });
      controls.pause(); controls.seek(0);
      expect(Object.is(actual, values[0])).toBe(true);
      controls.seek(.25);
      expect(Number.isFinite(actual)).toBe(true);
      controls.seek(1);
      expect(Object.is(actual, values[2])).toBe(true);
      controls.cancel();
    }
  });
});
