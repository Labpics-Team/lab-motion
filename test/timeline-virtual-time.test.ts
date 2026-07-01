/**
 * test/timeline-virtual-time.test.ts
 * Класс: В/Differential — детерминизм через virtual-time seam.
 *
 * Invariant 3 — детерминизм: инъектируемый clock seam даёт бит-в-бит
 * идентичный прогон на любой платформе. Два независимых экземпляра с
 * одинаковыми параметрами и одинаковым seam дают БИТО-ТОЧНО идентичные emit.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Добавить `Math.random()` в tick() тела timeline/index.ts:
 *   → Два прогона дают разные последовательности → differential fails → RED.
 *
 * Убрать `_lastRealTs = undefined` при seek/pause:
 *   → dt после resume зависит от реального системного времени → не детерминировано → RED.
 *
 * ── MUTATION PROOF ────────────────────────────────────────────────────────────
 * Убрать `_lastRealTs = undefined` при seek():
 *   → После seek первый dt "прыгает" (wall-clock), дифференциал расходится →
 *     emitted[i] !== emitted2[i] → RED.
 */

import { describe, expect, it } from 'vitest';
import { createTimeline } from '../src/timeline/index.js';
import type { SegmentValue } from '../src/timeline/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Создаёт детерминированный clock: хранит очередь колбэков,
 * позволяет вручную "продвигать" кадры с заданными timestamps.
 */
function makeStepClock(): {
  queue: Array<(ts?: number) => void>;
  requestFrame: (cb: (ts?: number) => void) => number;
} {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 1;
  return {
    queue,
    requestFrame: (cb) => {
      queue.push(cb);
      return handle++;
    },
  };
}

/**
 * Запустить таймлайн с детерминированным clock, продвинуть N кадров
 * с шагом dtMs, собрать все эмитированные значения.
 */
function runDeterministicTimeline(opts: {
  from: number;
  to: number;
  duration: number;
  frames: number;
  dtMs: number;
}): SegmentValue[][] {
  const emitted: SegmentValue[][] = [];
  const clock = makeStepClock();

  const tl = createTimeline({
    segments: [{ from: opts.from, to: opts.to, duration: opts.duration }],
    onStep: (vs) => emitted.push([...vs]),
    requestFrame: clock.requestFrame,
  });

  let ts = 0;
  for (let i = 0; i < opts.frames; i++) {
    if (clock.queue.length === 0) break;
    const cb = clock.queue.shift()!;
    cb(ts);
    ts += opts.dtMs;
  }

  tl.cancel();
  return emitted;
}

// ─── 1. Bit-exact differential ────────────────────────────────────────────────

describe('timeline-virtual-time: bit-exact differential (два прогона → идентично)', () => {
  it('0→100, duration=1s, 30 кадров @ 16ms', () => {
    const run1 = runDeterministicTimeline({ from: 0, to: 100, duration: 1, frames: 30, dtMs: 16 });
    const run2 = runDeterministicTimeline({ from: 0, to: 100, duration: 1, frames: 30, dtMs: 16 });

    expect(run1.length, 'одинаковая длина').toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i]!.length, `frame ${i} одинаковая длина`).toBe(run2[i]!.length);
      for (let j = 0; j < run1[i]!.length; j++) {
        expect(
          run1[i]![j]!.value,
          `frame ${i} segment ${j}: ${run1[i]![j]!.value} !== ${run2[i]![j]!.value}`,
        ).toBe(run2[i]![j]!.value);
      }
    }
  });

  it('отрицательный диапазон (-200 → -50), 20 кадров @ 8ms', () => {
    const run1 = runDeterministicTimeline({ from: -200, to: -50, duration: 0.5, frames: 20, dtMs: 8 });
    const run2 = runDeterministicTimeline({ from: -200, to: -50, duration: 0.5, frames: 20, dtMs: 8 });

    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      for (let j = 0; j < run1[i]!.length; j++) {
        expect(run1[i]![j]!.value).toBe(run2[i]![j]!.value);
      }
    }
  });

  it('крупный диапазон 0→1e6, 50 кадров @ 16ms', () => {
    const run1 = runDeterministicTimeline({ from: 0, to: 1e6, duration: 2, frames: 50, dtMs: 16 });
    const run2 = runDeterministicTimeline({ from: 0, to: 1e6, duration: 2, frames: 50, dtMs: 16 });

    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      for (let j = 0; j < run1[i]!.length; j++) {
        expect(run1[i]![j]!.value).toBe(run2[i]![j]!.value);
      }
    }
  });
});

// ─── 2. Seek-детерминизм ──────────────────────────────────────────────────────

describe('timeline-virtual-time: seek-детерминизм', () => {
  it('seek к одинаковым t в двух независимых таймлайнах → одинаковые значения', () => {
    const seekPoints = [0, 0.1, 0.25, 0.5, 0.75, 1.0];

    const emitted1: SegmentValue[][] = [];
    const tl1 = createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => emitted1.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    tl1.pause();
    emitted1.length = 0; // очистить начальный emit (если был)
    for (const t of seekPoints) tl1.seek(t);
    tl1.cancel();

    const emitted2: SegmentValue[][] = [];
    const tl2 = createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => emitted2.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    tl2.pause();
    emitted2.length = 0;
    for (const t of seekPoints) tl2.seek(t);
    tl2.cancel();

    expect(emitted1.length).toBe(emitted2.length);
    for (let i = 0; i < emitted1.length; i++) {
      for (let j = 0; j < emitted1[i]!.length; j++) {
        expect(
          emitted1[i]![j]!.value,
          `seek point ${i}: ${emitted1[i]![j]!.value} !== ${emitted2[i]![j]!.value}`,
        ).toBe(emitted2[i]![j]!.value);
      }
    }
  });

  it('seek к t=0 возвращает `from`', () => {
    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{ from: 42, to: 100, duration: 1 }],
      onStep: (vs) => collected.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    tl.pause();
    collected.length = 0;
    tl.seek(0);
    tl.cancel();

    expect(collected.length).toBeGreaterThan(0);
    expect(collected[0]![0]!.value).toBeCloseTo(42);
  });

  it('seek к t=duration возвращает `to`', () => {
    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{ from: 0, to: 77, duration: 2 }],
      onStep: (vs) => collected.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    tl.pause();
    collected.length = 0;
    tl.seek(2);
    tl.cancel();

    expect(collected.length).toBeGreaterThan(0);
    expect(collected[0]![0]!.value).toBeCloseTo(77);
  });
});

// ─── 3. Non-draining clock (handle=0) детерминизм ────────────────────────────

describe('timeline-virtual-time: non-draining clock (setTimeout-fallback)', () => {
  it('два таймлайна с requestFrame→0 дают одинаковые последовательности', async () => {
    const emitted1: SegmentValue[][] = [];
    const p1 = createTimeline({
      segments: [{ from: 0, to: 10, duration: 0.5 }],
      onStep: (vs) => emitted1.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    await p1;

    const emitted2: SegmentValue[][] = [];
    const p2 = createTimeline({
      segments: [{ from: 0, to: 10, duration: 0.5 }],
      onStep: (vs) => emitted2.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    await p2;

    expect(emitted1.length, 'одинаковая длина').toBe(emitted2.length);
    for (let i = 0; i < emitted1.length; i++) {
      for (let j = 0; j < emitted1[i]!.length; j++) {
        expect(emitted1[i]![j]!.value, `frame ${i}`).toBe(emitted2[i]![j]!.value);
      }
    }
  }, 15_000);
});

// ─── 4. Многосегментный differential ─────────────────────────────────────────

describe('timeline-virtual-time: многосегментный differential', () => {
  it('3-сегментный таймлайн: два прогона бит-в-бит идентичны', () => {
    const segments = [
      { from: 0, to: 100, duration: 0.3 },
      { from: 100, to: 200, duration: 0.4, offset: 0.1 },
      { from: 0, to: 50, duration: 0.2, at: 0.5 },
    ] as const;

    const clock1 = makeStepClock();
    const emitted1: SegmentValue[][] = [];
    const tl1 = createTimeline({ segments, onStep: (vs) => emitted1.push([...vs]), requestFrame: clock1.requestFrame });
    let ts = 0;
    for (let i = 0; i < 50; i++) {
      if (clock1.queue.length === 0) break;
      clock1.queue.shift()!(ts);
      ts += 16;
    }
    tl1.cancel();

    const clock2 = makeStepClock();
    const emitted2: SegmentValue[][] = [];
    const tl2 = createTimeline({ segments, onStep: (vs) => emitted2.push([...vs]), requestFrame: clock2.requestFrame });
    ts = 0;
    for (let i = 0; i < 50; i++) {
      if (clock2.queue.length === 0) break;
      clock2.queue.shift()!(ts);
      ts += 16;
    }
    tl2.cancel();

    expect(emitted1.length).toBe(emitted2.length);
    for (let i = 0; i < emitted1.length; i++) {
      expect(emitted1[i]!.length).toBe(emitted2[i]!.length);
      for (let j = 0; j < emitted1[i]!.length; j++) {
        expect(emitted1[i]![j]!.value).toBe(emitted2[i]![j]!.value);
      }
    }
  });
});

// ─── 5. Differential vs ручная суперпозиция ───────────────────────────────────

describe('timeline-virtual-time: differential vs ручная суперпозиция сегментов', () => {
  it('значения таймлайна совпадают с ручным вычислением для seek', () => {
    const from = 10;
    const to = 80;
    const duration = 2;
    const seekT = 1.2; // середина сегмента

    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{ from, to, duration }],
      onStep: (vs) => collected.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    tl.pause();
    collected.length = 0;
    tl.seek(seekT);
    tl.cancel();

    // Ручная суперпозиция: localT = seekT / duration, easing = linear
    const localT = seekT / duration;
    const expected = from + (to - from) * localT;

    expect(collected.length).toBeGreaterThan(0);
    expect(collected[0]![0]!.value).toBeCloseTo(expected, 10);
  });

  it('два последовательных сегмента: значения совпадают с ручным вычислением', () => {
    const segs = [
      { from: 0, to: 100, duration: 1 },
      { from: 100, to: 200, duration: 1 },
    ] as const;

    // После первого сегмента (t=1.5, в середине второго)
    const seekT = 1.5;
    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: segs,
      onStep: (vs) => collected.push([...vs]),
      requestFrame: (_cb) => 0,
    });
    tl.pause();
    collected.length = 0;
    tl.seek(seekT);
    tl.cancel();

    // Сегмент 0: t=1.5 >= endTime=1 → to=100
    // Сегмент 1: startTime=1, endTime=2, localT=(1.5-1)/1=0.5 → 100+(200-100)*0.5=150
    expect(collected.length).toBeGreaterThan(0);
    const frame = collected[0]!;
    expect(frame[0]!.value).toBeCloseTo(100, 10); // сегмент 0 завершён
    expect(frame[1]!.value).toBeCloseTo(150, 10); // сегмент 1 в середине
  });
});
