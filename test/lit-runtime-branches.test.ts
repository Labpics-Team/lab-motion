// @vitest-environment jsdom
/**
 * lit-runtime-branches.test.ts — ветви ./lit, до которых сьюта не доходила.
 *
 * ЗАЧЕМ. Ратчет покрытия (#249-урок) показал, что в области `lit` три ветви не
 * исполняются НИ ОДНИМ тестом, а одна из них к тому же ведёт себя по-разному на
 * Node 22 и Node 24 — расхождение, которое до появления гейта было невидимо.
 * Все три — не экзотика, а честные пользовательские сценарии:
 *   1. хост-окружение с `window`, но БЕЗ `matchMedia` (jsdom старых версий,
 *      встроенные webview, тестовые песочницы) — reduced-motion обязан
 *      деградировать в «нет», а не падать;
 *   2. повторное подключение элемента к DOM (disconnect → reconnect): контроллер
 *      обязан создаваться РОВНО один раз, иначе на элементе окажется два
 *      конкурирующих контроллера;
 *   3. повторный импорт модуля при уже зарегистрированном теге — `define`
 *      обязан не бросать `NotSupportedError`.
 *
 * Mutation proof: снять `typeof window.matchMedia === 'function'` → блок 1 RED
 * (TypeError); снять `if (!this._motion)` → блок 2 RED (два контроллера);
 * снять `!customElements.get(...)` → блок 3 RED (NotSupportedError).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAB_MOTION_SPRING_TAG, MotionController } from '../src/lit/index.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

/** Минимальный ReactiveControllerHost: контроллеру больше ничего не нужно. */
function makeHost() {
  const controllers: { hostConnected?: () => void; hostDisconnected?: () => void }[] = [];
  let updates = 0;
  return {
    controllers,
    updates: () => updates,
    addController(c: { hostConnected?: () => void; hostDisconnected?: () => void }) {
      controllers.push(c);
    },
    removeController() {},
    requestUpdate() { updates++; },
    updateComplete: Promise.resolve(true),
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('#lit: окружение с window, но без matchMedia', () => {
  it('контроллер создаётся и трактует reduced-motion как false, а не падает', () => {
    // jsdom даёт window; убираем ИМЕННО matchMedia — та самая ветвь
    // `typeof window.matchMedia === 'function'`, которая не исполнялась.
    const original = window.matchMedia;
    // @ts-expect-error — намеренно ломаем host-API, как это делают песочницы.
    delete window.matchMedia;
    try {
      const host = makeHost();
      const controller = new MotionController(host, 0, { spring: SPRING });
      expect(host.controllers).toHaveLength(1);
      // Значение живо и управляемо: деградация не отключила биндинг.
      controller.hostConnected();
      controller.setTarget(10);
      expect(Number.isFinite(controller.value)).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });

  it('явный инжект matchMedia побеждает окружение', () => {
    const calls: string[] = [];
    const host = makeHost();
    const controller = new MotionController(host, 0, {
      spring: SPRING,
      matchMedia: (query: string) => {
        calls.push(query);
        return { matches: true } as MediaQueryList;
      },
    });
    // Seam спрашивается лениво — на setTarget, а не в конструкторе.
    controller.hostConnected();
    controller.setTarget(42);
    expect(calls.some((q) => q.includes('prefers-reduced-motion'))).toBe(true);
    // reduced-motion=true: значение обязано ставиться мгновенно, без кадров.
    expect(controller.value).toBe(42);
  });
});

describe('#lit: повторное подключение элемента', () => {
  it('контроллер создаётся ровно один раз при disconnect → reconnect', async () => {
    const { LabMotionSpringElement } = await import('../src/lit/element.js');
    const el = document.createElement(LAB_MOTION_SPRING_TAG) as InstanceType<
      typeof LabMotionSpringElement
    >;
    el.spring = SPRING;
    document.body.appendChild(el);
    await el.updateComplete;
    const first = (el as unknown as { _motion: unknown })._motion;
    expect(first).toBeDefined();

    el.remove();
    document.body.appendChild(el);
    await el.updateComplete;
    // Ветвь `if (!this._motion)` во ВТОРОЙ раз обязана быть ложной: иначе на
    // элементе оказались бы два контроллера, оба пишущие в один style.
    expect((el as unknown as { _motion: unknown })._motion).toBe(first);
    el.remove();
  });
});

describe('#lit: повторная регистрация тега', () => {
  it('второй импорт модуля не бросает NotSupportedError', async () => {
    expect(customElements.get(LAB_MOTION_SPRING_TAG)).toBeDefined();
    // Сброс кэша модулей заставляет модуль исполнить define-гейт ЗАНОВО при
    // уже занятом теге — ровно ветвь `!customElements.get(...)` = false.
    vi.resetModules();
    await expect(import('../src/lit/element.js')).resolves.toBeDefined();
    expect(customElements.get(LAB_MOTION_SPRING_TAG)).toBeDefined();
  });
});
