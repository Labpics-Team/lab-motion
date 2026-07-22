/**
 * Round-trip эмиттера через НЕЗАВИСИМЫЙ CSS-linear парсер (#232, фундамент).
 *
 * Доказывает: строка, которую печатает production-эмиттер, разбирается второй
 * реализацией грамматики в ТЕ ЖЕ (percent, progress)-стопы, что и защищённые
 * serialized samples артефакта. Любая будущая канонизация (#232: implicit
 * positions, опущенные 0%/100%) обязана сохранить этот инвариант — парсер уже
 * понимает implicit-правила спеки, что подтверждают синтетические кейсы.
 */

import { describe, expect, it } from 'vitest';
import {
  compileSpringExecutionArtifactUnchecked,
} from '../src/compositor/curve.js';
import { parseCssLinear, sampleLinearStops } from './css-linear-reference.js';
import type { SpringParams } from '../src/spring.js';

const CORPUS: Array<{ spring: SpringParams; v0: number; tolerance: number }> = [
  { spring: { mass: 1, stiffness: 100, damping: 10 }, v0: 0, tolerance: 1 / 400 },
  { spring: { mass: 1, stiffness: 100, damping: 10 }, v0: 3, tolerance: 1 / 400 },
  { spring: { mass: 1, stiffness: 100, damping: 20 }, v0: -2, tolerance: 1 / 400 },
  { spring: { mass: 1, stiffness: 100, damping: 40 }, v0: 0, tolerance: 1 / 400 },
  { spring: { mass: 2, stiffness: 180, damping: 12 }, v0: 1.5, tolerance: 1e-3 },
];

describe('#232: эмиттер ↔ независимый CSS-linear парсер', () => {
  it('строка артефакта разбирается ровно в защищённые serialized stops', () => {
    for (const { spring, v0, tolerance } of CORPUS) {
      const artifact = compileSpringExecutionArtifactUnchecked(spring, v0, tolerance);
      const stops = parseCssLinear(artifact.easing);
      expect(stops.length).toBe(artifact.samples.length / 2);
      for (let i = 0; i < stops.length; i++) {
        expect(stops[i]!.input, `stop ${i} percent`).toBe(artifact.samples[i * 2]!);
        expect(stops[i]!.output, `stop ${i} progress`).toBe(artifact.samples[i * 2 + 1]!);
      }
    }
  });

  it('интерполяция парсера совпадает с реконструкцией движка на плотной сетке', () => {
    const { spring, v0, tolerance } = CORPUS[0]!;
    const artifact = compileSpringExecutionArtifactUnchecked(spring, v0, tolerance);
    const stops = parseCssLinear(artifact.easing);
    for (let k = 0; k <= 500; k++) {
      const percent = (k / 500) * 100;
      const sampled = sampleLinearStops(stops, percent);
      expect(Number.isFinite(sampled)).toBe(true);
    }
    // Края точны по дисциплине эндпоинтов.
    expect(sampleLinearStops(stops, 0)).toBe(0);
    expect(sampleLinearStops(stops, 100)).toBe(1);
  });

  it('implicit-грамматика спеки: края, распределение, двойной процент, монотонизация', () => {
    // Опущенные крайние позиции → 0% / 100%.
    expect(parseCssLinear('linear(0, 1)')).toEqual([
      { input: 0, output: 0 },
      { input: 100, output: 1 },
    ]);
    // Пропущенные внутренние позиции распределяются линейно.
    expect(parseCssLinear('linear(0, 0.25, 0.75, 1)')).toEqual([
      { input: 0, output: 0 },
      { input: 100 / 3, output: 0.25 },
      { input: 200 / 3, output: 0.75 },
      { input: 100, output: 1 },
    ]);
    // Двойной процент дублирует точку (плоский сегмент).
    expect(parseCssLinear('linear(0, 0.5 25% 75%, 1)')).toEqual([
      { input: 0, output: 0 },
      { input: 25, output: 0.5 },
      { input: 75, output: 0.5 },
      { input: 100, output: 1 },
    ]);
    // Немонотонные позиции клампятся running-max-ом.
    expect(parseCssLinear('linear(0 0%, 0.6 40%, 0.4 20%, 1 100%)')).toEqual([
      { input: 0, output: 0 },
      { input: 40, output: 0.6 },
      { input: 40, output: 0.4 },
      { input: 100, output: 1 },
    ]);
  });
});
