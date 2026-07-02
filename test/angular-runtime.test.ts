/**
 * test/angular-runtime.test.ts — S38: Angular-биндинг в РЕАЛЬНОМ рантайме.
 *
 * Настоящий @angular/core injection-context (Injector.create +
 * runInInjectionContext + DestroyRef) — БЕЗ zone.js / TestBed /
 * platform-browser (Angular Signals зононезависимы, `inject`/
 * `assertInInjectionContext` работают на голом ядре). node-env, ноль DOM.
 * Закрывает класс «angular-склейка сломана в живом injection-context»
 * (реальный inject(DestroyRef), signal.set по onChange, NG0203 вне контекста).
 * Клок инжектируется → детерминизм.
 */

import { describe, expect, it } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { injectSpring, injectMotionValue } from '../src/angular/index.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return 1; },
    drain(max = 2000): void { let n = 0; while (q.length > 0 && n++ < max) q.shift()!(); },
    pending: () => q.length,
  };
}

/**
 * Живой injection-scope на РЕАЛЬНОМ Angular-инжекторе (без TestBed/zone).
 * `Injector.create()` возвращает разрушаемый R3Injector: его `.destroy()`
 * запускает настоящий DestroyRef.onDestroy — тот самый lifecycle, что в
 * компоненте/директиве Angular. Мок DestroyRef не подходит: `inject(DestroyRef)`
 * резолвит контекстный DestroyRef инжектора, а не useValue-провайдер.
 */
function makeScope() {
  const injector = Injector.create({ providers: [] }) as Injector & { destroy(): void };
  return {
    run<T>(fn: () => T): T {
      return runInInjectionContext(injector, fn);
    },
    destroy(): void {
      injector.destroy();
    },
  };
}

describe('Angular-биндинг в реальном injection-context', () => {
  it('injectSpring: signal анимируется к цели через клок', () => {
    const clock = makeClock();
    const scope = makeScope();
    const [value, setTarget] = scope.run(() => injectSpring(0, SPRING, 'instant', clock.requestFrame));
    expect(value()).toBe(0);

    setTarget(100);
    clock.drain();

    const v = value();
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(100);
    expect(Number.isFinite(v)).toBe(true);
    scope.destroy();
  });

  it('injectSpring settled: signal сходится к цели', () => {
    const clock = makeClock();
    const scope = makeScope();
    const [value, setTarget] = scope.run(() => injectSpring(0, SPRING, 'instant', clock.requestFrame));
    setTarget(50);
    clock.drain();
    expect(value()).toBeCloseTo(50, 1);
    scope.destroy();
  });

  it('DestroyRef.onDestroy вызывает destroy: цикл остановлен, эмиссий после нет', () => {
    // Сильный оракул (зеркало react/preact/vue/solid): свой onChange-счётчик;
    // injectMotionValue регистрирует DestroyRef.onDestroy(→mv.destroy()).
    // Срабатывание DestroyRef → destroy → listeners.clear → повторный setTarget
    // без эмиссий. Диверсия «убрать destroy» → цикл жив → эмиссии → краснеет.
    const clock = makeClock();
    const scope = makeScope();
    const mv = scope.run(() => injectMotionValue(0, SPRING, clock.requestFrame));

    let emits = 0;
    const off = mv.onChange(() => { emits += 1; });
    mv.setTarget(100);
    clock.drain();
    const before = emits;
    expect(before).toBeGreaterThan(1);

    scope.destroy(); // DestroyRef → mv.destroy()

    mv.setTarget(0);
    clock.drain();
    expect(emits).toBe(before);
    off();
  });

  it('вне injection-context injectSpring бросает (assertInInjectionContext, NG0203)', () => {
    // Честный контракт: вызов вне контекста — явная ошибка, не тихая утечка.
    expect(() => injectSpring(0, SPRING)).toThrow();
    expect(() => injectMotionValue(0, SPRING)).toThrow();
  });

  it('injectSpring: не-конечный target бросает MotionParamError-контракт ядра', () => {
    const clock = makeClock();
    const scope = makeScope();
    const [, setTarget] = scope.run(() => injectSpring(0, SPRING, 'instant', clock.requestFrame));
    // node: reduced=false → mv.setTarget валидирует конечность в ядре.
    expect(() => setTarget(Infinity)).toThrow();
    expect(() => setTarget(NaN)).toThrow();
    scope.destroy();
  });
});
