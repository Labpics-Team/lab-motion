/**
 * test/preact.test.ts — Preact-биндинг (subpath ./preact, S19).
 * Классы: А (жизненный цикл/анимация) + В (reduced-motion характер) + Д.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падают все блоки.
 * Mutation-proof: убрать reduced-ветку → «снап» RED; не подписать onChange →
 * «доезжает» RED; потерять cleanup-эффект → «unmount разрушает MotionValue» RED.
 *
 * Хуки Preact мокаются (vi.mock('preact/hooks')) по образцу test/react.test.ts —
 * jsdom не нужен, виртуальный clock даёт детерминизм.
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

// ─── Мок preact/hooks (минимум: useState/useEffect/useRef без DOM) ───────────

type EffectEntry = { fn: () => (() => void) | void; deps?: unknown[]; cleanup?: () => void };

let states: { val: unknown }[] = [];
let stateIdx = 0;
let effects: EffectEntry[] = [];
let effectIdx = 0;
let refs: { current: unknown }[] = [];
let refIdx = 0;

vi.mock('preact/hooks', () => ({
  useState: (init: unknown) => {
    const idx = stateIdx++;
    if (states[idx] === undefined) {
      states[idx] = { val: typeof init === 'function' ? (init as () => unknown)() : init };
    }
    const cell = states[idx]!;
    const setter = (v: unknown): void => {
      cell.val = typeof v === 'function' ? (v as (p: unknown) => unknown)(cell.val) : v;
    };
    return [cell.val, setter];
  },
  useEffect: (fn: EffectEntry['fn'], deps?: unknown[]) => {
    const idx = effectIdx++;
    const prev = effects[idx];
    const changed =
      prev === undefined ||
      deps === undefined ||
      prev.deps === undefined ||
      deps.length !== prev.deps.length ||
      deps.some((d, i) => !Object.is(d, prev.deps![i]));
    if (changed) {
      prev?.cleanup?.();
      const cleanup = fn();
      effects[idx] = { fn, deps, cleanup: cleanup ?? undefined };
    }
  },
  useRef: (init: unknown) => {
    const idx = refIdx++;
    if (refs[idx] === undefined) refs[idx] = { current: init };
    return refs[idx];
  },
}));

/** «Рендер»: сбрасывает индексы хуков и вызывает компонент-функцию. */
function render<T>(fn: () => T): T {
  stateIdx = 0;
  effectIdx = 0;
  refIdx = 0;
  return fn();
}

function unmountAll(): void {
  for (const e of effects) e.cleanup?.();
  states = [];
  effects = [];
  refs = [];
}

beforeEach(() => {
  states = [];
  effects = [];
  refs = [];
});

afterEach(() => {
  unmountAll();
  delete (globalThis as { window?: unknown }).window;
});

const SPRING = { mass: 1, stiffness: 200, damping: 26 };

describe('preact: useSpring — анимация через мок хуков', () => {
  it('доезжает до цели по виртуальным кадрам (ререндеры двигают значение)', async () => {
    const { useSpring } = await import('../src/preact/index.js');
    const vc = makeVirtualClock();
    let v = render(() => useSpring(0, SPRING, 'instant', vc.requestFrame));
    expect(v).toBe(0);
    v = render(() => useSpring(100, SPRING, 'instant', vc.requestFrame));
    vc.drainAll();
    v = render(() => useSpring(100, SPRING, 'instant', vc.requestFrame));
    expect(Math.abs(v - 100)).toBeLessThan(0.5);
  });

  it('reduced-motion: снап к цели немедленно (характер, не выключение)', async () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const { useSpring } = await import('../src/preact/index.js');
    const vc = makeVirtualClock();
    render(() => useSpring(0, SPRING, 'instant', vc.requestFrame));
    render(() => useSpring(100, SPRING, 'instant', vc.requestFrame)); // эффект снапает
    // ни одного vc.drainAll() — кадры не крутились; третий рендер читает снап
    const v = render(() => useSpring(100, SPRING, 'instant', vc.requestFrame));
    expect(v).toBe(100);
  });
});

describe('preact: useMotionValue', () => {
  it('инстанс стабилен между ререндерами; unmount разрушает его', async () => {
    const { useMotionValue } = await import('../src/preact/index.js');
    const vc = makeVirtualClock();
    const a = render(() => useMotionValue(0, SPRING, vc.requestFrame));
    const b = render(() => useMotionValue(0, SPRING, vc.requestFrame));
    expect(b).toBe(a); // тот же инстанс
    const seen: number[] = [];
    a.onChange((v) => seen.push(v));
    a.setTarget(10);
    vc.drainAll();
    expect(Math.abs(seen[seen.length - 1]! - 10)).toBeLessThan(0.5);
    unmountAll(); // cleanup-эффект обязан вызвать destroy
    a.setTarget(999);
    vc.drainAll();
    expect(Math.abs((seen[seen.length - 1] ?? 0) - 10)).toBeLessThan(0.5);
  });
});

describe('bindings-api-surface-pin: preact', () => {
  it('ровно запиненный набор runtime-экспортов', async () => {
    const preact = await import('../src/preact/index.js');
    expect(Object.keys(preact).sort()).toEqual(['useMotionValue', 'useSpring']);
  });
});
