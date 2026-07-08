/**
 * test/animate-facade-api-surface-pin.test.ts — пин публичной поверхности ./animate.
 *
 * Класс: contract (инвариант 6 пакета — точный набор экспортов, В ОБЕ СТОРОНЫ:
 * пропавший И лишний экспорт — красный тест).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Рождён на пустой заглушке (export {}) — «toContain('animate')» красный.
 *
 * Mutation proof (после реализации):
 *  - удалить `export function animate` → missing-ассерт красный;
 *  - добавить недокументированный экспорт `internalRegistry` → exact-set красный;
 *  - переименовать animate → toContain красный.
 */

import { describe, expect, it } from 'vitest';
import * as animateModule from '../src/animate/index.js';

/**
 * Ровно один runtime-экспорт: сама функция фасада. Типы (AnimateControls,
 * AnimateOptions, AnimateProps, AnimateTarget, AnimatableElement) — type-only,
 * стираются при рантайме и в этот пин не входят.
 */
const EXPECTED_EXPORTS = new Set(['animate']);

describe('./animate — пин публичной поверхности (инвариант 6)', () => {
  it('экспортирует ровно контрактные имена — не больше и не меньше', () => {
    const exported = new Set(Object.keys(animateModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Пропавшие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
    expect(extra, `Лишние экспорты: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('animate — функция с сигнатурой (target, props, options?)', () => {
    const animate = (animateModule as Record<string, unknown>)['animate'];
    expect(typeof animate).toBe('function');
    // length учитывает только обязательные параметры: target и props.
    expect((animate as (...args: unknown[]) => unknown).length).toBe(2);
  });
});
