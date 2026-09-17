import { afterEach, describe, expect, it } from 'vitest';
import { animateViewWaapi, supportsViewTimeline } from '../src/waapi/index.js';

const host = globalThis as unknown as { ViewTimeline?: unknown };
const original = host.ViewTimeline;
afterEach(() => {
  if (original === undefined) delete host.ViewTimeline;
  else host.ViewTimeline = original;
});

describe('waapi: native ViewTimeline bridge', () => {
  it('SSR/unsupported: fail-closed без host commit', () => {
    delete host.ViewTimeline;
    let commits = 0;
    const el = { animate: () => { commits++; return {}; } };
    expect(supportsViewTimeline()).toBe(false);
    expect(animateViewWaapi(el, {
      property: 'opacity', values: [0, 1],
    }, { subject: {} })).toBeUndefined();
    expect(commits).toBe(0);
  });

  it('коммитит один native view effect с attachment range', () => {
    const subject = { id: 'subject' };
    const timelines: unknown[] = [];
    class FakeViewTimeline {
      constructor(readonly options: unknown) { timelines.push(this); }
    }
    host.ViewTimeline = FakeViewTimeline;

    const calls: Array<{ keyframes: unknown; timing: Record<string, unknown> }> = [];
    const animation = { native: true };
    const el = {
      animate(keyframes: unknown, timing: object) {
        calls.push({ keyframes, timing: timing as Record<string, unknown> });
        return animation;
      },
    };

    expect(animateViewWaapi(el, {
      property: 'opacity', values: [0, 1],
    }, {
      subject,
      axis: 'block',
      rangeStart: 'cover 0%',
      rangeEnd: 'cover 100%',
    })).toBe(animation);

    expect(timelines).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keyframes).toEqual([
      { offset: 0, opacity: 0 },
      { offset: 1, opacity: 1 },
    ]);
    expect(calls[0]!.timing['timeline']).toBe(timelines[0]);
    expect(calls[0]!.timing['rangeStart']).toBe('cover 0%');
    expect(calls[0]!.timing['rangeEnd']).toBe('cover 100%');
    expect((timelines[0] as { options: unknown }).options).toEqual({ subject, axis: 'block' });
  });

  it('без range не изобретает attachment policy', () => {
    host.ViewTimeline = class {};
    const calls: Array<Record<string, unknown>> = [];
    const el = {
      animate: (_: unknown, timing: object) => {
        calls.push(timing as Record<string, unknown>);
        return {};
      },
    };
    animateViewWaapi(el, { property: 'opacity', values: [0, 1] }, { subject: {} });
    expect(Object.hasOwn(calls[0]!, 'rangeStart')).toBe(false);
    expect(Object.hasOwn(calls[0]!, 'rangeEnd')).toBe(false);
  });
});
