// @vitest-environment jsdom
/**
 * test/preact-runtime.test.ts — S35: интеграция preact-биндинга в РЕАЛЬНОМ рантайме.
 *
 * Настоящий Preact (render + preact/test-utils act + jsdom): реальные
 * preact/hooks, реальный ре-рендер по onChange, реальный teardown по unmount
 * (render(null, container)). Зеркало react-runtime — доказывает, что hook-склейка
 * работает и на Preact-реактивности, не только на react-dom.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render, h } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { useSpring, useMotionValue } from '../src/preact/index.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return 1; },
    drain(maxFrames = 2000): void {
      let n = 0;
      while (q.length > 0 && n++ < maxFrames) {
        const cb = q.shift()!;
        cb();
      }
    },
    pending: () => q.length,
  };
}

let containers: HTMLElement[] = [];
function mount(vnode: ReturnType<typeof h>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(vnode, container));
  containers.push(container);
  return container;
}
afterEach(() => {
  for (const c of containers) {
    act(() => render(null, c)); // teardown
    c.remove();
  }
  containers = [];
});

describe('preact-биндинг в реальном Preact-рантайме', () => {
  it('useSpring: живой ре-рендер обновляет DOM при setTarget через клок', () => {
    const clock = makeClock();
    let setTarget!: (n: number) => void;
    function Box() {
      const [t, setT] = useState(0);
      setTarget = setT;
      const x = useSpring(t, SPRING, 'instant', clock.requestFrame);
      return h('div', { id: 'box' }, x.toFixed(2));
    }
    const c = mount(h(Box, {}));
    const box = () => c.querySelector('#box')!.textContent!;

    expect(Number(box())).toBe(0);
    act(() => setTarget(100));
    act(() => clock.drain());

    const v = Number(box());
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(100);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('useSpring settled: сходится к цели после полного прогона', () => {
    const clock = makeClock();
    let setTarget!: (n: number) => void;
    function Box() {
      const [t, setT] = useState(0);
      setTarget = setT;
      const x = useSpring(t, SPRING, 'instant', clock.requestFrame);
      return h('div', { id: 'box' }, x.toFixed(4));
    }
    const c = mount(h(Box, {}));
    act(() => setTarget(50));
    act(() => clock.drain());
    expect(Number(c.querySelector('#box')!.textContent)).toBeCloseTo(50, 1);
  });

  it('unmount (render null) вызывает destroy: цикл остановлен, эмиссий после нет', () => {
    // Сильный оракул (нота QA): свой onChange-счётчик; после teardown destroy()
    // очищает listeners → повторный setTarget+прогон не даёт эмиссий. Диверсия
    // «убрать destroy» → цикл жив → эмиссии → краснеет.
    const clock = makeClock();
    let mv!: ReturnType<typeof useMotionValue>;
    function Box() {
      mv = useMotionValue(0, SPRING, clock.requestFrame);
      return h('div', { id: 'box' }, 'x');
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() => render(h(Box, {}), container));

    let emits = 0;
    const off = mv.onChange(() => { emits += 1; });
    act(() => { mv.setTarget(100); clock.drain(); });
    const before = emits;
    expect(before).toBeGreaterThan(1);

    act(() => render(null, container)); // teardown → cleanup → mv.destroy()

    act(() => { mv.setTarget(0); clock.drain(); });
    expect(emits).toBe(before); // destroy погасил цикл
    expect(() => act(() => clock.drain())).not.toThrow();
    off();
    container.remove();
  });

  it('useMotionValue: стабильный инстанс между рендерами', () => {
    const clock = makeClock();
    let force!: (n: number) => void;
    const instances: unknown[] = [];
    function Box() {
      const [, setN] = useState(0);
      force = setN;
      const mv = useMotionValue(0, SPRING, clock.requestFrame);
      instances.push(mv);
      return h('div', {}, 'x');
    }
    mount(h(Box, {}));
    act(() => force(1));
    act(() => force(2));
    expect(instances.length).toBeGreaterThanOrEqual(3);
    expect(instances.every((i) => i === instances[0])).toBe(true);
  });
});
