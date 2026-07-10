/**
 * test/behaviors-api-surface-pin.test.ts — пин публичной поверхности ./behaviors.
 * Класс: Б (contract pin). Пин в ОБЕ стороны (North-инвариант): пропавший И
 * лишний runtime-экспорт = красный. Ровно 4 фабрики; типы (BehaviorState,
 * SheetController, …) стираются в рантайме и в Object.keys не попадают.
 *
 * RED PROOF (2026-07-10, заглушка src/behaviors `export {}`): «missing»-ассерт
 * первого блока падал своим сообщением (все 4 фабрики отсутствуют). Shape-блоки —
 * «createBottomSheet is not a function»: RED for the right reason.
 */

import { describe, expect, it } from 'vitest';
import * as behaviors from '../src/behaviors/index.js';
import { MotionParamError } from '../src/errors.js';

const EXPECTED_EXPORTS = [
  'createBottomSheet',
  'createCarousel',
  'createDragDismiss',
  'createPullToRefresh',
] as const;

describe('./behaviors public API surface pin (в обе стороны)', () => {
  it('экспортирует ровно 4 контрактных runtime-фабрики — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(behaviors));
    const expected = new Set<string>(EXPECTED_EXPORTS);

    const missing = [...expected].filter((n) => !exported.has(n));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((n) => !expected.has(n));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);

    expect(Object.keys(behaviors).sort()).toEqual([...EXPECTED_EXPORTS]);
  });

  it('каждый экспорт — функция-фабрика', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof (behaviors as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('./behaviors: единый контракт BehaviorState { value, velocity, phase }', () => {
  it('все четыре поведения выдают BehaviorState c общими ключами', () => {
    const sheet = behaviors.createBottomSheet({ snapPoints: [0, 100] }).state;
    const dismiss = behaviors.createDragDismiss({ distanceThreshold: 50 }).state;
    const carousel = behaviors.createCarousel({ pageCount: 3, pageSize: 200 }).state;
    const pull = behaviors.createPullToRefresh({ threshold: 60 }).state;
    for (const s of [sheet, dismiss, carousel, pull]) {
      expect(typeof s.value).toBe('number');
      expect(typeof s.velocity).toBe('number');
      expect(['idle', 'follow', 'release', 'settle']).toContain(s.phase);
    }
    // Специфичные расширения состояния.
    expect(typeof sheet.snapIndex).toBe('number');
    expect(typeof dismiss.dismissed).toBe('boolean');
    expect(typeof carousel.index).toBe('number');
    expect(typeof pull.pending).toBe('boolean');
  });
});

describe('./behaviors: fail-fast валидация параметров (MotionParamError в фабрике)', () => {
  it('пустые snapPoints → MotionParamError', () => {
    expect(() => behaviors.createBottomSheet({ snapPoints: [] })).toThrowError(MotionParamError);
  });
  it('невалидный distanceThreshold → MotionParamError', () => {
    expect(() => behaviors.createDragDismiss({ distanceThreshold: 0 })).toThrowError(
      MotionParamError,
    );
  });
  it('pageCount < 1 → MotionParamError', () => {
    expect(() => behaviors.createCarousel({ pageCount: 0, pageSize: 100 })).toThrowError(
      MotionParamError,
    );
  });
  it('threshold <= 0 → MotionParamError', () => {
    expect(() => behaviors.createPullToRefresh({ threshold: -1 })).toThrowError(MotionParamError);
  });
  it('невалидная пружина → MotionParamError В ФАБРИКЕ (даже без матчмедиа)', () => {
    expect(() =>
      behaviors.createBottomSheet({
        snapPoints: [0, 100],
        spring: { mass: -1, stiffness: 200, damping: 24 },
      }),
    ).toThrowError(MotionParamError);
  });
});
