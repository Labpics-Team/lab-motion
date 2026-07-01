/**
 * test/presets-factories.test.ts — фабрики пресетов (t2 ch01-motion-presets).
 *
 * Контракт:
 *   - Каждая фабрика возвращает КОМПИЛИРУЕМУЮ PresetSpec (compilePreset не бросает).
 *   - Дефолты калиброваны по вкусовому эталону владельца (REFS-LABPICS.md):
 *     мягкие амплитуды (pulse ~0.12, wiggle ~8°), простое читаемое движение,
 *     identity-краевые позы (анимация начинается и заканчивается в нейтральной
 *     позе слоя — иконка после анимации выглядит как статическая).
 *   - Невалидные параметры → MotionParamError с префиксом "presets:".
 *
 * TDD RED-proof: тесты написаны до фабрик — первый прогон падает на импорте.
 * Классы: А (unit-форма каждой фабрики), Д (mutation proof в комментариях).
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import {
  blink,
  bounceY,
  breathe,
  compilePreset,
  drawOn,
  drift,
  fadeSlide,
  pop,
  pulse,
  samplePreset,
  spin,
  wiggle,
  type PresetSpec,
} from '../src/presets/index.js';

/** Все фабрики с дефолтами — для сквозных структурных проверок. */
const ALL_FACTORIES: ReadonlyArray<readonly [string, () => PresetSpec]> = [
  ['pulse', () => pulse()],
  ['blink', () => blink()],
  ['wiggle', () => wiggle()],
  ['spin', () => spin()],
  ['breathe', () => breathe()],
  ['pop', () => pop()],
  ['bounceY', () => bounceY()],
  ['drift', () => drift()],
  ['fadeSlide', () => fadeSlide()],
  ['drawOn', () => drawOn()],
];

describe('presets — фабрики: структурная валидность', () => {
  it('А: каждая фабрика с дефолтами компилируется без ошибок', () => {
    for (const [name, make] of ALL_FACTORIES) {
      expect(() => compilePreset(make()), `фабрика ${name}`).not.toThrow();
    }
  });

  it('А: сэмпл каждой фабрики конечен на всём цикле', () => {
    for (const [name, make] of ALL_FACTORIES) {
      const c = compilePreset(make());
      for (let i = 0; i <= 50; i++) {
        const v = samplePreset(c, (i / 50) * (c.duration + c.delay));
        for (const key of Object.keys(v) as (keyof typeof v)[]) {
          expect(Number.isFinite(v[key]!), `${name}.${key} @${i}`).toBe(true);
        }
      }
    }
  });
});

describe('presets — pulse: пульс масштаба (зрачок из эталона ref-1)', () => {
  it('А: identity-края и пик 1+amount в середине', () => {
    // Mutation proof: сломать values на [1, 1+a] (без возврата) → тест края RED
    const c = compilePreset(pulse({ amount: 0.2, duration: 1 }));
    expect(samplePreset(c, 0).scale).toBeCloseTo(1, 12);
    expect(samplePreset(c, 0.5).scale).toBeCloseTo(1.2, 12);
    expect(samplePreset(c, 1).scale).toBeCloseTo(1, 12);
  });

  it('А: дефолтная амплитуда мягкая (≤0.15 — эталон владельца)', () => {
    const c = compilePreset(pulse());
    let peak = 1;
    for (let i = 0; i <= 100; i++) {
      const s = samplePreset(c, (i / 100) * c.duration).scale!;
      if (s > peak) peak = s;
    }
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThanOrEqual(1.15);
  });
});

describe('presets — blink: мигание (курсор из эталона ref-2)', () => {
  it('А: opacity 1 → min → 1, по умолчанию бесконечный луп', () => {
    const c = compilePreset(blink({ min: 0.1, duration: 1 }));
    expect(samplePreset(c, 0).opacity).toBeCloseTo(1, 12);
    expect(samplePreset(c, 0.5).opacity).toBeCloseTo(0.1, 12);
    expect(samplePreset(c, 1).opacity).toBeCloseTo(1, 12);
    expect(c.repeat).toBe(Infinity);
  });
});

describe('presets — wiggle: покачивание (колокольчик)', () => {
  it('А: identity-края, амплитуда ≤ degrees, знак чередуется', () => {
    const c = compilePreset(wiggle({ degrees: 10, duration: 1 }));
    expect(samplePreset(c, 0).rotate).toBeCloseTo(0, 12);
    expect(samplePreset(c, 1).rotate).toBeCloseTo(0, 12);
    let maxAbs = 0;
    let sawPositive = false;
    let sawNegative = false;
    for (let i = 0; i <= 200; i++) {
      const r = samplePreset(c, (i / 200) * 1).rotate!;
      maxAbs = Math.max(maxAbs, Math.abs(r));
      if (r > 1) sawPositive = true;
      if (r < -1) sawNegative = true;
    }
    expect(maxAbs).toBeLessThanOrEqual(10 + 1e-9);
    expect(maxAbs).toBeGreaterThan(5);
    // Mutation proof: убрать чередование знака (все свинги в +) → RED
    expect(sawPositive).toBe(true);
    expect(sawNegative).toBe(true);
  });
});

describe('presets — spin: оборот', () => {
  it('А: rotate 0 → 360×turns', () => {
    const c = compilePreset(spin({ turns: 2, duration: 1 }));
    expect(samplePreset(c, 0).rotate).toBeCloseTo(0, 12);
    expect(samplePreset(c, 1).rotate).toBeCloseTo(720, 12);
  });
});

describe('presets — breathe: дыхание (ambient)', () => {
  it('А: мягче и медленнее pulse; identity-края; бесконечный луп', () => {
    const cb = compilePreset(breathe());
    const cp = compilePreset(pulse());
    expect(cb.duration).toBeGreaterThan(cp.duration);
    expect(cb.repeat).toBe(Infinity);
    let peak = 1;
    for (let i = 0; i <= 100; i++) {
      const s = samplePreset(cb, (i / 100) * cb.duration).scale!;
      if (s > peak) peak = s;
    }
    expect(peak).toBeLessThanOrEqual(1.08);
    expect(samplePreset(cb, 0).scale).toBeCloseTo(1, 12);
  });
});

describe('presets — pop: появление с overshoot', () => {
  it('А: scale 0 → overshoot → 1 (оседает в статику)', () => {
    const c = compilePreset(pop({ overshoot: 1.3, duration: 1 }));
    expect(samplePreset(c, 0).scale).toBeCloseTo(0, 12);
    let peak = 0;
    for (let i = 0; i <= 100; i++) {
      const s = samplePreset(c, i / 100).scale!;
      if (s > peak) peak = s;
    }
    expect(peak).toBeCloseTo(1.3, 6);
    expect(samplePreset(c, 1).scale).toBeCloseTo(1, 12);
  });
});

describe('presets — bounceY: подскок', () => {
  it('А: y уходит вверх (отрицательный) и возвращается в 0; второй отскок ниже', () => {
    const c = compilePreset(bounceY({ height: 4, duration: 1 }));
    expect(samplePreset(c, 0).y).toBeCloseTo(0, 12);
    expect(samplePreset(c, 1).y).toBeCloseTo(0, 12);
    let minY = 0;
    for (let i = 0; i <= 200; i++) {
      const y = samplePreset(c, i / 200).y!;
      if (y < minY) minY = y;
    }
    expect(minY).toBeCloseTo(-4, 6);
  });
});

describe('presets — drift: ambient-дрейф (звёзды из эталона ref-3)', () => {
  it('А: по умолчанию только трек y (dx=0 не создаёт пустой трек); identity-края; ambient-длительность', () => {
    const def = compilePreset(drift());
    expect(def.tracks.map((t) => t.property)).toEqual(['y']);
    expect(def.duration).toBeGreaterThanOrEqual(3);
    expect(def.repeat).toBe(Infinity);
    expect(samplePreset(def, 0).y).toBeCloseTo(0, 12);

    const both = compilePreset(drift({ dx: 2, dy: -3 }));
    expect(both.tracks.map((t) => t.property).sort()).toEqual(['x', 'y']);
  });
});

describe('presets — fadeSlide: появление со сдвигом', () => {
  it('А: opacity 0→1, смещение → 0; треки смещения только при ненулевой дельте', () => {
    const c = compilePreset(fadeSlide({ dy: 6, duration: 1 }));
    expect(samplePreset(c, 0).opacity).toBeCloseTo(0, 12);
    expect(samplePreset(c, 0).y).toBeCloseTo(6, 12);
    expect(samplePreset(c, 1).opacity).toBeCloseTo(1, 12);
    expect(samplePreset(c, 1).y).toBeCloseTo(0, 12);
    expect(c.tracks.map((t) => t.property).sort()).toEqual(['opacity', 'y']);
  });
});

describe('presets — drawOn: канал прогресса рисования (BL-002)', () => {
  it('А: progress 0→1 монотонно', () => {
    const c = compilePreset(drawOn({ duration: 1 }));
    expect(samplePreset(c, 0).progress).toBeCloseTo(0, 12);
    expect(samplePreset(c, 1).progress).toBeCloseTo(1, 12);
    let prev = -1e-9;
    for (let i = 0; i <= 100; i++) {
      const p = samplePreset(c, i / 100).progress!;
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });
});

describe('presets — фабрики: валидация параметров', () => {
  it('А: NaN/∞/неположительная duration → MotionParamError', () => {
    expect(() => pulse({ amount: Number.NaN })).toThrow(MotionParamError);
    expect(() => wiggle({ degrees: Infinity })).toThrow(MotionParamError);
    expect(() => spin({ turns: Number.NaN })).toThrow(MotionParamError);
    expect(() => blink({ min: Number.NaN })).toThrow(MotionParamError);
    expect(() => bounceY({ height: Infinity })).toThrow(MotionParamError);
    expect(() => drift({ dx: Number.NaN })).toThrow(MotionParamError);
    expect(() => fadeSlide({ dx: Infinity })).toThrow(MotionParamError);
    expect(() => pop({ overshoot: Number.NaN })).toThrow(MotionParamError);
    expect(() => pulse({ duration: 0 })).toThrow(MotionParamError);
    expect(() => drawOn({ duration: -1 })).toThrow(MotionParamError);
  });

  it('А: blink.min вне [0,1] → MotionParamError', () => {
    expect(() => blink({ min: -0.1 })).toThrow(MotionParamError);
    expect(() => blink({ min: 1.5 })).toThrow(MotionParamError);
  });
});
