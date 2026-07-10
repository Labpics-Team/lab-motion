/**
 * test/animate-mini-api-surface-pin.test.ts — пин публичной поверхности ./animate/mini.
 *
 * Класс: contract (инвариант пакета — точный набор рантайм-экспортов субпутя,
 * В ОБЕ СТОРОНЫ: пропавший И лишний экспорт — красный тест). Образец —
 * animate-facade-api-surface-pin.test.ts / smart-api-surface-pin.test.ts.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Экспортни из mini/index.ts любой internal (напр. `export { runAnimate }`) →
 * «Лишние экспорты: runAnimate» красный. Переименуй/удали animate → «Пропавшие».
 * Типы (AnimateControls, AnimateOptions, AnimateProps, AnimateTarget, PropValue)
 * — type-only, стираются в рантайме и в Object.keys не попадают.
 */

import { describe, expect, it } from 'vitest';
import * as miniModule from '../src/animate/mini/index.js';

/** Ровно один runtime-экспорт: сама функция среза. Остальное — type-only. */
const EXPECTED_EXPORTS = new Set(['animate']);

describe('./animate/mini — пин публичной поверхности (в обе стороны)', () => {
  it('экспортирует ровно контрактные имена — не больше и не меньше', () => {
    const exported = new Set(Object.keys(miniModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Пропавшие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
    expect(extra, `Лишние экспорты: ${extra.join(', ')}`).toHaveLength(0);

    // Точный отсортированный список (двойной замок: и множество, и порядок имён).
    expect(Object.keys(miniModule).sort()).toEqual(['animate']);
  });

  it('animate — функция с сигнатурой (target, props, options?)', () => {
    const animate = (miniModule as Record<string, unknown>)['animate'];
    expect(typeof animate).toBe('function');
    // length учитывает только обязательные параметры: target и props.
    expect((animate as (...args: unknown[]) => unknown).length).toBe(2);
  });
});
