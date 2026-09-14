/**
 * test/timeline-reduced-motion.test.ts
 * Классы: А (unit CHARACTER-switch) + Д (mutation RED-proof обеих мутаций).
 *
 * Invariant 4 — reduced-motion: CHARACTER-switch.
 *
 * Требование: при prefers-reduced-motion: reduce таймлайн переключает
 * ХАРАКТЕР анимации — РОВНО ОДИН СИНХРОННЫЙ snap-to-final (все сегменты → `to`,
 * до rAF/setTimeout), а НЕ hard-off (steps.length===0) и НЕ нормальная
 * multi-frame (steps.length>=2).
 *
 * Shared query-sensitive seam также делает неверный media query наблюдаемым:
 * только `(prefers-reduced-motion: reduce)` может вернуть reduced=true.
 */

import { describe, expect, it } from 'vitest';
import { createTimeline } from '../src/timeline/index.js';
import type { SegmentValue } from '../src/timeline/index.js';
import { reducedMotionMedia } from './helpers/reduced-motion.js';

const makeReduceMedia = () => reducedMotionMedia(true);
const makeNoReduceMedia = () => reducedMotionMedia(false);

function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

describe('timeline-reduced-motion: CHARACTER-switch (snap-to-final, НЕ hard-off)', () => {
  it('reduce=true: РОВНО ОДИН sync emit (CHARACTER-switch, не hard-off)', () => {
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    expect(steps.length, 'CHARACTER-switch: ровно 1 emit синхронно').toBe(1);
  });

  it('reduce=true: emit содержит `to` всех сегментов', () => {
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [
        { from: 0, to: 100, duration: 1 },
        { from: 200, to: 300, duration: 0.5 },
      ],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    expect(steps.length).toBe(1);
    expect(steps[0]![0]!.value).toBe(100);
    expect(steps[0]![1]!.value).toBe(300);
  });

  it('reduce=true: per-segment onStep тоже вызывается с `to`', () => {
    const seg0Values: number[] = [];
    const seg1Values: number[] = [];
    createTimeline({
      segments: [
        { from: 0, to: 77, duration: 1, onStep: (v) => seg0Values.push(v) },
        { from: 10, to: 55, duration: 0.5, onStep: (v) => seg1Values.push(v) },
      ],
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    expect(seg0Values).toEqual([77]);
    expect(seg1Values).toEqual([55]);
  });

  it('reduce=false (normal): первый emit async (ДО await steps.length===0)', () => {
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeNoReduceMedia(),
      requestFrame: noRaf(),
    });
    expect(steps.length, 'normal path: нет sync emit до await').toBe(0);
  });

  it('reduce=true: после emit timeline resolved', async () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    await tl;
  });
});

describe('timeline-reduced-motion: CHARACTER-switch vs hard-off дифференциал', () => {
  it('CHARACTER-switch emits to (не skip-emit, не from)', () => {
    const from = 10;
    const to = 90;
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [{ from, to, duration: 2 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    expect(steps.length).toBe(1);
    expect(steps[0]![0]!.value).toBe(to);
    expect(steps[0]![0]!.value).not.toBe(from);
  });
});

describe('timeline-reduced-motion: matchMedia throws → fallback false', () => {
  it('matchMedia бросает исключение → reduce=false (нет краша)', () => {
    const throwingMedia = (): MediaQueryList => {
      throw new Error('matchMedia not supported in this environment');
    };
    const steps: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 0.1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: throwingMedia,
      requestFrame: noRaf(),
    });
    expect(steps.length, 'reduce=false: нет sync snap-emit').toBe(0);
    tl.complete();
    expect(steps.length, 'complete() эмитит финальное состояние').toBe(1);
    expect(steps[0]![0]!.value).toBe(100);
  });

  it('matchMedia=undefined → reduce=false (нет краша)', () => {
    const steps: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 0.1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: undefined,
      requestFrame: noRaf(),
    });
    expect(steps.length, 'reduce=false: нет sync snap-emit').toBe(0);
    tl.complete();
    expect(steps.length, 'complete() эмитит финальное состояние').toBe(1);
    expect(steps[0]![0]!.value).toBe(100);
  });
});

describe('timeline-reduced-motion: методы после settle — no-op', () => {
  it('seek/play/pause после reduce-snap — все no-op без краша', () => {
    const steps: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    const countBefore = steps.length;
    tl.seek(0.5);
    tl.play();
    tl.pause();
    tl.complete();
    expect(steps.length, 'после settle emit не добавляются').toBe(countBefore);
  });
});

describe('timeline-reduced-motion: mutation RED-proof документация', () => {
  it('reduce snap различает normal, hard-off и snap-to-from', () => {
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [{ from: 5, to: 95, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    expect(steps.length).toBe(1);
    expect(steps[0]![0]!.value).toBe(95);
  });
});
