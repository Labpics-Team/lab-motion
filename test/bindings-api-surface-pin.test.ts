/**
 * test/bindings-api-surface-pin.test.ts
 * Класс: А/Б — гвоздь контракта публичной поверхности биндингов
 * react / svelte / vue (в обе стороны: пропавший И лишний экспорт — RED).
 *
 * Закрывает долг README PR #26: пины были у математических субпутей и lit,
 * но не у трёх старых биндингов.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Удалить любой экспорт → «missing»-ассерты RED.
 * Добавить новый экспорт без пина → exhaustive Object.keys RED.
 */

import { describe, expect, it } from 'vitest';
import * as react from '../src/react/index.js';
import * as svelte from '../src/svelte/index.js';
import * as vue from '../src/vue/index.js';

describe('bindings-api-surface-pin: react', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(react).sort()).toEqual([
      'useMotionStyle',
      'useMotionValue',
      'useReducedMotion',
      'useSpring',
    ]);
  });

  it('все хуки — функции', () => {
    expect(typeof react.useSpring).toBe('function');
    expect(typeof react.useMotionValue).toBe('function');
    expect(typeof react.useMotionStyle).toBe('function');
    expect(typeof react.useReducedMotion).toBe('function');
  });
});

describe('bindings-api-surface-pin: svelte', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(svelte).sort()).toEqual(['springStore']);
  });

  it('springStore — функция', () => {
    expect(typeof svelte.springStore).toBe('function');
  });
});

describe('bindings-api-surface-pin: vue', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(vue).sort()).toEqual(['useMotionValue', 'useSpring', 'vMotion']);
  });

  it('хуки — функции; vMotion — объект-директива с lifecycle-хуками', () => {
    expect(typeof vue.useSpring).toBe('function');
    expect(typeof vue.useMotionValue).toBe('function');
    expect(typeof vue.vMotion).toBe('object');
    expect(typeof (vue.vMotion as { mounted?: unknown }).mounted).toBe('function');
  });
});

describe('bindings-api-surface-pin: SSR', () => {
  // vitest environment=node: сам факт import * вверху файла без падения =
  // доказательство отсутствия DOM-обращений на верхнем уровне модулей.
  it('модули импортируются в node env (нет top-level DOM)', () => {
    expect(react).toBeTruthy();
    expect(svelte).toBeTruthy();
    expect(vue).toBeTruthy();
  });
});
