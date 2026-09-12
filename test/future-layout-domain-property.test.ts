/**
 * test/future-layout-domain-property.test.ts — GREEN: property-инварианты
 * сопряжённого артефакта (спека «ТЕСТОВАЯ СТРАТЕГИЯ: Pure domain»).
 *
 * Всё проверяется по serialized stops (SSOT), независимо от emitter'а:
 * endpoints, монотонность A, G·F·R=1, Q из serialized P, строгий сертификат
 * позитивности, дефолт W0=W1 без деления, валидация LM167.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import {
  certifyPositivity,
  compileSurfaceArtifact,
  outerScaleKeyframes,
  planeScaleKeyframes,
  tryCompileSurfaceArtifact,
} from '../src/future-layout/index.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };
const UNDERDAMPED = { mass: 1, stiffness: 170, damping: 9 };

/** Независимо читает canonical execution `linear(value percent%, …)`. */
function explicitLinearPairs(css: string): readonly (readonly [number, number])[] {
  expect(css.startsWith('linear(')).toBe(true);
  expect(css.endsWith(')')).toBe(true);
  return css.slice(7, -1).split(',').map((part) => {
    const tokens = part.trim().split(/\s+/);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]!.endsWith('%')).toBe(true);
    return [Number(tokens[1]!.slice(0, -1)), Number(tokens[0])] as const;
  });
}

describe('serialized stops и endpoints', () => {
  it('percents строго возрастают 0→100; progress стартует в 0', () => {
    const a = compileSurfaceArtifact(SPRING, 240, 360);
    const n = a.samples.length / 2;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(a.samples[0]).toBe(0);
    expect(a.samples[(n - 1) * 2]).toBe(100);
    expect(a.samples[1]).toBe(0);
    for (let i = 1; i < n; i++) {
      expect(a.samples[i * 2]).toBeGreaterThan(a.samples[(i - 1) * 2]);
    }
  });

  it('Q endpoints точны: 0 на старте, 1 в финале', () => {
    const pairs = explicitLinearPairs(compileSurfaceArtifact(SPRING, 240, 360).reciprocalEasing);
    expect(pairs[0]![1]).toBeCloseTo(0, 12);
    expect(pairs[pairs.length - 1]![1]).toBeCloseTo(1, 12);
  });
});

describe('Q строится только из serialized P', () => {
  it('каждый reciprocal stop равен (1/W−1/W0)/(1/W1−1/W0) по serialized progress', () => {
    const a = compileSurfaceArtifact(SPRING, 240, 360);
    const delta = 1 / 360 - 1 / 240;
    const qOfPercent = new Map(explicitLinearPairs(a.reciprocalEasing));
    // Все P-stops присутствуют в Q-сериализации (superset от subdivision):
    for (let i = 0; i < a.samples.length / 2; i++) {
      const percent = a.samples[i * 2];
      const progress = a.samples[i * 2 + 1];
      const w = 240 + (360 - 240) * progress;
      const q = (1 / w - 1 / 240) / delta;
      expect(qOfPercent.has(percent)).toBe(true);
      expect(qOfPercent.get(percent)).toBeCloseTo(q, 10);
    }
  });
});

describe('инвариант поверхности G·F_j·R_j = 1', () => {
  it('keyframes плоскостей и outer scale тождественно дают 1 на каждом stop', () => {
    const a = compileSurfaceArtifact(SPRING, 240, 360);
    const [g0, g1] = outerScaleKeyframes(a);
    const [rOld0, rOld1] = planeScaleKeyframes(a, 240);
    const [rNew0, rNew1] = planeScaleKeyframes(a, 360);
    // B = W1: G = W/B; host-fit F_j = B/W_j; R_j = W_j/W ⇒ произведение 1.
    expect(g0 * (360 / 240) * rOld0).toBeCloseTo(1, 12);
    expect(g1 * (360 / 240) * rOld1).toBeCloseTo(1, 12);
    expect(g0 * (360 / 360) * rNew0).toBeCloseTo(1, 12);
    expect(g1 * (360 / 360) * rNew1).toBeCloseTo(1, 12);
  });
});

describe('монотонная blend A(t)', () => {
  it('строгая endpoints и неубывание на underdamped пружине', () => {
    const a = compileSurfaceArtifact(UNDERDAMPED, 240, 360);
    const blend = explicitLinearPairs(a.blendEasing).map((pair) => pair[1]);
    expect(blend[0]).toBe(0);
    expect(blend[blend.length - 1]).toBe(1);
    for (let i = 1; i < blend.length; i++) {
      expect(blend[i]).toBeGreaterThanOrEqual(blend[i - 1]);
    }
    expect(/NaN|Infinity/.test(a.blendEasing)).toBe(false);
  });
});

describe('сертификат позитивности', () => {
  it('строгий: min W проходит порог ниже минимума и не проходит равный', () => {
    const a = compileSurfaceArtifact(SPRING, 240, 360);
    // Из покоя min W = W0 (P≥0): сертификат строгий по порогу.
    expect(certifyPositivity(a, a.minWidth - 1e-9)).toBe(true);
    expect(certifyPositivity(a, a.minWidth)).toBe(false);
    expect(certifyPositivity(a, -1)).toBe(false);
  });

  it('W0=W1: деление не выполняется, мгновенный артефакт', () => {
    const a = compileSurfaceArtifact(SPRING, 300, 300);
    expect(a.durationMs).toBe(0);
    expect(a.minWidth).toBe(300);
    expect(certifyPositivity(a, 0.5)).toBe(true);
  });

  it('невалидные ширины — LM167 до любых аллокаций', () => {
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => compileSurfaceArtifact(SPRING, bad, 360)).toThrow(MotionParamError);
      expect(() => compileSurfaceArtifact(SPRING, 240, bad)).toThrow(MotionParamError);
    }
    expect(() => tryCompileSurfaceArtifact(SPRING, 0, 360)).toThrow(MotionParamError);
  });

  it('пересечение нуля (v0<0) — fail-closed, CSS без Infinity/NaN', () => {
    expect(tryCompileSurfaceArtifact(UNDERDAMPED, 40, 360, undefined, undefined, -20)).toBeUndefined();
  });
});
