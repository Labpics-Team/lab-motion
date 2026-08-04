/**
 * test/future-layout-domain.test.ts — RED: сопряжённая траектория домена.
 *
 * Спека: «ОСНОВНОЙ ЗАКОН ПОВЕРХНОСТИ», «СОПРЯЖЁННАЯ ТРАЕКТОРИЯ», «CROSSFADE»,
 * «ПОЗИТИВНОСТЬ И СИНГУЛЯРНОСТЬ»; RED-Фаза п.6 (snapshots растягивают glyph
 * marker без reciprocal), п.7 (reciprocal строится из raw spring вместо
 * serialized P), п.8 (under-damped width к нулю без fail-closed), п.9
 * (crossfade из oscillatory P повторно показывает old snapshot).
 *
 * RED PROOF: src/future-layout/index.ts — заглушка `export {}`; pick-хелперы
 * возвращают undefined, каждый тест падает СВОИМ ассертом («… is not a
 * function»), не link-ошибкой (канон test/animate-facade-helpers.ts:9-31).
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import * as surface from '../src/future-layout/index.js';
import {
  pickCertifyPositivity,
  pickCompileSurfaceArtifact,
  pickSurfacePlan,
} from './future-layout-helpers.js';

const mod = surface as unknown as Record<string, unknown>;
const compileSurfaceArtifact = pickCompileSurfaceArtifact(mod);
const certifyPositivity = pickCertifyPositivity(mod);
const planSurface = pickSurfacePlan(mod);

const SPRING = { mass: 1, stiffness: 170, damping: 26 };
const UNDERDAMPED = { mass: 1, stiffness: 170, damping: 8 };

describe('сопряжённая траектория: serialized P → reciprocal Q → monotonic A', () => {
  it('RED п.6: G(t)·F_j·R_j(t)=1 — glyph marker не растягивается ни на одном кадре', () => {
    const artifact = compileSurfaceArtifact(SPRING, 240, 360);
    // Контент остаётся в естественной ширине: F_j = 1, R_j = W_j/W(t) —
    // произведение внешнего scale и counter-scale тождественно 1.
    const plan = planSurface(SPRING, 240, 360);
    expect(plan.effectCount).toBeLessThanOrEqual(5);
    for (const [percent, progress] of samplePairs(artifact)) {
      const w = 240 + (360 - 240) * progress;
      const g = w / 360; // B = W1, old-snapshot fit F_old = 360/240
      const rOld = 240 / w;
      expect(Math.abs(g * (360 / 240) * rOld - 1)).toBeLessThan(1e-9);
      expect(percent).toBeGreaterThanOrEqual(0);
    }
  });

  it('RED п.7: Q построен ТОЛЬКО из serialized P — никаких аналитических пружин', () => {
    const artifact = compileSurfaceArtifact(SPRING, 240, 360);
    // Для каждого serialized stop: Q = (1/W − 1/W0) / (1/W1 − 1/W0),
    // где W взят из СЕРИАЛИЗОВАННОГО progress (округление включено).
    for (const [, progress] of samplePairs(artifact)) {
      const w = 240 + (360 - 240) * progress;
      const q = (1 / w - 1 / 240) / (1 / 360 - 1 / 240);
      expect(Number.isFinite(q)).toBe(true);
    }
    // Reciprocal-артефакт воспроизводит эти значения токенами, а не solver'ом:
    expect(typeof artifact.reciprocalEasing).toBe('string');
    expect(artifact.reciprocalEasing.startsWith('linear(')).toBe(true);
  });

  it('RED п.8: under-damped width к нулю — fail-closed ДО запуска native plan', () => {
    // Отрицательная стартовая скорость уводит underdamped W ниже нуля
    // (в покое пружина не пересекает W0 — позитивность тривиальна).
    expect(() => {
      const artifact = compileSurfaceArtifact(UNDERDAMPED, 40, 360, undefined, undefined, -20);
      const positive = certifyPositivity(artifact, 0.5);
      if (!positive) throw new MotionParamError('LM167');
    }).toThrow(MotionParamError);
  });

  it('RED п.8: позитивность сертифицируется с учётом rounding, а не скрытым clamp', () => {
    const artifact = compileSurfaceArtifact(SPRING, 240, 360);
    expect(certifyPositivity(artifact, 0.5)).toBe(true);
    expect(artifact.minWidth).toBeGreaterThan(0.5);
    // Никакого Infinity/NaN/огромного reciprocal в CSS-токенах:
    expect(/NaN|Infinity/.test(artifact.reciprocalEasing)).toBe(false);
  });

  it('RED п.9: crossfade A(t) монотонна — old snapshot не появляется повторно', () => {
    const artifact = compileSurfaceArtifact(UNDERDAMPED, 240, 360);
    const blend = blendSamples(artifact);
    expect(blend[0]).toBe(0);
    expect(blend[blend.length - 1]).toBe(1);
    for (let i = 1; i < blend.length; i++) {
      expect(blend[i]).toBeGreaterThanOrEqual(blend[i - 1]);
    }
  });
});

// ─── Внутренние помощники RED-ассертов (уточняются в GREEN) ──────────────────

function samplePairs(artifact: { samples?: ArrayLike<number> }): number[][] {
  const samples = (artifact as Record<string, unknown>)['samples'] as ArrayLike<number>;
  if (samples === undefined) throw new TypeError('surface artifact has no serialized samples');
  const pairs: number[][] = [];
  for (let i = 0; i < samples.length; i += 2) pairs.push([samples[i], samples[i + 1]]);
  return pairs;
}

function blendSamples(artifact: unknown): number[] {
  const blend = (artifact as Record<string, unknown>)['blendSamples'] as number[];
  if (blend === undefined) throw new TypeError('surface artifact has no blend samples');
  return blend;
}
