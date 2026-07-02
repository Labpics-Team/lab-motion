// @vitest-environment jsdom
/**
 * test/react-runtime.test.ts — S35: интеграция react-биндинга в РЕАЛЬНОМ рантайме.
 *
 * Прежде react-биндинг проверялся только через MotionValue + инжектированный
 * клок (unit). Здесь — настоящий React 18 (createRoot + act + jsdom): реальные
 * хуки useState/useEffect/useRef, реальный ре-рендер по onChange, реальный
 * teardown по unmount. Закрывает класс «хук-склейка сломана в живом React»
 * (правила хуков, реактивность setState, cleanup-эффект), который моки не видят.
 *
 * Клок инжектируется → детерминизм (инвариант движка) сохранён в live-рантайме.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSpring, useMotionValue } from '../src/react/index.js';

// React 18 требует этот флаг для act() вне test-renderer.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

/** Инжектируемая rAF-очередь: контролируем кадры вручную (детерминизм). */
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

let mounted: Array<{ root: Root; container: HTMLElement }> = [];
function mount(el: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  mounted.push({ root, container });
  return container;
}
afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
});

describe('react-биндинг в реальном React-рантайме', () => {
  it('useSpring: живой ре-рендер обновляет DOM при setTarget через клок', () => {
    const clock = makeClock();
    let setTarget!: Dispatch<SetStateAction<number>>;
    function Box(): ReturnType<typeof createElement> {
      const [t, setT] = useState(0);
      setTarget = setT;
      const x = useSpring(t, SPRING, 'instant', clock.requestFrame);
      return createElement('div', { id: 'box' }, x.toFixed(2));
    }
    const c = mount(createElement(Box));
    const box = () => c.querySelector('#box')!.textContent!;

    expect(Number(box())).toBe(0); // первый рендер: старт на target

    act(() => setTarget(100)); // меняем цель → пружина стартует
    act(() => clock.drain()); // прогоняем кадры (onChange→setState в act)

    const v = Number(box());
    expect(v).toBeGreaterThan(0); // реально анимировалось к 100
    expect(v).toBeLessThanOrEqual(100);
    expect(Number.isFinite(v)).toBe(true); // CSS-safe в живом DOM
  });

  it('useSpring settled: значение сходится к цели после полного прогона', () => {
    const clock = makeClock();
    let setTarget!: Dispatch<SetStateAction<number>>;
    function Box(): ReturnType<typeof createElement> {
      const [t, setT] = useState(0);
      setTarget = setT;
      const x = useSpring(t, SPRING, 'instant', clock.requestFrame);
      return createElement('div', { id: 'box' }, x.toFixed(4));
    }
    const c = mount(createElement(Box));
    act(() => setTarget(50));
    act(() => clock.drain());
    expect(Number(c.querySelector('#box')!.textContent)).toBeCloseTo(50, 1);
  });

  it('unmount вызывает destroy: цикл MotionValue остановлен, эмиссий после нет', () => {
    // Сильный оракул (нота QA): не «не бросает», а ПРЯМОЕ негативное покрытие
    // класса «утечка ресурса» — свой onChange-счётчик на инстансе; после unmount
    // destroy() очищает listeners и глушит цикл → повторный setTarget+прогон НЕ
    // даёт новых эмиссий. Диверсия «убрать destroy» → листенер жив, цикл гоняет
    // → эмиссии есть → тест краснеет.
    const clock = makeClock();
    let mv!: ReturnType<typeof useMotionValue>;
    function Box(): ReturnType<typeof createElement> {
      mv = useMotionValue(0, SPRING, clock.requestFrame);
      return createElement('div', { id: 'box' }, 'x');
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Box)));

    let emits = 0;
    const off = mv.onChange(() => { emits += 1; }); // immediate-emit → emits=1
    act(() => { mv.setTarget(100); clock.drain(); }); // живая анимация
    const before = emits;
    expect(before).toBeGreaterThan(1); // эмиссии реально шли

    act(() => root.unmount()); // teardown → cleanup-эффект → mv.destroy()

    act(() => { mv.setTarget(0); clock.drain(); }); // проба: жив ли цикл?
    expect(emits).toBe(before); // destroy погасил — ноль новых эмиссий к листенеру
    expect(() => act(() => clock.drain())).not.toThrow(); // и не бросает
    off();
    container.remove();
  });

  it('useMotionValue: стабильный инстанс между рендерами (useRef-кэш)', () => {
    const clock = makeClock();
    let force!: Dispatch<SetStateAction<number>>;
    const instances: unknown[] = [];
    function Box(): ReturnType<typeof createElement> {
      const [, setN] = useState(0);
      force = setN;
      const mv = useMotionValue(0, SPRING, clock.requestFrame);
      instances.push(mv);
      return createElement('div', null, 'x');
    }
    mount(createElement(Box));
    act(() => force((n) => n + 1)); // ре-рендер
    act(() => force((n) => n + 1));
    // MotionValue создаётся ОДИН раз и переживает ре-рендеры (не пересоздаётся).
    expect(instances.length).toBeGreaterThanOrEqual(3);
    expect(instances.every((i) => i === instances[0])).toBe(true);
  });
});
