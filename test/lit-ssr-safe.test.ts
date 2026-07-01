/**
 * test/lit-ssr-safe.test.ts
 * Класс: А (smoke) — SSR-safety contract для ./lit.
 *
 * vitest.config.ts объявляет `environment: 'node'` глобально для ВСЕГО test
 * suite — значит window/document/HTMLElement НЕ существуют ни в одном тесте.
 * Успешный импорт src/lit/index.ts В ЭТОМ ФАЙЛЕ уже сам по себе является
 * доказательством SSR-safety: если бы модуль обращался к window/document на
 * верхнем уровне, импорт бросил бы ReferenceError ДО первого `it()`.
 *
 * ── RED PROOF ──────────────────────────────────────────────────────────────
 * Добавить `window.matchMedia(...)` (без typeof-guard) на верхний уровень
 * src/lit/controller.ts или src/lit/element.ts:
 *   → импорт этого test-файла бросает `ReferenceError: window is not defined`
 *     ДО выполнения любого it() → весь файл падает (RED).
 * Добавить `document.createElement(...)` на верхний уровень:
 *   → аналогичный ReferenceError (document не определён в plain Node).
 */

import { describe, expect, it } from 'vitest';

describe('./lit SSR-safety (окружение: node, нет window/document/HTMLElement)', () => {
  it('sanity: window/document/HTMLElement действительно отсутствуют в этом окружении', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof HTMLElement).toBe('undefined');
  });

  it('импорт ./lit не бросает (доказательство отсутствия top-level window/document доступа)', async () => {
    // Если бы controller.ts/element.ts трогали window/document на верхнем
    // уровне модуля — этот await import() бросил бы ReferenceError.
    const mod = await import('../src/lit/index.js');
    expect(mod.MotionController).toBeDefined();
    expect(mod.LabMotionSpringElement).toBeDefined();
    expect(mod.LAB_MOTION_SPRING_TAG).toBeDefined();
  });

  it('MotionController конструируется и работает без window (SSR fallback: reduce=false)', async () => {
    const { MotionController } = await import('../src/lit/controller.js');
    const host = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => {},
      updateComplete: Promise.resolve(true),
    };
    // Нет matchMedia в options И нет window → resolveMatchMedia() возвращает
    // undefined без падения (typeof-guard внутри, не top-level).
    expect(() => new MotionController(host, 0)).not.toThrow();
  });
});
