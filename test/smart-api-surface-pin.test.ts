/**
 * test/smart-api-surface-pin.test.ts — пин публичной поверхности ./smart.
 * Класс: Б (contract pin). Спека: §3.1 (API), минимальный скоуп #99 фазы G
 * (VT-тир вырезан: SmartTier без 'view-transitions', см. докблок src/smart/index.ts).
 *
 * Пин в ОБЕ стороны (North-инвариант api-surface-pin): пропавший И лишний
 * runtime-экспорт = красный. Ровно 4 экспорта; типы (SmartElement, SmartRoot,
 * SmartOptions, …) стираются в рантайме и в Object.keys не попадают.
 *
 * ── RED PROOF (факт от 2026-07-10, заглушка src/smart/index.ts `export {}`) ──
 * «missing»-ассерт первого блока падал СВОИМ сообщением:
 *   AssertionError: Отсутствующие экспорты: SMART_KEY_ATTR, captureSmart,
 *   resolveSmartTier, smartTransition: expected [ …(4) ] to have a length of 0
 * shape/SSR/fail-fast-блоки — «captureSmart is not a function» и
 * «resolveSmartTier is not a function» через pick-хелперы: RED for the right reason.
 *
 * Mutation proof:
 *   - Переименовать/удалить любой из 4 экспортов → «missing» красный.
 *   - Добавить неконтрактный runtime-экспорт (напр. classifySmart) → «extra» красный.
 *   - Убрать plan/tier из объекта animate() → shape-тест «ровно 6 ключей» красный.
 *   - Ленивый DOM-доступ на верхнем уровне модуля → SSR-блок красный (node без DOM).
 *   - Сломать раннюю валидацию (keyAttr/epsilon/spring) → fail-fast-блок красный.
 */

import { describe, expect, it } from 'vitest';
import * as smart from '../src/smart/index.js';
import { MotionParamError } from '../src/errors.js';
import {
  pickCaptureSmart,
  pickResolveSmartTier,
  pickSmartKeyAttr,
  pickSmartTransition,
  reduceMedia,
} from './smart-helpers.js';

const mod = smart as unknown as Record<string, unknown>;

const EXPECTED_EXPORTS = [
  'SMART_KEY_ATTR',
  'captureSmart',
  'resolveSmartTier',
  'smartTransition',
] as const;

describe('./smart public API surface pin (в обе стороны)', () => {
  it('экспортирует ровно 4 контрактных runtime-имени — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(smart));
    const expected = new Set<string>(EXPECTED_EXPORTS);

    const missing = [...expected].filter((name) => !exported.has(name));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !expected.has(name));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);

    // Точный отсортированный список (двойной замок: и множество, и порядок имён).
    expect(Object.keys(smart).sort()).toEqual([...EXPECTED_EXPORTS]);
  });

  it('SMART_KEY_ATTR === "data-motion-key" (DX-константа), остальные — функции', () => {
    expect(pickSmartKeyAttr(mod)).toBe('data-motion-key');
    expect(typeof pickCaptureSmart(mod)).toBe('function');
    expect(typeof pickSmartTransition(mod)).toBe('function');
    expect(typeof pickResolveSmartTier(mod)).toBe('function');
  });
});

describe('./smart: resolveSmartTier (precedence reduced → projection → ssr)', () => {
  it('reduced имеет высший приоритет; без DOM-признаков — ssr', () => {
    const resolve = pickResolveSmartTier(mod);
    expect(resolve({ matchMedia: reduceMedia(true), requestFrame: () => 1 })).toBe('reduced');
    expect(resolve({ matchMedia: reduceMedia(false), requestFrame: () => 1 })).toBe('projection');
    expect(resolve({ requestFrame: () => 1 })).toBe('projection');
    expect(resolve({ documentLike: {} })).toBe('projection');
    expect(resolve({})).toBe('ssr');
    expect(resolve()).toBe('ssr');
  });

  it('негативный контроль: matchMedia без reduce не включает reduced', () => {
    const resolve = pickResolveSmartTier(mod);
    expect(resolve({ matchMedia: reduceMedia(false) })).toBe('ssr');
  });
});

describe('./smart: форма SmartCapture (2 ключа) и SmartHandle (6 ключей)', () => {
  it('captureSmart(не-элемент) → инертный capture: ровно animate/size', () => {
    const cap = pickCaptureSmart(mod)({});
    expect(Object.keys(cap).sort()).toEqual(['animate', 'size']);
    expect(typeof cap.animate).toBe('function');
    expect(cap.size).toBe(0);
  });

  it('animate() → ровно finished/cancel/playing/progress/tier/plan', () => {
    const handle = pickCaptureSmart(mod)({}).animate();
    expect(Object.keys(handle).sort()).toEqual([
      'cancel',
      'finished',
      'plan',
      'playing',
      'progress',
      'tier',
    ]);
    expect(typeof handle.cancel).toBe('function');
    expect(typeof handle.finished.then).toBe('function');
    expect(typeof handle.playing).toBe('boolean');
    expect(typeof handle.progress).toBe('number');
    expect(typeof handle.tier).toBe('string');
    expect(Object.keys(handle.plan).sort()).toEqual(['entered', 'exited', 'matched', 'skipped']);
  });
});

describe('./smart: SSR-инертность (node-env, без DOM — канон autoAnimate)', () => {
  it('captureSmart на не-элементе: size 0, tier "ssr", finished сразу резолвнут', async () => {
    const cap = pickCaptureSmart(mod)({});
    expect(cap.size).toBe(0);
    const handle = cap.animate();
    expect(handle.tier).toBe('ssr');
    expect(handle.playing).toBe(false);
    expect(handle.progress).toBe(1);
    expect(handle.plan.matched).toEqual([]);
    await handle.finished; // уже резолвнут — await не виснет
    expect(() => handle.cancel()).not.toThrow(); // идемпотентен и на инертном
  });

  it('smartTransition в SSR: mutate выполняется, handle инертен, не бросок', async () => {
    let ran = false;
    const handle = pickSmartTransition(mod)({}, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(handle.tier).toBe('ssr');
    await handle.finished;
  });
});

describe('./smart: fail-fast валидация ПАРАМЕТРОВ (MotionParamError рано, даже под reduce)', () => {
  it('пустой keyAttr → MotionParamError LM085', () => {
    expect(() => pickCaptureSmart(mod)({}, { keyAttr: '' })).toThrowError(MotionParamError);
    expect(() => pickCaptureSmart(mod)({}, { keyAttr: '' })).toThrowError(
      'LM085',
    );
  });

  it('невалидный epsilon → code-only LM086', () => {
    expect(() => pickCaptureSmart(mod)({}, { epsilon: -1 })).toThrowError(MotionParamError);
    expect(() => pickCaptureSmart(mod)({}, { epsilon: NaN })).toThrowError('LM086');
  });

  it('невалидная пружина → MotionParamError В ФАБРИКЕ, даже под reduced-motion', () => {
    expect(() =>
      pickCaptureSmart(mod)(
        {},
        { spring: { mass: -1, stiffness: 200, damping: 24 }, matchMedia: reduceMedia(true) },
      ),
    ).toThrowError(MotionParamError);
  });

  it('smartTransition: mutate не функция → MotionParamError до любых эффектов', () => {
    expect(() =>
      pickSmartTransition(mod)({}, 42 as unknown as () => void),
    ).toThrowError(MotionParamError);
  });
});
