/**
 * test/solid-runtime.test.ts — S37: Solid-биндинг в РЕАЛЬНОМ рантайме.
 *
 * Настоящая реактивность solid-js (createRoot + createSignal + onCleanup) —
 * БЕЗ babel-preset-solid и БЕЗ jsdom: биндинг на чистых сигналах, не на JSX/DOM.
 * createRoot даёт живой owner → onCleanup реально регистрируется и срабатывает
 * на dispose. Закрывает класс «solid-склейка сломана в живом рантайме»
 * (реактивный сигнал обновляется по onChange, owner-cleanup вызывает destroy,
 * ownerless-путь работает вручную). Клок инжектируется → детерминизм.
 */

import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { createSpring, createMotionValue } from '../src/solid/index.js';
import { MotionParamError } from '../src/errors.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return 1; },
    drain(max = 2000): void { let n = 0; while (q.length > 0 && n++ < max) q.shift()!(); },
    pending: () => q.length,
  };
}

describe('Solid-биндинг в реальном solid-js рантайме', () => {
  it('createSpring: сигнал value() анимируется к цели через клок', () => {
    const clock = makeClock();
    createRoot((dispose) => {
      const [value, setTarget] = createSpring(0, SPRING, 'instant', clock.requestFrame);
      expect(value()).toBe(0); // старт на initial

      setTarget(100);
      clock.drain();

      const v = value();
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(100);
      expect(Number.isFinite(v)).toBe(true);
      dispose();
    });
  });

  it('createSpring settled: сигнал сходится к цели после полного прогона', () => {
    const clock = makeClock();
    createRoot((dispose) => {
      const [value, setTarget] = createSpring(0, SPRING, 'instant', clock.requestFrame);
      setTarget(50);
      clock.drain();
      expect(value()).toBeCloseTo(50, 1);
      dispose();
    });
  });

  it('dispose owner вызывает destroy: цикл остановлен, эмиссий после нет', () => {
    // Сильный оракул (зеркало react/preact/vue): свой onChange-счётчик на mv;
    // createMotionValue регистрирует onCleanup(dispose→mv.destroy()) при owner'е.
    // dispose корня → destroy → listeners.clear → повторный setTarget без эмиссий.
    const clock = makeClock();
    let mv!: ReturnType<typeof createMotionValue>[0];
    let disposeRoot!: () => void;
    createRoot((dispose) => {
      disposeRoot = dispose;
      const [m] = createMotionValue(0, SPRING, clock.requestFrame);
      mv = m;
    });

    let emits = 0;
    const off = mv.onChange(() => { emits += 1; });
    mv.setTarget(100);
    clock.drain();
    const before = emits;
    expect(before).toBeGreaterThan(1);

    disposeRoot(); // owner cleanup → mv.destroy()

    mv.setTarget(0);
    clock.drain();
    expect(emits).toBe(before); // destroy погасил цикл
    off();
  });

  it('ownerless createSpring (без createRoot): работает + ручной destroy', () => {
    // getOwner()===null → onCleanup не регистрируется; уборка через явный destroy.
    const clock = makeClock();
    const [value, setTarget, destroy] = createSpring(0, SPRING, 'instant', clock.requestFrame);
    setTarget(100);
    clock.drain();
    expect(value()).toBeGreaterThan(0); // анимируется и вне реактивного корня

    destroy(); // ручная уборка
    const settled = value();
    setTarget(0); // после destroy — no-op (destroyed-флаг)
    clock.drain();
    expect(value()).toBe(settled); // значение не сдвинулось после destroy
  });

  it('createSpring: не-конечный target бросает MotionParamError (CSS-safe контракт)', () => {
    // В node (нет window.matchMedia) reduced=false → активен обычный путь
    // mv.setTarget, который валидирует конечность в ядре. Reduced-снап-путь
    // (setValue в обход ядра со своей валидацией) здесь НЕ достигается — он
    // покрыт отдельно в test/solid.test.ts (там matchMedia замокан matches:true).
    const [, setTarget, destroy] = createSpring(0, SPRING, 'instant', makeClock().requestFrame);
    expect(() => setTarget(Infinity)).toThrow(MotionParamError);
    expect(() => setTarget(NaN)).toThrow(MotionParamError);
    destroy();
  });
});
