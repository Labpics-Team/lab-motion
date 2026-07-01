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
 * ── RED PROOF (mutation 1) ─────────────────────────────────────────────────────
 * Убрать ветку `else if (reduce) { settle(true); }` из timeline/index.ts:
 *   → нормальный multi-frame путь → scheduleFrame вызывается → steps.length===0
 *     синхронно ДО await → тест `===1` НЕМЕДЛЕННО = RED.
 *
 * ── RED PROOF (mutation 2) ────────────────────────────────────────────────────
 * Изменить settle(true) → settle(false) (snap к from, а не to):
 *   → all segments emit их FROM значение → значения !== to → RED.
 *
 * ── RED PROOF (mutation 3) ────────────────────────────────────────────────────
 * Заменить settle(true) → не вызывать onStep (hard-off):
 *   → steps.length===0 → тест `===1` = RED.
 *
 * Почему `===1` (не `>=1`) различает reduce от normal:
 *   reduce path: settle() вызывается СИНХРОННО в теле конструктора →
 *     steps.length===1 немедленно, requestFrame НЕ вызывается (_settled=true
 *     не даёт ensureLoop() стартовать).
 *   normal path: ensureLoop() → scheduleFrame() → setTimeout(tick,0) async →
 *     steps.length===0 в момент синхронной проверки ДО await.
 */

import { describe, expect, it } from 'vitest';
import { createTimeline } from '../src/timeline/index.js';
import type { SegmentValue } from '../src/timeline/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: true, // prefers-reduced-motion: reduce
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function makeNoReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

// ─── 1. CHARACTER-switch: синхронный snap-to-final ───────────────────────────

describe('timeline-reduced-motion: CHARACTER-switch (snap-to-final, НЕ hard-off)', () => {
  it('reduce=true: РОВНО ОДИН sync emit (CHARACTER-switch, не hard-off)', () => {
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });

    // CHARACTER-switch: settle(true) вызывается СИНХРОННО → steps.length===1
    // без await.
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
    // Все сегменты должны быть в `to`
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

    expect(seg0Values.length).toBe(1);
    expect(seg1Values.length).toBe(1);
    expect(seg0Values[0]).toBe(77);  // snap to `to`
    expect(seg1Values[0]).toBe(55);  // snap to `to`
  });

  it('reduce=false (normal): первый emit async (ДО await steps.length===0)', () => {
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeNoReduceMedia(),
      requestFrame: noRaf(),
    });

    // Normal path: scheduleFrame → handle=0 → setTimeout-fallback (async)
    // Синхронно steps.length===0 (ни одного кадра ещё не эмитировано)
    expect(steps.length, 'normal path: нет sync emit до await').toBe(0);
  });

  it('reduce=true: после emit timeline resolved', async () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });
    // Должен резолвиться немедленно (синхронный settle)
    await tl;
  });
});

// ─── 2. CHARACTER-switch vs hard-off дифференциал ────────────────────────────

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

    // Must have exactly 1 step (not 0=hard-off, not 2+=multi-frame)
    expect(steps.length).toBe(1);
    // Must snap to `to` (not from, not intermediate)
    expect(steps[0]![0]!.value).toBe(to);
    expect(steps[0]![0]!.value).not.toBe(from);
  });
});

// ─── 3. matchMedia throws: безопасная обработка ───────────────────────────────

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
    // reduce=false → НЕ синхронный snap: до complete() ни одного emit нет
    // (иначе это был бы reduce=true CHARACTER-switch, а не fallback).
    expect(steps.length, 'reduce=false: нет sync snap-emit').toBe(0);
    tl.complete();
    // complete() снапает к `to` — подтверждает нормальный (не hard-off) путь.
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

// ─── 4. Seek после reduced-motion (settled=true) — no-op ─────────────────────

describe('timeline-reduced-motion: методы после settle — no-op', () => {
  it('seek/play/pause после reduce-snap — все no-op без краша', () => {
    const steps: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });

    const countBefore = steps.length; // 1 (snap)
    tl.seek(0.5);  // settled → no-op
    tl.play();     // settled → no-op
    tl.pause();    // settled → no-op
    tl.complete(); // settled → no-op (идемпотент)

    expect(steps.length, 'после settle emit не добавляются').toBe(countBefore);
  });
});

// ─── 5. Мутация RED-proof: удаление snap → должно стать RED ──────────────────

describe('timeline-reduced-motion: mutation RED-proof документация', () => {
  /**
   * Этот тест документирует, какая мутация делает вышестоящие тесты RED.
   * Он сам всегда GREEN — он объясняет структуру доказательства.
   *
   * Мутация 1: убрать `else if (reduce) { settle(true); }` →
   *   steps.length===0 синхронно (async path) → тест '===1' = RED.
   *
   * Мутация 2: заменить settle(true) → settle(false) →
   *   emit values = from (не to) → тест 'value===to' = RED.
   *
   * Мутация 3: snap → hard-off (no onStep) →
   *   steps.length===0 → тест '===1' = RED.
   */
  it('этот тест документирует RED-proof структуру (всегда GREEN)', () => {
    // Доказательство: reduce=true → CHARACTER-switch работает
    const steps: SegmentValue[][] = [];
    createTimeline({
      segments: [{ from: 5, to: 95, duration: 1 }],
      onStep: (vs) => steps.push([...vs]),
      matchMedia: makeReduceMedia(),
      requestFrame: noRaf(),
    });

    // Любая из трёх мутаций выше сделает один из этих asserts RED:
    expect(steps.length).toBe(1);          // Мутация 1 и 3 → RED
    expect(steps[0]![0]!.value).toBe(95);  // Мутация 2 → RED (было бы 5)
  });
});
