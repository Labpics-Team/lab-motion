/**
 * test/presets-waapi.test.ts — presetToWaapi(): чистый конвертер PresetSpec →
 * данные для element.animate() (t3 ch01-motion-presets).
 *
 * Зачем: для 20+ иконок на экране WAAPI-путь (композитор, off-main-thread)
 * дешевле rAF-лупа; конвертер остаётся headless — производит ДАННЫЕ
 * (keyframes+timing), DOM-вызов делает потребитель.
 *
 * Контракт:
 *   - offsets: отсортированы, первый 0, последний 1; в точках offset значения
 *     БИТ-СОВПАДАЮТ с samplePreset (между точками WAAPI линейно интерполирует —
 *     плотность сетки отвечает за верность easing).
 *   - transform-композиция в фикс-порядке translate → rotate → scale;
 *     scale-оси: sx = scale·scaleX, sy = scale·scaleY.
 *   - opacity → отдельное свойство кейфрейма.
 *   - progress НЕ выражается CSS-свойством → отдельный progressTrack.
 *   - timing: duration/delay в МИЛЛИСЕКУНДАХ, iterations = repeat+1 (Infinity ок),
 *     direction: loop→'normal', reverse→'alternate', fill:'both', easing:'linear'.
 *   - repeatDelay > 0 → MotionParamError (в WAAPI нет нативного repeatDelay;
 *     честный отказ вместо тихо-неверной семантики — используйте runPreset).
 *
 * TDD RED-proof: написан до конвертера; после: сломать порядок transform
 * (scale раньше translate) → тест композиции RED.
 *
 * Классы: А (unit-структура), В (differential vs samplePreset).
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import {
  blink,
  compilePreset,
  drawOn,
  presetToWaapi,
  pulse,
  samplePreset,
  spin,
  type PresetSpec,
} from '../src/presets/index.js';

describe('presets — presetToWaapi: структура', () => {
  it('А: offsets отсортированы, края 0 и 1', () => {
    const w = presetToWaapi(pulse());
    expect(w.keyframes.length).toBeGreaterThan(2);
    expect(w.keyframes[0]!.offset).toBe(0);
    expect(w.keyframes[w.keyframes.length - 1]!.offset).toBe(1);
    for (let i = 1; i < w.keyframes.length; i++) {
      expect(w.keyframes[i]!.offset).toBeGreaterThan(w.keyframes[i - 1]!.offset);
    }
  });

  it('А: spin → transform rotate от 0deg до 720deg; opacity отсутствует', () => {
    const w = presetToWaapi(spin({ turns: 2, duration: 1 }));
    expect(w.keyframes[0]!.transform).toContain('rotate(0deg)');
    expect(w.keyframes[w.keyframes.length - 1]!.transform).toContain('rotate(720deg)');
    expect(w.keyframes[0]!.opacity).toBeUndefined();
  });

  it('А: blink → opacity в кейфреймах, transform отсутствует; iterations=Infinity', () => {
    const w = presetToWaapi(blink({ min: 0, duration: 1 }));
    expect(w.keyframes[0]!.opacity).toBe(1);
    expect(w.keyframes[0]!.transform).toBeUndefined();
    expect(w.timing.iterations).toBe(Infinity);
  });

  it('А: transform-композиция в порядке translate → rotate → scale', () => {
    // Mutation proof: переставить порядок → RED
    const spec: PresetSpec = {
      duration: 1,
      tracks: [
        { property: 'x', values: [0, 4] },
        { property: 'rotate', values: [0, 90] },
        { property: 'scale', values: [1, 2] },
        { property: 'scaleX', values: [1, 1.5] },
      ],
    };
    const w = presetToWaapi(spec);
    const last = w.keyframes[w.keyframes.length - 1]!.transform!;
    const ti = last.indexOf('translate(');
    const ri = last.indexOf('rotate(');
    const si = last.indexOf('scale(');
    expect(ti).toBeGreaterThanOrEqual(0);
    expect(ri).toBeGreaterThan(ti);
    expect(si).toBeGreaterThan(ri);
    // scale-оси перемножаются: sx = 2·1.5 = 3, sy = 2·1 = 2
    expect(last).toContain('scale(3, 2)');
    expect(last).toContain('translate(4px, 0px)');
  });

  it('А: timing в миллисекундах; direction по repeatType; fill both', () => {
    const w = presetToWaapi({
      ...pulse({ duration: 0.9 }),
      delay: 0.5,
      repeat: 2,
      repeatType: 'reverse',
    });
    expect(w.timing.duration).toBeCloseTo(900, 9);
    expect(w.timing.delay).toBeCloseTo(500, 9);
    expect(w.timing.iterations).toBe(3);
    expect(w.timing.direction).toBe('alternate');
    expect(w.timing.fill).toBe('both');
    expect(w.timing.easing).toBe('linear');
  });

  it('А: progress-канал уходит в progressTrack, не в CSS-кейфреймы', () => {
    const w = presetToWaapi(drawOn({ duration: 1 }));
    expect(w.progressTrack).toBeDefined();
    expect(w.progressTrack!.offsets[0]).toBe(0);
    expect(w.progressTrack!.values[0]).toBeCloseTo(0, 12);
    expect(w.progressTrack!.values[w.progressTrack!.values.length - 1]!).toBeCloseTo(1, 12);
    // Чистый progress-пресет не имеет CSS-кейфреймов
    expect(w.keyframes).toHaveLength(0);
  });

  it('А: repeatDelay > 0 → MotionParamError (честный отказ)', () => {
    expect(() => presetToWaapi({ ...pulse(), repeatDelay: 0.5 })).toThrow(MotionParamError);
  });
});

describe('presets — presetToWaapi: differential vs samplePreset', () => {
  it('В: в точках offset значения совпадают с samplePreset (первый цикл)', () => {
    const spec = pulse({ amount: 0.2, duration: 2 });
    const c = compilePreset(spec);
    const w = presetToWaapi(spec);
    for (const kf of w.keyframes) {
      const t = kf.offset * 2; // duration 2с, первый цикл, delay 0
      const want = samplePreset(c, t);
      const m = /scale\(([-\d.e]+), ([-\d.e]+)\)/.exec(kf.transform!);
      expect(m, `offset ${kf.offset}`).not.toBeNull();
      expect(Number(m![1])).toBeCloseTo(want.scale!, 10);
    }
  });
});
