import { describe, expect, it } from 'vitest';
import { timing } from '../src/motion/model.js';
import { sample, type Program, type Segment } from '../src/motion/program.js';

const clock = timing({ duration: 10, ease: 'linear' });
function trajectory(count: number, gap = 0) {
  const segments: Segment[] = Array.from({ length: count }, (_, index) => ({
    _at: index * (10 + gap), _end: index * (10 + gap) + 10,
    _from: [index], _to: [index + 1], _velocity: [0], _timing: clock, _artifact: undefined,
  }));
  const program: Program = { _key: 'x', _unit: '', _segments: segments,
    _duration: segments.at(-1)!._end, _final: [count], _nativeEase: undefined, _identity: undefined };
  return { segments, program };
}
function read(program: Program, time: number) {
  const value: number[] = [], velocity: number[] = [];
  sample(program, time, value, velocity);
  return { value: value[0]!, velocity: velocity[0]! };
}

describe('поиск сегмента при произвольном времени', () => {
  it('первый интервал читает постоянное число начал и сохраняет initial velocity', () => {
    const { program, segments } = trajectory(4096);
    let reads = 0;
    for (const segment of segments) {
      const at = segment._at;
      Object.defineProperty(segment, '_at', { get() { reads++; return at; } });
    }
    const first: Program = { ...program, _segments: [
      { ...segments[0]!, _velocity: [7] }, ...segments.slice(1),
    ] };
    reads = 0;
    expect(read(first, 0)).toEqual({ value: 0, velocity: 7 });
    expect(reads).toBeLessThanOrEqual(2);
    reads = 0;
    expect(read(program, 5).value).toBe(0.5);
    expect(reads).toBeLessThanOrEqual(2);
  });

  it('NaN не выбирает другой callback, а throwing easing сохраняет error и порядок', () => {
    const { program, segments } = trajectory(4);
    const calls: number[] = [];
    const failure = new Error();
    const throwing: Program = { ...program, _segments: segments.map((segment, index) => ({
      ...segment, _timing: { ...clock, _ease: (progress: number) => {
        calls.push(index, progress); throw failure;
      } },
    })) };
    const value = [123], velocity = [456];
    expect(() => sample(throwing, NaN, value, velocity)).toThrow();
    expect(calls).toEqual([]);
    expect(value).toEqual([123]); expect(velocity).toEqual([456]);
    for (const [time, index] of [[25, 2], [5, 0]]) {
      calls.length = 0;
      let caught: unknown;
      try { sample(throwing, time!, value, velocity); } catch (error) { caught = error; }
      expect(caught).toBe(failure);
      expect(calls).toEqual([index, 0.501]);
      expect(value).toEqual([123]); expect(velocity).toEqual([456]);
    }
  });

  it('читает логарифмическое число начал, включая перемотку назад', () => {
    const { program, segments } = trajectory(4096);
    let reads = 0;
    for (const segment of segments) {
      const at = segment._at;
      Object.defineProperty(segment, '_at', { get() { reads++; return at; } });
    }
    for (const index of [4094, 1, 2048, 0, 4095, 73]) {
      reads = 0;
      expect(read(program, index * 10 + 5).value).toBe(index + 0.5);
      expect(reads).toBeLessThanOrEqual(Math.ceil(Math.log2(segments.length)) + 2);
    }
  });

  it('сохраняет задержку, точные границы, промежутки и конечную позу', () => {
    const { program } = trajectory(5, 5);
    for (const [time, expected] of [[-1, 0], [0, 0], [5, 0.5], [10, 1], [14, 1],
      [15, 1], [19, 1.4], [30, 2], [55, 4], [60, 4], [65, 4.5], [70, 5], [100, 5]]) {
      expect(read(program, time!).value, `time=${time}`).toBeCloseTo(expected!, 12);
    }
    expect(read(program, 14).velocity).toBe(0);
    expect(read(program, 70).velocity).toBe(0);
  });

  it('при совпадающих началах выбирает последний сегмент, как последовательный поиск', () => {
    const { program, segments } = trajectory(4);
    const equal = segments.map((segment, index) => ({ ...segment, _at: 0, _end: index === 3 ? 10 : 0 }));
    const repeated: Program = { ...program, _segments: equal, _duration: 10 };
    expect(read(repeated, 0)).toEqual({ value: 3, velocity: 0 });
    expect(read(repeated, 5).value).toBe(3.5);
    expect(read(repeated, 10)).toEqual({ value: 4, velocity: 0 });
  });
});
