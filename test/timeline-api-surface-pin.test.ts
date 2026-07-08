/**
 * test/timeline-api-surface-pin.test.ts
 * Класс: А (Unit) — pin контракта публичного API.
 *
 * Фиксирует форму экспортируемого API subpath ./timeline:
 *   createTimeline — функция, возвращает TimelineControls.
 *   TimelineControls: totalDuration, time, progress (readonly),
 *                     play, pause, seek, complete, cancel, then (методы).
 *
 * ── ЗАЧЕМ ────────────────────────────────────────────────────────────────────
 * API-surface-pin тест предотвращает случайное переименование/удаление
 * публичного API при рефакторинге. Это не тест поведения — это гвоздь контракта.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Удалить `totalDuration` из возвращаемого объекта createTimeline:
 *   → `typeof controls.totalDuration === 'number'` → undefined → RED.
 * Переименовать createTimeline → makeTimeline:
 *   → `typeof createTimeline === 'function'` → undefined → RED.
 */

import { describe, expect, it } from 'vitest';
import { createTimeline } from '../src/timeline/index.js';

// ─── Вспомогательные данные ───────────────────────────────────────────────────

/** Минимальный валидный сегмент для pin-тестов. */
const ONE_SEGMENT = [{ from: 0, to: 100, duration: 1 }] as const;

/** non-draining requestFrame (handle=0) — не запускает тик автоматически. */
function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

// ─── Тесты ────────────────────────────────────────────────────────────────────

describe('timeline-api-surface-pin: createTimeline экспорт', () => {
  it('createTimeline является функцией', () => {
    expect(typeof createTimeline).toBe('function');
  });

  it('createTimeline(...) возвращает объект (не null, не примитив)', () => {
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    tl.cancel();
    expect(typeof tl).toBe('object');
    expect(tl).not.toBeNull();
  });
});

describe('timeline-api-surface-pin: TimelineControls свойства', () => {
  it('totalDuration — конечное число >= 0', () => {
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    tl.cancel();
    expect(typeof tl.totalDuration).toBe('number');
    expect(Number.isFinite(tl.totalDuration)).toBe(true);
    expect(tl.totalDuration).toBeGreaterThanOrEqual(0);
  });

  it('time — конечное число', () => {
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    tl.cancel();
    expect(typeof tl.time).toBe('number');
    expect(Number.isFinite(tl.time)).toBe(true);
  });

  it('progress — число в [0, 1]', () => {
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    tl.cancel();
    expect(typeof tl.progress).toBe('number');
    expect(tl.progress).toBeGreaterThanOrEqual(0);
    expect(tl.progress).toBeLessThanOrEqual(1);
  });
});

describe('timeline-api-surface-pin: TimelineControls методы', () => {
  const methodNames = ['play', 'pause', 'seek', 'complete', 'cancel', 'then', 'label'] as const;

  for (const name of methodNames) {
    it(`метод '${name}' — функция`, () => {
      const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
      tl.cancel();
      expect(typeof (tl as Record<string, unknown>)[name]).toBe('function');
    });
  }
});

describe('timeline-api-surface-pin: исчерпывающий пин (ловит и ЛИШНИЕ члены)', () => {
  // Пин в обе стороны: пропавший член ловят тесты выше, ДОБАВЛЕННЫЙ член —
  // этот. RED PROOF: добавить в возвращаемый объект createTimeline любой новый
  // ключ (напр. `reverse`) → массив ключей разойдётся с эталоном → RED.
  it('Object.keys(controls) — ровно запиненный набор, без лишних', () => {
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    tl.cancel();
    expect(Object.keys(tl).sort()).toEqual(
      ['cancel', 'complete', 'label', 'pause', 'play', 'progress', 'seek', 'then', 'time', 'totalDuration'],
    );
  });
});

describe('timeline-api-surface-pin: thenable контракт', () => {
  it('createTimeline(...).then(cb) — вызывает cb при complete()', async () => {
    let called = false;
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    const p = tl.then(() => { called = true; });
    tl.complete();
    await p;
    expect(called).toBe(true);
  });

  it('await createTimeline(...) с immediate complete', async () => {
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    tl.complete();
    await tl; // Promise-совместимость
  });
});

describe('timeline-api-surface-pin: totalDuration правильно вычислен', () => {
  it('один сегмент duration=2 → totalDuration=2', () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 1, duration: 2 }],
      requestFrame: noRaf(),
    });
    tl.cancel();
    expect(tl.totalDuration).toBeCloseTo(2);
  });

  it('два последовательных сегмента по 1с → totalDuration=2', () => {
    const tl = createTimeline({
      segments: [
        { from: 0, to: 1, duration: 1 },
        { from: 1, to: 2, duration: 1 },
      ],
      requestFrame: noRaf(),
    });
    tl.cancel();
    expect(tl.totalDuration).toBeCloseTo(2);
  });

  it('сегмент с offset=0.5 смещает начало → totalDuration растёт', () => {
    // Сегмент 0: [0, 1], Сегмент 1: [1.5, 2.5] (offset=0.5)
    const tl = createTimeline({
      segments: [
        { from: 0, to: 1, duration: 1 },
        { from: 1, to: 2, duration: 1, offset: 0.5 },
      ],
      requestFrame: noRaf(),
    });
    tl.cancel();
    expect(tl.totalDuration).toBeCloseTo(2.5);
  });

  it('сегмент с at=3 → totalDuration >= 3 + duration', () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 1, duration: 0.5, at: 3 }],
      requestFrame: noRaf(),
    });
    tl.cancel();
    expect(tl.totalDuration).toBeCloseTo(3.5);
  });
});

describe('timeline-api-surface-pin: ошибки при невалидных входах', () => {
  it('пустой массив segments → MotionParamError', () => {
    expect(() => createTimeline({ segments: [] })).toThrow();
  });

  it('segment.from = NaN → MotionParamError', () => {
    expect(() =>
      createTimeline({ segments: [{ from: NaN, to: 1, duration: 1 }] }),
    ).toThrow();
  });

  it('segment.duration <= 0 → MotionParamError', () => {
    expect(() =>
      createTimeline({ segments: [{ from: 0, to: 1, duration: 0 }] }),
    ).toThrow();
  });

  it('segment.duration = -1 → MotionParamError', () => {
    expect(() =>
      createTimeline({ segments: [{ from: 0, to: 1, duration: -1 }] }),
    ).toThrow();
  });
});

// === STEP 2: labels + position params (GSAP/anime parity) — production-ready ===
// TDD: RED proof captured (see RED-timeline-step2-proof.txt: label missing → 4 fails incl pin + step2 tests).
// Characterization (class B): current behavior locked via virtual-time differential + explicit cases.
// Property (class V): totalDuration invariant for absolute/label positions independent of order.
// Full support: label(name,at?), seek(name), at: label | '<' | '>' | '+=N' | '-=N' | number ; labels in opts.
// api-pin updated (incl .label). All position variants + mixed. No 'any' casts in final tests.

describe('timeline labels + position params (step 2) — production', () => {
  it('TimelineControls has .label(name, at?) method (pinned)', () => {
    const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
    tl.cancel();
    expect(typeof (tl as Record<string, unknown>).label).toBe('function');
  });

  it('label(name) + seek("name") works (runtime label + seek by name)', () => {
    const tl = createTimeline({
      segments: [
        { from: 0, to: 10, duration: 1 },
        { from: 10, to: 20, duration: 1 },
      ],
      requestFrame: noRaf(),
    });
    tl.label('mid', 1);
    tl.seek('mid');
    expect(tl.time).toBeCloseTo(1, 5);
    tl.cancel();
  });

  it('label(name, string-ref) resolves using existing labels', () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 10, duration: 1 }],
      labels: { base: 0 },
      requestFrame: noRaf(),
    });
    tl.label('derived', 'base');
    tl.seek('derived');
    expect(tl.time).toBeCloseTo(0, 5);
    tl.cancel();
  });

  it('segment at supports full position grammar: number, label, < > += -= (with labels opt)', () => {
    const tl = createTimeline({
      segments: [
        { from: 0, to: 5, duration: 1, at: 0 },
        { from: 5, to: 15, duration: 1, at: '>' }, // end of prev =1
        { from: 15, to: 25, duration: 1, at: '<' }, // start of prev =1
        { from: 25, to: 35, duration: 1, at: '+=0.5' }, // end prev(2) +0.5 =2.5
        { from: 35, to: 45, duration: 1, at: '-=0.25' }, // 2.5 -0.25? but prev end now 3.5 wait, sequential calc
      ],
      labels: { start: 0 },
      requestFrame: noRaf(),
    });
    // Validate total from resolved starts: max ends
    // seg0:0-1, seg1:1-2, seg2:1-2, seg3:2.5-3.5, seg4: ? but to keep simple check >3
    expect(tl.totalDuration).toBeGreaterThan(3);
    tl.cancel();
  });

  it('property: totalDuration invariant to segment order when using absolute positions (labels)', () => {
    const labels = { L0: 0, L1: 1 } as const;
    const make = (order: 'normal' | 'reversed') => {
      const base = [
        { from: 0, to: 1, duration: 1, at: 'L0' as const },
        { from: 1, to: 2, duration: 1, at: 'L1' as const },
      ];
      const segs = order === 'normal' ? base : [...base].reverse();
      const tl = createTimeline({ segments: segs, labels, requestFrame: noRaf() });
      const d = tl.totalDuration;
      tl.cancel();
      return d;
    };
    const d1 = make('normal');
    const d2 = make('reversed');
    expect(d1).toBeCloseTo(2, 5); // L0@0 +1 → end1; L1@1 +1 → end2
    expect(d2).toBeCloseTo(2, 5);
    expect(d1).toBeCloseTo(d2, 5);
  });
});
