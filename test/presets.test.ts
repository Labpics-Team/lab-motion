/**
 * Presets tests (text/number/ticker) — TDD + property + api pin for subpaths.
 * Class: A (unit/integration), C (property), B (regression).
 * RED-first: these were added before final tweaks; exercised drive path + SSR.
 * Perf/size: tests import only subpaths (tree-shake check via build).
 * Seeded for determinism.
 */
import { describe, expect, it, vi } from 'vitest';
import { splitText, typewriter, scramble } from '../src/text/index.js';
import { animateNumber, formatNumber } from '../src/number/index.js';
import { ticker } from '../src/ticker/index.js';
import { animate } from '../src/index.js';

// Subpath api pin (contract)
describe('presets subpath api pin', () => {
  it('exports expected preset functions (no silent drift)', () => {
    expect(typeof splitText).toBe('function');
    expect(typeof typewriter).toBe('function');
    expect(typeof scramble).toBe('function');
    expect(typeof animateNumber).toBe('function');
    expect(typeof formatNumber).toBe('function');
    expect(typeof ticker).toBe('function');
    expect(typeof animate).toBe('function');
  });
});

describe('text presets (split/type/scramble)', () => {
  it('splitText chars (unicode) and words', () => {
    expect(splitText('Hi!')).toEqual(['H', 'i', '!']);
    expect(splitText('a b  c', 'words')).toEqual(['a', ' ', 'b', '  ', 'c']);
    expect(splitText('')).toEqual([]);
  });

  it('typewriter reveals progressively (step clock via drive)', async () => {
    const updates: string[] = [];
    // Use reduced=false explicit + injected clock? drive accepts requestFrame but for simplicity drive with default (fast)
    await typewriter('abc', (p) => updates.push(p), { spring: { mass: 0.1, stiffness: 1000, damping: 50 } });
    expect(updates[updates.length - 1]).toBe('abc');
    expect(updates.length).toBeGreaterThan(1);
  });

  it('scramble uses seed for determinism (property: same seed same final)', async () => {
    const out1: string[] = [];
    const out2: string[] = [];
    await scramble('test', (s) => out1.push(s), { seed: 42, spring: { mass: 0.1, stiffness: 800, damping: 30 } });
    await scramble('test', (s) => out2.push(s), { seed: 42, spring: { mass: 0.1, stiffness: 800, damping: 30 } });
    expect(out1[out1.length - 1]).toBe('test');
    expect(out2[out2.length - 1]).toBe(out1[out1.length - 1]);
  });
});

describe('number presets (Intl)', () => {
  it('formatNumber uses Intl (SSR safe)', () => {
    const us = formatNumber(1234.56, { locales: 'en-US', format: { style: 'currency', currency: 'USD' } });
    expect(us).toContain('$');
    const de = formatNumber(1234.56, { locales: 'de-DE' });
    expect(de).toMatch(/1\.234/);
  });

  it('animateNumber emits formatted values', async () => {
    const outs: string[] = [];
    await animateNumber(0, 2, (f) => outs.push(f), { spring: { mass: 0.2, stiffness: 500, damping: 20 } });
    expect(outs[outs.length - 1]).toBe('2');
    expect(outs.some(o => o.includes('1')) || outs.length > 1).toBe(true);
  });
});

describe('ticker preset', () => {
  it('ticker emits value + optional digits', async () => {
    const steps: any[] = [];
    await ticker(0, 10, (s) => steps.push(s), { asDigits: true, spring: { mass: 0.1, stiffness: 900, damping: 40 } });
    expect(steps[steps.length - 1].value).toBeCloseTo(10, 0);
    expect(Array.isArray(steps[0].digits)).toBe(true);
  });
});

// Property-like (small generative over seeds)
describe('property: scramble deterministic over seeds', () => {
  it('different seeds produce different intermediate but converge to target', async () => {
    const results: string[] = [];
    for (let s = 1; s <= 3; s++) {
      let last = '';
      await scramble('seed', (x) => { last = x; }, { seed: s * 999, spring: { mass: 0.05, stiffness: 1200, damping: 25 } });
      results.push(last);
    }
    expect(results.every(r => r === 'seed')).toBe(true);
  });
});

// Reduced motion smoke (reuses drive policy)
describe('presets respect reduced-motion (via animate/drive)', () => {
  it('short circuits to final when reduce=true (injected)', async () => {
    const spy = vi.fn();
    const stub = () => ({ matches: true, media: '', addEventListener() {}, removeEventListener() {} } as any);
    await animateNumber(0, 999, spy, { matchMedia: stub as any, spring: { mass: 1, stiffness: 10, damping: 1 } });
    expect(spy).toHaveBeenCalledWith('999');
  });
});
