import { afterEach, describe, expect, it } from 'vitest';
import {
  animateScrollWaapi,
  supportsScrollTimeline,
} from '../src/waapi/index.js';

const host = globalThis as unknown as { ScrollTimeline?: unknown };
const original = host.ScrollTimeline;
afterEach(() => {
  if (original === undefined) delete host.ScrollTimeline;
  else host.ScrollTimeline = original;
});

describe('waapi: native ScrollTimeline bridge', () => {
  it('SSR/unsupported: fail-closed без host commit', () => {
    delete host.ScrollTimeline;
    let commits = 0;
    const el = { animate: () => { commits++; return {}; } };
    expect(supportsScrollTimeline()).toBe(false);
    expect(animateScrollWaapi(el, {
      property: 'opacity', values: [0, 1],
    }, { source: {} })).toBeUndefined();
    expect(commits).toBe(0);
  });

  it('коммитит один native effect с timeline, без JS scheduler/listener', () => {
    const source = { id: 'scroller' };
    const timelines: unknown[] = [];
    class FakeScrollTimeline {
      constructor(readonly options: unknown) { timelines.push(this); }
    }
    host.ScrollTimeline = FakeScrollTimeline;

    const calls: Array<{ keyframes: unknown; timing: Record<string, unknown> }> = [];
    const animation = { native: true };
    const el = {
      animate(keyframes: unknown, timing: object) {
        calls.push({ keyframes, timing: timing as Record<string, unknown> });
        return animation;
      },
    };

    expect(supportsScrollTimeline()).toBe(true);
    const result = animateScrollWaapi(el, {
      property: 'translate',
      values: [0, 100],
      format: value => `${value}px 0`,
    }, { source, axis: 'x' });

    expect(result).toBe(animation);
    expect(timelines).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keyframes).toEqual([
      { offset: 0, translate: '0px 0' },
      { offset: 1, translate: '100px 0' },
    ]);
    expect(calls[0]!.timing['timeline']).toBe(timelines[0]);
    expect(calls[0]!.timing['duration']).toBe(1);
    expect(calls[0]!.timing['iterations']).toBe(1);
    expect(calls[0]!.timing['direction']).toBe('normal');
    expect(calls[0]!.timing['fill']).toBe('both');
    expect((timelines[0] as { options: unknown }).options).toEqual({ source, axis: 'x' });
  });

  it('WAAPI-цель отсутствует: не конструирует timeline и не эмулирует JS fallback', () => {
    let timelines = 0;
    host.ScrollTimeline = class { constructor() { timelines++; } };
    expect(animateScrollWaapi({} as never, {
      property: 'opacity', values: [0, 1],
    }, { source: {} })).toBeUndefined();
    expect(timelines).toBe(0);
  });
});
