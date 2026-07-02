/**
 * test/wc.test.ts — vanilla web-component биндинг (subpath ./wc, S19).
 * Классы: А (жизненный цикл/атрибуты) + В (враждебные атрибуты, reduced) + Д.
 *
 * ── RED-PROOF ЧЕРЕЗ MUTATION ─────────────────────────────────────────────────
 * Реализация писалась параллельно тестам (не до) — зубастость КАЖДОГО блока
 * доказывается mutation-прогоном координатора: NaN-игнор атрибута, снап
 * reduced-ветки, ленивое одно-разовое создание MotionValue, единая точка
 * записи стиля, guard авто-регистрации.
 *
 * Custom elements тестируются без DOM: класс создаётся фабрикой от фейкового
 * базового конструктора, колбэки жизненного цикла зовутся вручную (в браузере
 * это делает платформа).
 */

import { describe, expect, it } from 'vitest';
import * as wc from '../src/wc/index.js';
import {
  LAB_SPRING_TAG,
  createLabSpringElementClass,
  defineLabSpring,
  renderTemplateValue,
  type SpringHostBase,
} from '../src/wc/index.js';

function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handle = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    drainAll(max = 3000): void {
      let i = 0;
      while (queue.length > 0 && i++ < max) {
        const cb = queue.shift()!;
        clock += dtMs;
        cb(clock);
      }
    },
  };
}

class FakeBase implements SpringHostBase {
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
}

const SPRING = { mass: 1, stiffness: 200, damping: 26 };

function makeEl(opts?: { matchMedia?: (q: string) => { matches: boolean } }) {
  const vc = makeVirtualClock();
  const Ctor = createLabSpringElementClass(FakeBase);
  const el = new Ctor();
  el.spring = SPRING;
  el.requestFrame = vc.requestFrame;
  if (opts?.matchMedia) el.matchMedia = opts.matchMedia;
  return { el, vc };
}

describe('wc: <lab-spring> — жизненный цикл и анимация', () => {
  it('connectedCallback применяет initial к стилю (property/template по умолчанию)', () => {
    const { el } = makeEl();
    el.connectedCallback();
    expect(el.style['opacity']).toBe('0');
  });

  it('смена атрибута target анимирует до цели по кадрам', () => {
    const { el, vc } = makeEl();
    el.connectedCallback();
    el.attributeChangedCallback('target', null, '1');
    vc.drainAll();
    expect(Math.abs(Number(el.style['opacity']) - 1)).toBeLessThan(0.01);
  });

  it('property/template из атрибутов: transform-шаблон с повторным {v}', () => {
    const { el, vc } = makeEl();
    el.attributeChangedCallback('property', null, 'transform');
    el.attributeChangedCallback('template', null, 'translate({v}px, {v}px)');
    el.connectedCallback();
    el.attributeChangedCallback('target', null, '10');
    vc.drainAll();
    expect(el.style['transform']).toMatch(/^translate\(10(\.\d+)?px, 10(\.\d+)?px\)$/);
  });

  it('MotionValue создаётся РОВНО один раз: reconnect не пересоздаёт (значение живёт)', () => {
    const { el, vc } = makeEl();
    el.connectedCallback();
    el.attributeChangedCallback('target', null, '1');
    vc.drainAll();
    el.connectedCallback(); // reconnect
    el.attributeChangedCallback('target', null, '0.5');
    vc.drainAll();
    expect(Math.abs(Number(el.style['opacity']) - 0.5)).toBeLessThan(0.01);
  });

  it('reconnect MID-FLIGHT: стиль продолжает с текущего значения, не прыгает в target', () => {
    // Пересозданный MotionValue стартовал бы заново с initial=target —
    // стиль мгновенно оказался бы на цели. Живой продолжает полёт.
    const { el, vc } = makeEl();
    el.connectedCallback();
    el.attributeChangedCallback('target', null, '1');
    vc.drainAll(3); // частично — до цели далеко
    el.connectedCallback(); // reconnect в полёте
    const v = Number(el.style['opacity']);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.9);
    vc.drainAll();
    expect(Math.abs(Number(el.style['opacity']) - 1)).toBeLessThan(0.01);
  });

  it('target-атрибут до connectedCallback применяется при подключении', () => {
    const { el } = makeEl();
    el.attributeChangedCallback('target', null, '0.7');
    el.connectedCallback();
    expect(el.style['opacity']).toBe('0.7');
  });
});

describe('wc: враждебные входы и reduced-motion', () => {
  it('observedAttributes запинен: контракт с платформой (браузер диспетчит только их)', () => {
    const Ctor = createLabSpringElementClass(FakeBase) as unknown as {
      observedAttributes: string[];
    };
    expect(Ctor.observedAttributes).toEqual(['target', 'property', 'template']);
  });

  it('бросающий matchMedia не роняет колбэк: catch → full-motion', () => {
    const { el, vc } = makeEl({
      matchMedia: () => {
        throw new Error('legacy среда');
      },
    });
    el.connectedCallback();
    expect(() => el.attributeChangedCallback('target', null, '1')).not.toThrow();
    vc.drainAll(); // пошёл обычный пружинный путь
    expect(Math.abs(Number(el.style['opacity']) - 1)).toBeLessThan(0.01);
  });

  it('невалидный target-атрибут игнорируется (HTML-конвенция, без броска)', () => {
    const { el, vc } = makeEl();
    el.connectedCallback();
    for (const bad of ['мусор', 'NaN', 'Infinity', '']) {
      expect(() => el.attributeChangedCallback('target', null, bad)).not.toThrow();
    }
    vc.drainAll();
    expect(el.style['opacity']).toBe('0'); // стиль не тронут мусором
  });

  it('reduced-motion: смена target снапает стиль синхронно, без кадров', () => {
    const { el } = makeEl({ matchMedia: () => ({ matches: true }) });
    el.connectedCallback();
    el.attributeChangedCallback('target', null, '1');
    expect(el.style['opacity']).toBe('1'); // ни одного drainAll
  });
});

describe('wc: defineLabSpring — регистрация', () => {
  it('инжектированный реестр: define зовётся один раз, повтор — no-op', () => {
    const defined: string[] = [];
    const registry = {
      store: new Map<string, unknown>(),
      get(name: string) {
        return this.store.get(name);
      },
      define(name: string, ctor: unknown) {
        defined.push(name);
        this.store.set(name, ctor);
      },
    };
    const first = defineLabSpring(registry as never, FakeBase);
    const second = defineLabSpring(registry as never, FakeBase);
    expect(first).toBeTypeOf('function');
    expect(second).toBeUndefined();
    expect(defined).toEqual([LAB_SPRING_TAG]);
  });

  it('SSR: без среды — тихий no-op (модуль уже импортирован без падения)', () => {
    expect(defineLabSpring()).toBeUndefined(); // в node нет customElements
  });
});

describe('wc: renderTemplateValue (общий с ./lit источник)', () => {
  it('заменяет все вхождения {v}; без плейсхолдера — голое число', () => {
    expect(renderTemplateValue('translate({v}px, {v}px)', 5)).toBe('translate(5px, 5px)');
    expect(renderTemplateValue('нет плейсхолдера', 3)).toBe('3');
  });
});

describe('bindings-api-surface-pin: wc', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(wc).sort()).toEqual([
      'LAB_SPRING_TAG',
      'createLabSpringElementClass',
      'defineLabSpring',
      'renderTemplateValue',
    ]);
  });
});
