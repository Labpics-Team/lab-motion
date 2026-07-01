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
  const methodNames = ['play', 'pause', 'seek', 'complete', 'cancel', 'then'] as const;

  for (const name of methodNames) {
    it(`метод '${name}' — функция`, () => {
      const tl = createTimeline({ segments: ONE_SEGMENT, requestFrame: noRaf() });
      tl.cancel();
      expect(typeof (tl as Record<string, unknown>)[name]).toBe('function');
    });
  }
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
