/**
 * test/animate-facade-ssr.test.ts — SSR-безопасность субпутя ./animate.
 *
 * Класс: contract (инвариант 4 пакета — импорт любого субпутя не трогает
 * window/document; DOM-обращения только внутри вызова animate()).
 *
 * Среда vitest — node: window/document отсутствуют. Если бы модуль читал DOM
 * на верхнем уровне, сам import упал бы ReferenceError'ом — тесты ниже
 * дополнительно пиняют, что импорт ничего не создал и вызов деградирует
 * ЧИСТОЙ доменной ошибкой (MotionParamError), а не ReferenceError.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * На заглушке (export {}) «animate — функция» падал бы своим ассертом.
 * Mutation proof: добавить в модуль top-level `document.title` → import в node
 * бросает → весь файл красный; резолвить селектор через замыкание, захваченное
 * на импорте → тест «MotionParamError, не ReferenceError» красный.
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import { MotionParamError } from '../src/errors.js';
import { pickAnimate } from './animate-facade-helpers.js';

describe('./animate — SSR-safe импорт (инвариант 4)', () => {
  it('среда действительно без DOM (герметичность самого теста)', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });

  it('модуль импортирован в чистом node и animate — функция', () => {
    expect(typeof pickAnimate(animateApi as Record<string, unknown>)).toBe('function');
  });

  it('импорт не создал глобалей window/document (не трогает DOM)', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });

  it('вызов с селектором без document → LM149, не ReferenceError', () => {
    const animate = pickAnimate(animateApi as Record<string, unknown>);
    let caught: unknown;
    try {
      animate('.item', { x: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).not.toBe('ReferenceError');
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe('LM149');
  });

  it('duck-typed цель анимируется в node без DOM (headless-контракт)', async () => {
    const animate = pickAnimate(animateApi as Record<string, unknown>);
    const writes: string[] = [];
    const el = {
      style: {
        setProperty: (_n: string, v: string) => void writes.push(v),
        getPropertyValue: () => '',
      },
    };
    const queue: Array<(ts?: number) => void> = [];
    let ts = 0;
    const controls = animate(el, { x: 10 }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      requestFrame: (cb: (t?: number) => void) => (queue.push(cb), queue.length),
    });
    for (let i = 0; i < 5000 && queue.length > 0; i++) {
      ts += 16;
      const batch = queue.splice(0);
      for (const cb of batch) cb(ts);
    }
    await controls.finished;
    expect(writes.at(-1)).toBe('translateX(10px)');
  });
});
