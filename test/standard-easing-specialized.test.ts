/** Специализированный default easing: точность generic-кривой без её lookup-графа. */

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { cubicBezierUnchecked } from '../src/internal/cubic-bezier.js';
import {
  STANDARD_EASING,
  STANDARD_EASING_COORDS,
} from '../src/internal/motion-defaults.js';
import { easing } from '../src/tokens/index.js';

const GRID_STEPS = 1_000_000;

describe('STANDARD_EASING specialized solver', () => {
  it('сохраняет точные границы, включая канонизацию -0', () => {
    expect(STANDARD_EASING(0)).toBe(0);
    expect(STANDARD_EASING(1)).toBe(1);
    expect(Object.is(STANDARD_EASING(-0), 0)).toBe(true);
  });

  it('детерминированно ограничивает враждебные и внешние входы', () => {
    for (const input of [NaN, Number.NEGATIVE_INFINITY, -2, -Number.MIN_VALUE]) {
      expect(Object.is(STANDARD_EASING(input), 0)).toBe(true);
    }
    for (const input of [1 + Number.EPSILON, 2, Number.POSITIVE_INFINITY]) {
      expect(STANDARD_EASING(input)).toBe(1);
    }

    const generic = cubicBezierUnchecked(...STANDARD_EASING_COORDS);
    for (const input of [Number.MIN_VALUE, 1 - Number.EPSILON]) {
      expect(STANDARD_EASING(input)).toBe(generic(input));
    }
  });

  it('строго детерминирован на seeded interior-выборке', () => {
    let state = 0x6d2b79f5;
    let mismatch = -1;
    for (let i = 0; i < 100_000; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const t = state / 0x1_0000_0000;
      if (!Object.is(STANDARD_EASING(t), STANDARD_EASING(t))) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  });

  it('монотонен и конечен на плотной сетке 1 000 001 точек', () => {
    let previous = -Infinity;
    let violation = -1;
    for (let i = 0; i <= GRID_STEPS; i++) {
      const value = STANDARD_EASING(i / GRID_STEPS);
      if (!Number.isFinite(value) || value < previous || value < 0 || value > 1) {
        violation = i;
        break;
      }
      previous = value;
    }
    expect(violation).toBe(-1);
  });

  it('совпадает с generic solver не хуже 1e-15, а четыре Newton-шага ломают контракт', () => {
    const generic = cubicBezierUnchecked(...STANDARD_EASING_COORDS);
    let maxError = 0;
    let fourStepMaxError = 0;
    let at = -1;
    for (let i = 0; i <= GRID_STEPS; i++) {
      const input = i / GRID_STEPS;
      const expected = generic(input);
      const error = Math.abs(STANDARD_EASING(input) - expected);
      if (error > maxError) {
        maxError = error;
        at = i;
      }
      if (input > 0 && input < 1) {
        let u = Math.min(1, input / 0.6);
        for (let step = 0; step < 4; step++) {
          const x = u * (0.6 + u * (-1.2 + 1.6 * u));
          const dx = 0.6 + u * (-2.4 + 4.8 * u);
          u -= (x - input) / dx;
        }
        fourStepMaxError = Math.max(fourStepMaxError, Math.abs(u * u * (3 - 2 * u) - expected));
      }
    }
    expect({ maxError, at }).toEqual({
      maxError: expect.any(Number),
      at: expect.any(Number),
    });
    expect(maxError).toBeLessThanOrEqual(1e-15);
    expect(fourStepMaxError).toBeGreaterThan(1e-15);
  });

  it('координаты и ссылочная идентичность едины с публичным контрактом tokens', () => {
    expect(STANDARD_EASING_COORDS).toEqual([0.2, 0, 0, 1]);
    expect(easing.standard.fn).toBe(STANDARD_EASING);
    expect(easing.standard.css).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });

  it('motion-defaults не имеет import-ребра к generic cubic-bezier', async () => {
    const result = await build({
      entryPoints: ['src/animate/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      treeShaking: true,
      metafile: true,
      logLevel: 'silent',
    });
    const defaultsInput = Object.entries(result.metafile!.inputs).find(([path]) =>
      path.endsWith('src/internal/motion-defaults.ts'),
    );
    expect(defaultsInput).toBeDefined();
    expect(defaultsInput![1].imports.some(({ path }) => path.endsWith('cubic-bezier.ts'))).toBe(false);
  });
});
