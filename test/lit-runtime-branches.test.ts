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
    // ФАКТ ОКРУЖЕНИЯ (замерен, а не предположен): jsdom этой версии НЕ
    // реализует window.matchMedia вовсе — `typeof window.matchMedia` здесь
    // 'undefined' по умолчанию. То есть это состояние по умолчанию всей
    // lit-сьюты, и именно поэтому ambient-ветка ниже так долго не исполнялась.
    expect(typeof window.matchMedia).toBe('undefined');
    const host = makeHost();
    const controller = new MotionController(host, 0, { spring: SPRING });
    expect(host.controllers).toHaveLength(1);
    // Значение живо и управляемо: деградация не отключила биндинг.
    controller.hostConnected();
    controller.setTarget(10);
    expect(Number.isFinite(controller.value)).toBe(true);
  });

  it('AMBIENT window.matchMedia подхватывается без явного инжекта', () => {
    // Ветвь, которая работает в КАЖДОМ реальном браузере и при этом не
    // исполнялась ни одним unit-тестом: seam не передан, значит контроллер
    // обязан взять глобальный matchMedia и уважать системную настройку
    // «уменьшить движение». Раньше её покрывала только браузерная матрица.
    const queries: string[] = [];
    vi.stubGlobal('window', Object.assign(window, {
      matchMedia: (query: string) => {
        queries.push(query);
        return { matches: true, media: query } as MediaQueryList;
      },
    }));
    try {
      const host = makeHost();
      const controller = new MotionController(host, 0, { spring: SPRING });
      controller.hostConnected();
      controller.setTarget(33);
      expect(queries).toContain('(prefers-reduced-motion: reduce)');
      // reduced=true пришёл из окружения ⇒ снап к цели без пружинных кадров.
      expect(controller.value).toBe(33);
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('окружение БЕЗ window (SSR/worker): контроллер строится, reduced-motion = false', () => {
    // Ветвь `typeof window !== 'undefined'` — единственная в ./lit, которую не
    // исполнял ни один тест: вся lit-сьюта идёт под jsdom, где window есть, а
    // под node-окружением контроллер никто не строил. Сценарий не выдуманный:
    // это SSR и worker, ради которых seam и объявлен ленивым.
    vi.stubGlobal('window', undefined);
    const host = makeHost();
    const controller = new MotionController(host, 0, { spring: SPRING });
    controller.hostConnected();
    controller.setTarget(7);
    // Без matchMedia reduced-motion трактуется как false ⇒ идёт обычная
    // пружина, а не мгновенный снап; значение конечно и биндинг жив.
    expect(Number.isFinite(controller.value)).toBe(true);
    expect(host.controllers).toHaveLength(1);
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

describe('#lit: обновление до создания контроллера', () => {
  it('_applyStyle молча выходит, если контроллера ещё нет (и ничего не пишет в стиль)', async () => {
    // ЗАЧЕМ ДЕТЕРМИНИРОВАННО. Эта ветвь исполнялась на Node 22 (дважды за
    // прогон сьюты) и НЕ исполнялась на Node 24 — расхождение зависело от
    // порядка микрозадач Lit относительно connectedCallback, то есть покрытие
    // приходило случайно. Здесь сценарий вызывается напрямую: цикл обновления
    // прошёл раньше, чем connectedCallback успел создать контроллер.
    const { LabMotionSpringElement } = await import('../src/lit/element.js');
    const el = new LabMotionSpringElement();
    el.property = 'opacity';
    expect((el as unknown as { _motion: unknown })._motion).toBeUndefined();

    // updated() — точка входа Lit в _applyStyle; Map пустой: это первый цикл.
    (el as unknown as { updated(changed: Map<string, unknown>): void })
      .updated(new Map());

    // Ни записи в стиль, ни исключения: элемент просто ещё не анимируется.
    expect(el.style.opacity).toBe('');
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
