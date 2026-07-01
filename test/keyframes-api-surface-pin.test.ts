/**
 * test/keyframes-api-surface-pin.test.ts
 * Класс: А (Unit) — pin контракта публичного API subpath ./keyframes.
 *
 * Фиксирует форму экспортируемого API:
 *   keyframes — функция, возвращает KeyframesControls.
 *   sampleKeyframes — чистая функция сэмплирования.
 *   KeyframesControls: totalDuration, time, progress (readonly),
 *                       play, pause, seek, complete, cancel, then (методы).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Удалить `totalDuration` из возвращаемого объекта keyframes() →
 *   `typeof controls.totalDuration === 'number'` → undefined → RED.
 * Переименовать keyframes → makeKeyframes → `typeof keyframes === 'function'`
 *   → undefined → RED.
 * Удалить экспорт sampleKeyframes → import падает на этапе сборки → RED.
 */

import { describe, expect, it } from 'vitest';
import { keyframes, sampleKeyframes } from '../src/keyframes/index.js';

function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

const TWO_VALUES = [0, 100] as const;

describe('keyframes-api-surface-pin: exports', () => {
  it('keyframes является функцией', () => {
    expect(typeof keyframes).toBe('function');
  });

  it('sampleKeyframes является функцией', () => {
    expect(typeof sampleKeyframes).toBe('function');
  });

  it('keyframes(...) возвращает объект (не null, не примитив)', () => {
    const c = keyframes({ values: [...TWO_VALUES], requestFrame: noRaf() });
    c.cancel();
    expect(typeof c).toBe('object');
    expect(c).not.toBeNull();
  });
});

describe('keyframes-api-surface-pin: KeyframesControls свойства', () => {
  it('totalDuration — число >= 0 (может быть Infinity)', () => {
    const c = keyframes({ values: [...TWO_VALUES], requestFrame: noRaf() });
    c.cancel();
    expect(typeof c.totalDuration).toBe('number');
    expect(c.totalDuration).toBeGreaterThanOrEqual(0);
  });

  it('time — конечное число', () => {
    const c = keyframes({ values: [...TWO_VALUES], requestFrame: noRaf() });
    c.cancel();
    expect(typeof c.time).toBe('number');
    expect(Number.isFinite(c.time)).toBe(true);
  });

  it('progress — число в [0, 1]', () => {
    const c = keyframes({ values: [...TWO_VALUES], requestFrame: noRaf() });
    c.cancel();
    expect(typeof c.progress).toBe('number');
    expect(c.progress).toBeGreaterThanOrEqual(0);
    expect(c.progress).toBeLessThanOrEqual(1);
  });
});

describe('keyframes-api-surface-pin: KeyframesControls методы', () => {
  const methodNames = ['play', 'pause', 'seek', 'complete', 'cancel', 'then'] as const;

  for (const name of methodNames) {
    it(`метод '${name}' — функция`, () => {
      const c = keyframes({ values: [...TWO_VALUES], requestFrame: noRaf() });
      c.cancel();
      expect(typeof (c as Record<string, unknown>)[name]).toBe('function');
    });
  }
});

describe('keyframes-api-surface-pin: thenable контракт', () => {
  it('keyframes(...).then(cb) — вызывает cb при complete()', async () => {
    let called = false;
    const c = keyframes({ values: [...TWO_VALUES], requestFrame: noRaf() });
    const p = c.then(() => {
      called = true;
    });
    c.complete();
    await p;
    expect(called).toBe(true);
  });

  it('await keyframes(...) с immediate complete', async () => {
    const c = keyframes({ values: [...TWO_VALUES], requestFrame: noRaf() });
    c.complete();
    await c;
  });
});

describe('keyframes-api-surface-pin: sampleKeyframes signature/contract', () => {
  it('sampleKeyframes(values, times, easings, p) returns a finite number', () => {
    const result = sampleKeyframes([0, 100], [0, 1], [(t: number) => t], 0.5);
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
  });
});
