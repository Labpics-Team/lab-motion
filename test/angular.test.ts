/**
 * test/angular.test.ts — Angular-биндинг (subpath ./angular, S19).
 * Классы: А (жизненный цикл/анимация) + В (reduced-характер, NaN-гард,
 * NG0203-контракт) + Д.
 *
 * ── RED-PROOF ЧЕРЕЗ MUTATION ─────────────────────────────────────────────────
 * Реализация писалась параллельно тестам — зубастость каждого блока
 * доказывается mutation-прогоном координатора (reduced-ветка, onChange,
 * DestroyRef-уборка, NaN-гард, assertInInjectionContext).
 *
 * @angular/core мокается минимально-честно (по образцу preact-мока): signal —
 * вызываемый геттер с set/asReadonly; inject(DestroyRef) — реестр колбэков;
 * assertInInjectionContext бросает вне контекста (семантика NG0203).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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

// ─── Мок @angular/core (signal/inject/DestroyRef/assertInInjectionContext) ───

let inContext = false;
let destroyCallbacks: Array<() => void> = [];

vi.mock('@angular/core', () => {
  class DestroyRef {}
  return {
    DestroyRef,
    assertInInjectionContext: (fn: { name?: string }) => {
      if (!inContext) {
        throw new Error(`NG0203: ${fn.name ?? 'fn'} вызван вне injection context`);
      }
    },
    inject: (token: unknown) => {
      if (!inContext) throw new Error('NG0203: inject вне контекста');
      if (token === DestroyRef) {
        return {
          onDestroy(cb: () => void) {
            destroyCallbacks.push(cb);
            return () => {};
          },
        };
      }
      throw new Error('мок inject: неизвестный токен');
    },
    signal: (initial: unknown) => {
      let value = initial;
      const read = (() => value) as (() => unknown) & {
        set(v: unknown): void;
        asReadonly(): () => unknown;
      };
      read.set = (v: unknown) => {
        value = v;
      };
      read.asReadonly = () => () => value;
      return read;
    },
  };
});

/** Выполнить фабрику «в injection context» и вернуть результат. */
function runInContext<T>(fn: () => T): T {
  inContext = true;
  try {
    return fn();
  } finally {
    inContext = false;
  }
}

function destroyScope(): void {
  for (const cb of destroyCallbacks) cb();
  destroyCallbacks = [];
}

beforeEach(() => {
  destroyCallbacks = [];
  inContext = false;
});

afterEach(() => {
  destroyScope();
  delete (globalThis as { window?: unknown }).window;
});

const SPRING = { mass: 1, stiffness: 200, damping: 26 };

describe('angular: injectSpring', () => {
  it('вне injection context → NG0203 с именем ИМЕННО injectSpring (не вложенного примитива)', async () => {
    const { injectSpring } = await import('../src/angular/index.js');
    // Точное имя в сообщении — контракт assertInInjectionContext(fn):
    // потребитель должен видеть СВОЙ вызов, а не внутренности биндинга.
    expect(() => injectSpring(0)).toThrow(/NG0203.*injectSpring/);
  });

  it('доезжает до цели по виртуальным кадрам; сигнал читается вызовом', async () => {
    const { injectSpring } = await import('../src/angular/index.js');
    const vc = makeVirtualClock();
    const [x, setX] = runInContext(() => injectSpring(0, SPRING, 'instant', vc.requestFrame));
    expect(x()).toBe(0);
    setX(100);
    vc.drainAll();
    expect(Math.abs((x() as number) - 100)).toBeLessThan(0.5);
  });

  it('full-motion: значение проходит через полёт (не мгновенный снап)', async () => {
    const { injectSpring } = await import('../src/angular/index.js');
    const vc = makeVirtualClock();
    const [x, setX] = runInContext(() => injectSpring(0, SPRING, 'instant', vc.requestFrame));
    setX(100);
    vc.drainAll(5);
    expect(x() as number).toBeGreaterThan(0);
    expect(x() as number).toBeLessThan(99);
  });

  it('уборка через DestroyRef: после разрушения скоупа setTarget — no-op', async () => {
    const { injectSpring } = await import('../src/angular/index.js');
    const vc = makeVirtualClock();
    const [x, setX] = runInContext(() => injectSpring(0, SPRING, 'instant', vc.requestFrame));
    destroyScope();
    setX(100);
    vc.drainAll();
    expect(x()).toBe(0);
  });

  it('reduced-motion: снап синхронно; non-finite → MotionParamError, сигнал чист', async () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const { injectSpring } = await import('../src/angular/index.js');
    const vc = makeVirtualClock();
    const [x, setX] = runInContext(() => injectSpring(0, SPRING, 'instant', vc.requestFrame));
    setX(100);
    expect(x()).toBe(100); // без кадров
    expect(() => setX(NaN)).toThrow();
    expect(() => setX(Infinity)).toThrow();
    expect(x()).toBe(100); // не загрязнён
  });

  it('дефолтный spring исполняется: доезжает без явных параметров', async () => {
    const { injectSpring } = await import('../src/angular/index.js');
    const vc = makeVirtualClock();
    const [x, setX] = runInContext(() => injectSpring(0, undefined, 'instant', vc.requestFrame));
    setX(100);
    vc.drainAll();
    expect(Math.abs((x() as number) - 100)).toBeLessThan(0.5);
  });
});

describe('angular: injectMotionValue', () => {
  it('вне контекста → NG0203; в контексте — живой MotionValue, разрушаемый DestroyRef', async () => {
    const { injectMotionValue } = await import('../src/angular/index.js');
    expect(() => injectMotionValue(0)).toThrow(/NG0203/);
    const vc = makeVirtualClock();
    const mv = runInContext(() => injectMotionValue(0, SPRING, vc.requestFrame));
    const seen: number[] = [];
    mv.onChange((v) => seen.push(v));
    mv.setTarget(10);
    vc.drainAll();
    expect(Math.abs(seen[seen.length - 1]! - 10)).toBeLessThan(0.5);
    destroyScope();
    mv.setTarget(999); // разрушен — no-op
    vc.drainAll();
    expect(Math.abs(seen[seen.length - 1]! - 10)).toBeLessThan(0.5);
  });
});

describe('bindings-api-surface-pin: angular', () => {
  it('ровно запиненный набор runtime-экспортов', async () => {
    const angular = await import('../src/angular/index.js');
    expect(Object.keys(angular).sort()).toEqual(['injectMotionValue', 'injectSpring']);
  });
});
