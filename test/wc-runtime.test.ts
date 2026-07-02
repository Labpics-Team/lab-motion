// @vitest-environment jsdom
/**
 * test/wc-runtime.test.ts — S36: web-component биндинг в РЕАЛЬНОМ рантайме.
 *
 * Настоящий customElements + HTMLElement (jsdom): connectedCallback,
 * attributeChangedCallback, реальная запись в el.style. Vanilla custom element,
 * без компилятора — чистая DOM-семантика. Закрывает класс «WC-склейка сломана
 * в живом DOM» (lifecycle-колбэки, парсинг атрибутов, запись стиля), невидимый
 * unit-тестам с моками. Клок инжектируется → детерминизм.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLabSpringElementClass, type LabSpringHost } from '../src/wc/index.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return 1; },
    drain(max = 2000): void { let n = 0; while (q.length > 0 && n++ < max) q.shift()!(); },
    pending: () => q.length,
  };
}

// Уникальный тег на каждый тест-файл: повторная customElements.define бросает.
const TAG = 'lab-spring-rt-test';
let Klass: new () => HTMLElement & LabSpringHost;
beforeEach(() => {
  if (!customElements.get(TAG)) {
    Klass = createLabSpringElementClass(HTMLElement as unknown as new () => LabSpringHost) as unknown as new () => HTMLElement & LabSpringHost;
    customElements.define(TAG, Klass as unknown as CustomElementConstructor);
  }
});

let els: HTMLElement[] = [];
function make(): HTMLElement & LabSpringHost {
  const el = document.createElement(TAG) as HTMLElement & LabSpringHost;
  els.push(el);
  return el;
}
afterEach(() => { for (const el of els) el.remove(); els = []; });

describe('web-component биндинг в реальном customElements-рантайме', () => {
  it('setAttribute(target) анимирует el.style через connectedCallback+клок', () => {
    const clock = makeClock();
    const el = make();
    el.requestFrame = clock.requestFrame;
    el.spring = SPRING;
    el.property = 'opacity';
    document.body.appendChild(el); // connectedCallback → createBoundValue(initial=0)

    expect(el.style.opacity).toBe('0'); // старт

    el.setAttribute('target', '1'); // attributeChangedCallback → mv.setTarget(1)
    clock.drain();

    const v = Number(el.style.opacity);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('template применяется: transform translateX({v}px)', () => {
    const clock = makeClock();
    const el = make();
    el.requestFrame = clock.requestFrame;
    el.spring = SPRING;
    el.property = 'transform';
    el.template = 'translateX({v}px)';
    document.body.appendChild(el);
    el.setAttribute('target', '50');
    clock.drain();
    expect(el.style.transform).toMatch(/^translateX\([\d.]+px\)$/);
    const px = Number(el.style.transform.match(/([\d.]+)/)![1]);
    expect(px).toBeGreaterThan(0);
    expect(px).toBeCloseTo(50, 0);
  });

  it('невалидный target-атрибут (враждебная строка) игнорируется, без NaN в стиле', () => {
    const clock = makeClock();
    const el = make();
    el.requestFrame = clock.requestFrame;
    el.spring = SPRING;
    document.body.appendChild(el);
    el.setAttribute('target', 'not-a-number'); // Number(...)=NaN → игнор
    clock.drain();
    expect(el.style.opacity).toBe('0'); // не сдвинулось, не 'NaN'
  });

  it('reconnect сохраняет живой MotionValue (не пересоздаёт, ТЕКУЩЕЕ значение)', () => {
    const clock = makeClock();
    const el = make();
    el.requestFrame = clock.requestFrame;
    el.spring = SPRING;
    document.body.appendChild(el);
    el.setAttribute('target', '1');
    for (let i = 0; i < 3 && clock.pending() > 0; i++) clock.drain(1);
    const mid = Number(el.style.opacity);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    el.remove(); // disconnect
    document.body.appendChild(el); // reconnect → connectedCallback применяет ТЕКУЩЕЕ, не 0
    expect(Number(el.style.opacity)).toBeCloseTo(mid, 5); // не сброс в 0
  });
});
