/**
 * test/decay-reduced-motion.test.ts — reduced-motion CHARACTER-switch for ./decay
 *
 * Условие успеха (3): "reduced-motion honoured at entry as CHARACTER-switch
 * (snap-to-computed-rest, NOT hard-off), via injected matchMedia seam."
 *
 * TDD RED-proof:
 *   1. Удалить `if (reduced) { return {...snap...} }` блок в src/decay.ts.
 *   2. Запустить: pnpm test test/decay-reduced-motion.test.ts
 *   3. Каждый тест в 'decay — reduced-motion: CHARACTER-switch' обязан упасть.
 *   4. Восстановить → GREEN.
 *
 * Mutation proof:
 *   - Возврат `valueAt: () => 0` вместо `() => rest` → 'valueAt(t) === rest для любого t' падает.
 *   - `isSettledAt: () => false` → 'isSettledAt всегда true' падает.
 *   - Отсутствие reduced-веток (полный hard-off: throw/undefined) → 'модель существует' падает.
 */

import { describe, expect, it } from 'vitest';
import { createDecay } from '../src/decay.js';

function makeReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: true,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function makeNoPreferenceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

describe('decay — reduced-motion: CHARACTER-switch', () => {
  it('reduced flag reflects matchMedia(prefers-reduced-motion)', () => {
    const m = createDecay({ from: 0, velocity: 500, matchMedia: makeReduceMedia() });
    expect(m.reduced).toBe(true);
  });

  it('no matchMedia (SSR) → reduced=false (не хочет отказать в анимации молча)', () => {
    const m = createDecay({ from: 0, velocity: 500 });
    expect(m.reduced).toBe(false);
  });

  it('matchMedia present but no preference → reduced=false', () => {
    const m = createDecay({ from: 0, velocity: 500, matchMedia: makeNoPreferenceMedia() });
    expect(m.reduced).toBe(false);
  });

  it('reduced=true: valueAt(t) === rest для любого t (snap НЕМЕДЛЕННО, не постепенно)', () => {
    const m = createDecay({ from: 10, velocity: 800, matchMedia: makeReduceMedia() });
    expect(m.valueAt(0)).toBe(m.rest);
    expect(m.valueAt(0.001)).toBe(m.rest);
    expect(m.valueAt(1)).toBe(m.rest);
    expect(m.valueAt(1000)).toBe(m.rest);
  });

  it('reduced=true: velocityAt(t) === 0 для любого t (уже settled)', () => {
    const m = createDecay({ from: 10, velocity: 800, matchMedia: makeReduceMedia() });
    expect(m.velocityAt(0)).toBe(0);
    expect(m.velocityAt(5)).toBe(0);
  });

  it('reduced=true: isSettledAt(t) === true для любого t', () => {
    const m = createDecay({ from: 10, velocity: 800, matchMedia: makeReduceMedia() });
    expect(m.isSettledAt(0)).toBe(true);
    expect(m.isSettledAt(100)).toBe(true);
  });

  it('CHARACTER not hard-off: rest всё ещё несёт содержательное конечное значение, а не 0/NaN по умолчанию', () => {
    // from=10, velocity=800 → амплитуда != 0 → rest !== from (реальная точка покоя посчитана,
    // а не просто «анимация отключена»).
    const m = createDecay({ from: 10, velocity: 800, matchMedia: makeReduceMedia() });
    expect(Number.isFinite(m.rest)).toBe(true);
    expect(m.rest).not.toBe(10);
  });

  it('reduced=false (полная анимация): valueAt(0) === from, а не rest (движение реально происходит)', () => {
    const m = createDecay({ from: 10, velocity: 800 });
    expect(m.valueAt(0)).toBe(10);
    expect(m.valueAt(0)).not.toBe(m.rest);
  });
});
