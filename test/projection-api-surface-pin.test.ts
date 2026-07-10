/**
 * test/projection-api-surface-pin.test.ts — пин публичной поверхности ./projection.
 * Класс: Б (contract pin). Спека: §2.2 (API), §7.1.
 *
 * Пин в ОБЕ стороны (North-инвариант api-surface-pin): пропавший И лишний
 * runtime-экспорт = красный. Ровно 6 экспортов; типы (FlipRect, ProjectionBoxes,
 * ProjectionControls, …) стираются в рантайме и в Object.keys не попадают.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * На заглушке src/projection «missing»-ассерт первого блока падал бы СВОИМ
 * сообщением (перечень отсутствующих имён); shape/SSR-блоки — «… is not a
 * function» через pick-хелперы (namespace-import + pick, канон
 * test/animate-facade-helpers.ts:9-31): RED for the right reason.
 *
 * Mutation proof:
 *   - Переименовать/удалить любой из 6 экспортов → «missing» красный.
 *   - Добавить неконтрактный runtime-экспорт (напр. finiteDiv) → «extra» красный.
 *   - Убрать seek/release/boxAt/velocity из объекта createProjection() →
 *     shape-тест «ровно 8 ключей» красный.
 *   - Убрать capture из createDomProjection() → shape-тест «ровно 4 ключа» красный.
 *   - Ленивый DOM-доступ на верхнем уровне модуля (document/window при импорте) →
 *     SSR-блок красный (node-env без DOM).
 */

import { describe, expect, it } from 'vitest';
import * as projection from '../src/projection/index.js';
import {
  pickCornerRadiusAt,
  pickCreateDomProjection,
  pickCreateProjection,
  pickCreateProjector,
  pickMixBox,
  pickProjectAt,
} from './projection-helpers.js';

const EXPECTED_EXPORTS = [
  'cornerRadiusAt',
  'createDomProjection',
  'createProjection',
  'createProjector',
  'mixBox',
  'projectAt',
] as const;

const R = { x: 0, y: 0, width: 100, height: 100 };
const R2 = { x: 50, y: 25, width: 200, height: 50 };

describe('./projection public API surface pin (в обе стороны)', () => {
  it('экспортирует ровно 6 контрактных runtime-имён — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(projection));
    const expected = new Set<string>(EXPECTED_EXPORTS);

    const missing = [...expected].filter((name) => !exported.has(name));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !expected.has(name));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);

    // Точный отсортированный список (двойной замок: и множество, и порядок имён).
    expect(Object.keys(projection).sort()).toEqual([...EXPECTED_EXPORTS]);
  });

  it('каждый из 6 экспортов — функция', () => {
    const mod = projection as unknown as Record<string, unknown>;
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof mod[name], `${name} должен быть функцией`).toBe('function');
    }
  });
});

describe('./projection: форма ProjectionControls (исчерпывающе, 8 ключей)', () => {
  it('createProjection() → ровно play/cancel/seek/release/boxAt/playing/progress/velocity', () => {
    const controls = pickCreateProjection(projection as unknown as Record<string, unknown>)();
    expect(Object.keys(controls).sort()).toEqual([
      'boxAt',
      'cancel',
      'play',
      'playing',
      'progress',
      'release',
      'seek',
      'velocity',
    ]);
    expect(typeof controls.play).toBe('function');
    expect(typeof controls.cancel).toBe('function');
    expect(typeof controls.seek).toBe('function');
    expect(typeof controls.release).toBe('function');
    expect(typeof controls.boxAt).toBe('function');
    expect(typeof controls.playing).toBe('boolean');
    expect(typeof controls.progress).toBe('number');
    expect(typeof controls.velocity).toBe('number');
  });

  it('покой: playing=false, progress=1 (identity), velocity=0, boxAt(unknown)=undefined', () => {
    const controls = pickCreateProjection(projection as unknown as Record<string, unknown>)();
    expect(controls.playing).toBe(false);
    expect(controls.progress).toBe(1);
    expect(controls.velocity).toBe(0);
    expect(controls.boxAt('nope')).toBeUndefined();
  });
});

describe('./projection: форма DomProjectionControls (исчерпывающе, 4 ключа)', () => {
  it('createDomProjection() → ровно capture/play/cancel/playing', () => {
    const dom = pickCreateDomProjection(projection as unknown as Record<string, unknown>)();
    expect(Object.keys(dom).sort()).toEqual(['cancel', 'capture', 'play', 'playing']);
    expect(typeof dom.capture).toBe('function');
    expect(typeof dom.play).toBe('function');
    expect(typeof dom.cancel).toBe('function');
    expect(typeof dom.playing).toBe('boolean');
  });
});

describe('./projection: SSR no-throw (node-env, без DOM)', () => {
  it('импорт и чистая математика не трогают DOM', () => {
    const mod = projection as unknown as Record<string, unknown>;
    expect(() => {
      pickMixBox(mod)(R, R2, 0.5);
      pickProjectAt(mod)({ first: R, last: R2 }, null, 0.5);
      pickCornerRadiusAt(mod)({ x: 8, y: 8 }, { x: 4, y: 4 }, 1, 1, 0.5);
      pickCreateProjector(mod)([{ id: 'a', first: R, last: R2 }]).at(0.5);
    }).not.toThrow();
  });

  it('фабрики создаются в node без DOM (P2: DOM резолвится в момент вызова)', () => {
    const mod = projection as unknown as Record<string, unknown>;
    expect(() => {
      pickCreateProjection(mod)();
      pickCreateDomProjection(mod)();
    }).not.toThrow();
  });

  it('DOM-адаптер SSR-инертен: capture([]) → play() → cancel() не бросают (§2.4)', () => {
    const dom = pickCreateDomProjection(projection as unknown as Record<string, unknown>)();
    expect(() => {
      dom.capture([]);
      dom.play();
      dom.cancel();
    }).not.toThrow();
  });
});
