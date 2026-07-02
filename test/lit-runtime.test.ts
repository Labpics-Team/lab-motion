// @vitest-environment jsdom
/**
 * test/lit-runtime.test.ts — S36: Lit-биндинг в РЕАЛЬНОМ рантайме.
 *
 * Настоящий LitElement + reactive-update-цикл (jsdom): connectedCallback
 * создаёт MotionController, тот подписан на onChange→host.requestUpdate(),
 * updated() пишет el.style. Кадр → onChange → requestUpdate → (async) updated →
 * _applyStyle. Тест флашит Lit-цикл (updateComplete). Закрывает класс
 * «Lit-склейка сломана в живом рантайме» (ReactiveController lifecycle,
 * requestUpdate-коалесценция, запись стиля). Клок инжектируется → детерминизм.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { LabMotionSpringElement, LAB_MOTION_SPRING_TAG } from '../src/lit/index.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return 1; },
    drain(max = 2000): void { let n = 0; while (q.length > 0 && n++ < max) q.shift()!(); },
    pending: () => q.length,
  };
}

let els: LabMotionSpringElement[] = [];
function make(): LabMotionSpringElement {
  const el = document.createElement(LAB_MOTION_SPRING_TAG) as LabMotionSpringElement;
  els.push(el);
  return el;
}
afterEach(() => { for (const el of els) el.remove(); els = []; });

describe('Lit-биндинг в реальном LitElement-рантайме', () => {
  it('target-property анимирует el.style через ReactiveController+клок', async () => {
    const clock = makeClock();
    const el = make();
    el.requestFrame = clock.requestFrame;
    el.spring = SPRING;
    el.property = 'opacity';
    document.body.appendChild(el); // connectedCallback → MotionController, hostConnected → subscribe
    await el.updateComplete;

    el.target = 1; // reactive prop → updated() → setTarget(1)
    await el.updateComplete;
    clock.drain(); // кадры → onChange → requestUpdate (коалесценция)
    await el.updateComplete; // флаш → updated → _applyStyle финальное значение

    const v = Number(el.style.opacity);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('template: transform translateX({v}px), сходится к цели', async () => {
    const clock = makeClock();
    const el = make();
    el.requestFrame = clock.requestFrame;
    el.spring = SPRING;
    el.property = 'transform';
    el.template = 'translateX({v}px)';
    document.body.appendChild(el);
    await el.updateComplete;
    el.target = 50;
    await el.updateComplete;
    clock.drain();
    await el.updateComplete;
    expect(el.style.transform).toMatch(/^translateX\([\d.]+px\)$/);
    const px = Number(el.style.transform.match(/([\d.]+)/)![1]);
    expect(px).toBeCloseTo(50, 0);
  });

  it('disconnect останавливает пружину (hostDisconnected → нет утечки после)', async () => {
    const clock = makeClock();
    const el = make();
    el.requestFrame = clock.requestFrame;
    el.spring = SPRING;
    document.body.appendChild(el);
    await el.updateComplete;
    el.target = 1;
    await el.updateComplete;
    expect(clock.pending()).toBeGreaterThan(0); // цикл активен

    el.remove(); // disconnectedCallback → hostDisconnected → отписка + стоп

    // Прогон оставшихся кадров после disconnect не должен бросать.
    expect(() => clock.drain()).not.toThrow();
  });
});
