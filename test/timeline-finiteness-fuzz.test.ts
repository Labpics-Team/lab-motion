/**
 * test/timeline-finiteness-fuzz.test.ts
 * Класс: В/Property — fuzz 10k+ входов на NaN/Infinity-безопасность.
 *
 * Invariant 2 — CSS-safe: при ЛЮБЫХ входных значениях (включая overflow-range,
 * экстремальные длительности, t=Infinity при seek) таймлайн НИКОГДА не эмитирует
 * NaN или Infinity.
 *
 * ── RED PROOF (finiteness guard load-bearing) ─────────────────────────────────
 * Убрать `if (!Number.isFinite(raw)) return seg.to;` из computeSegmentAt:
 *   → при easing(t) = NaN/Infinity raw = NaN/Infinity →
 *     emit регистрирует non-finite → тест `Number.isFinite(v)` = RED.
 *
 * Убрать guard `if (seg.hasOverflowRange) return seg.to;`:
 *   → from=MAX_VALUE, to=-MAX_VALUE → range=-Infinity → raw = from + (-Inf)*t = -Inf →
 *     `Number.isFinite(v)` = RED для любого t > 0.
 *
 * ── MUTATION PROOF для overflow-range ────────────────────────────────────────
 * Заменить `hasOverflowRange = !Number.isFinite(range)` на `hasOverflowRange = false`:
 *   → overflow случай пройдёт к tween-вычислению → raw = ±Infinity → RED.
 */

import { describe, expect, it } from 'vitest';
import { createTimeline } from '../src/timeline/index.js';
import type { SegmentValue } from '../src/timeline/index.js';

// ─── Утилиты ──────────────────────────────────────────────────────────────────

/** Псевдослучайный LCG (детерминированный). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** non-draining requestFrame: возвращает 0, tick не вызывается автоматически. */
function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

/** Проверить конечность всех значений в массиве. */
function assertAllFinite(values: readonly SegmentValue[], label: string): void {
  for (const sv of values) {
    if (!Number.isFinite(sv.value)) {
      throw new Error(
        `[${label}] segment[${sv.index}].value = ${sv.value} — не конечное!`,
      );
    }
  }
}

// ─── Тест 1: Overflow-range fuzz ─────────────────────────────────────────────

describe('timeline-finiteness-fuzz: overflow-range (|from|+|to|>MAX_VALUE)', () => {
  it('10k+ overflow-range сегментов никогда не дают NaN/Infinity', () => {
    const rand = lcg(0xdeadbeef);
    const MAX = Number.MAX_VALUE;
    let violations = 0;

    for (let i = 0; i < 10_000; i++) {
      // from и to на краях MAX_VALUE — range overflow
      const from = rand() > 0.5 ? MAX * (0.5 + rand() * 0.5) : -MAX * (0.5 + rand() * 0.5);
      const to = rand() > 0.5 ? MAX * (0.5 + rand() * 0.5) : -MAX * (0.5 + rand() * 0.5);
      const duration = 0.1 + rand() * 2;

      const collected: SegmentValue[][] = [];
      const tl = createTimeline({
        segments: [{ from, to, duration }],
        onStep: (vs) => collected.push([...vs]),
        requestFrame: noRaf(),
      });
      // seek к нескольким точкам
      const seekT = rand() * duration;
      tl.seek(seekT);
      tl.seek(duration * 0.5);
      tl.seek(duration);
      tl.complete();

      for (const vs of collected) {
        for (const sv of vs) {
          if (!Number.isFinite(sv.value)) violations++;
        }
      }
    }

    expect(violations, `overflow-range нарушения: ${violations}`).toBe(0);
  });
});

// ─── Тест 2: Extreme t (seek) fuzz ───────────────────────────────────────────

describe('timeline-finiteness-fuzz: экстремальные seek значения', () => {
  it('seek(Infinity), seek(-Infinity), seek(NaN), seek(MAX_VALUE) никогда не дают NaN', () => {
    const extremeTs = [
      Infinity, -Infinity, NaN, Number.MAX_VALUE, -Number.MAX_VALUE,
      0, -0, 1e308, -1e308, Number.MIN_VALUE, Number.EPSILON,
    ];

    for (const seekT of extremeTs) {
      const collected: SegmentValue[][] = [];
      const tl = createTimeline({
        segments: [{ from: 0, to: 100, duration: 1 }],
        onStep: (vs) => collected.push([...vs]),
        requestFrame: noRaf(),
      });

      // seek никогда не бросает исключение (NaN/Infinity обрабатываются тихо
      // согласно спецификации) — вызываем напрямую, без defensive try/catch.
      tl.seek(seekT);
      tl.cancel();

      for (const vs of collected) {
        assertAllFinite(vs, `seek(${seekT})`);
      }
    }
  });
});

// ─── Тест 3: Random easing с NaN/Infinity на выходе ─────────────────────────

describe('timeline-finiteness-fuzz: easing возвращающий NaN/Infinity', () => {
  it('easing=() => NaN никогда не пропускает NaN в emit', () => {
    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{
        from: 0, to: 100, duration: 1,
        easing: () => NaN,  // всегда NaN
      }],
      onStep: (vs) => collected.push([...vs]),
      requestFrame: noRaf(),
    });
    // seek в середину: должен эмитировать конечное значение
    tl.seek(0.5);
    tl.complete();

    for (const vs of collected) {
      assertAllFinite(vs, 'easing=NaN');
    }
  });

  it('easing=() => Infinity никогда не пропускает Infinity в emit', () => {
    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{
        from: 0, to: 100, duration: 1,
        easing: () => Infinity,
      }],
      onStep: (vs) => collected.push([...vs]),
      requestFrame: noRaf(),
    });
    tl.seek(0.5);
    tl.complete();

    for (const vs of collected) {
      assertAllFinite(vs, 'easing=Infinity');
    }
  });

  it('easing=() => -Infinity никогда не пропускает -Infinity в emit', () => {
    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [{
        from: -50, to: 50, duration: 1,
        easing: () => -Infinity,
      }],
      onStep: (vs) => collected.push([...vs]),
      requestFrame: noRaf(),
    });
    tl.seek(0.5);
    tl.complete();

    for (const vs of collected) {
      assertAllFinite(vs, 'easing=-Infinity');
    }
  });
});

// ─── Тест 4: Полный fuzz 10k+ случайных сегментов ────────────────────────────

describe('timeline-finiteness-fuzz: 10k+ случайных сегментов (полный fuzz)', () => {
  it('никогда не эмитирует NaN/Infinity при случайных from/to/duration/seek', () => {
    const rand = lcg(0xc0ffee42);
    const MAX = Number.MAX_VALUE;
    let totalChecked = 0;
    let violations = 0;

    for (let i = 0; i < 10_000; i++) {
      // Случайные from/to — нормальные значения или edge-cases
      const fromSign = rand() > 0.5 ? 1 : -1;
      const toSign = rand() > 0.5 ? 1 : -1;
      const fromMag = rand() < 0.1 ? MAX * rand() : rand() * 1e6;
      const toMag = rand() < 0.1 ? MAX * rand() : rand() * 1e6;
      const from = fromSign * fromMag;
      const to = toSign * toMag;
      const duration = 0.01 + rand() * 5;

      // Случайный seek
      const seekT = rand() * duration * 1.5; // иногда за пределами

      const collected: SegmentValue[][] = [];
      const tl = createTimeline({
        segments: [{ from, to, duration }],
        onStep: (vs) => collected.push([...vs]),
        requestFrame: noRaf(),
      });
      tl.seek(seekT);
      tl.complete();

      for (const vs of collected) {
        for (const sv of vs) {
          totalChecked++;
          if (!Number.isFinite(sv.value)) violations++;
        }
      }
    }

    expect(totalChecked, 'должны быть проверены эмиты').toBeGreaterThan(0);
    expect(violations, `нарушения конечности: ${violations} / ${totalChecked}`).toBe(0);
  });
});

// ─── Тест 5: Множество сегментов — fuzz suперпозиции ─────────────────────────

describe('timeline-finiteness-fuzz: множество сегментов', () => {
  it('5-сегментный таймлайн с overflow-range: всё конечно', () => {
    const MAX = Number.MAX_VALUE;
    const collected: SegmentValue[][] = [];
    const tl = createTimeline({
      segments: [
        { from: 0, to: 100, duration: 0.5 },
        { from: MAX, to: -MAX, duration: 0.5 },     // overflow range
        { from: -MAX, to: MAX, duration: 0.5 },      // overflow range
        { from: 0, to: MAX, duration: 0.5 },         // large range (finite)
        { from: MAX * 0.5, to: MAX * 0.5, duration: 0.5 }, // from===to
      ],
      onStep: (vs) => collected.push([...vs]),
      requestFrame: noRaf(),
    });

    // Seek к разным точкам
    for (const t of [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5]) {
      tl.seek(t);
    }
    tl.complete();

    expect(collected.length).toBeGreaterThan(0);
    for (const vs of collected) {
      assertAllFinite(vs, '5-segment overflow');
    }
  });
});

// ─── Тест 6: Мутация — guard load-bearing (RED-proof структурный) ─────────────

describe('timeline-finiteness-fuzz: guard критичен (структурная проверка)', () => {
  it('seek(0.5) на нормальном сегменте возвращает значение в [from, to]', () => {
    const from = 0;
    const to = 100;
    const collected: SegmentValue[] = [];
    const tl = createTimeline({
      segments: [{ from, to, duration: 1 }],
      // Snapshot values (not refs to internal mutable buffer) to keep hotpath zero-alloc
      onStep: (vs) => collected.push(...vs.map((s) => ({ index: s.index, value: s.value }))),
      requestFrame: noRaf(),
    });
    tl.seek(0.5);
    tl.complete();

    // Ровно в середине (линейное easing): значение должно быть ~50
    const mid = collected.find((sv) => sv.index === 0);
    expect(mid).toBeDefined();
    expect(Number.isFinite(mid!.value)).toBe(true);
    // Линейное: 0 + (100-0)*0.5 = 50
    expect(mid!.value).toBeCloseTo(50);
  });

  it('seek(0.5) на overflow-range сегменте возвращает `to`', () => {
    // Overflow range: from=MAX, to=-MAX → range=-Infinity
    const from = Number.MAX_VALUE;
    const to = -Number.MAX_VALUE;
    const collected: SegmentValue[] = [];
    const tl = createTimeline({
      segments: [{ from, to, duration: 1 }],
      onStep: (vs) => collected.push(...vs),
      requestFrame: noRaf(),
    });
    tl.seek(0.5);
    tl.complete();

    const mid = collected.find((sv) => sv.index === 0);
    expect(mid).toBeDefined();
    // Overflow → snap to `to`
    expect(Number.isFinite(mid!.value)).toBe(true);
    expect(mid!.value).toBe(to);
  });
});
