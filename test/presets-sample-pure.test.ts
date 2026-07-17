/**
 * test/presets-sample-pure.test.ts — чистый сэмплер samplePreset() subpath ./presets
 *
 * Контракт (t1 ch01-motion-presets, эпик ds-icons):
 *   - compilePreset(spec) валидирует/нормализует PresetSpec (throw MotionParamError
 *     на структурно невалидном), samplePreset(compiled, t) — чистый горячий сэмплер
 *     БЕЗ повторной валидации (дисциплина sampleKeyframes).
 *   - Мультитрек: один момент времени t → значение КАЖДОГО трека спеки.
 *   - delay: t < delay → поза t=0 (первые значения треков), не «до-старта-пусто».
 *   - repeat/repeatType: семантика идентична keyframes: reverse разворачивает
 *     time/easing, mirror разворачивает values и сохраняет easing вперёд.
 *   - t за пределами totalDuration → значения конца ПОСЛЕДНЕГО цикла (yoyo-aware).
 *   - Инвариант конечности: ЛЮБОЙ вход (NaN/±Infinity/overflow) → конечный выход.
 *   - Детерминизм: бит-идентичные значения на повторном прогоне.
 *
 * TDD RED-proof:
 *   Файл написан ДО src/presets/index.ts — первый прогон падает
 *   (module not found), что зафиксировано в логе задачи. Далее классика:
 *   убрать finiteness-guard/ветку delay/yoyo → соответствующие тесты RED.
 *
 * Классы тестов: А (unit-семантика), В (property/fuzz), Д (mutation proof в доках).
 */

import { describe, expect, it } from 'vitest';
import {
  compilePreset,
  presetTotalDuration,
  samplePreset,
  type PresetSpec,
} from '../src/presets/index.js';

// ── Хелперы ──────────────────────────────────────────────────────────────────

/** Простейшая валидная спека: scale 1→2→1 за 1с. */
function pulseLikeSpec(extra?: Partial<PresetSpec>): PresetSpec {
  return {
    duration: 1,
    tracks: [{ property: 'scale', values: [1, 2, 1] }],
    ...extra,
  };
}

// ── А: базовая семантика сэмплирования ──────────────────────────────────────

describe('presets — samplePreset: базовая семантика', () => {
  it('А: t=0 → первые значения каждого трека', () => {
    const c = compilePreset({
      duration: 2,
      tracks: [
        { property: 'scale', values: [1, 1.5, 1] },
        { property: 'opacity', values: [0.2, 1] },
      ],
    });
    const v = samplePreset(c, 0);
    expect(v.scale).toBe(1);
    expect(v.opacity).toBe(0.2);
  });

  it('А: середина сегмента интерполируется линейно по умолчанию', () => {
    const c = compilePreset(pulseLikeSpec());
    // values [1,2,1], авто-times [0,0.5,1]; t=0.25с из 1с → p=0.25 → сегмент 0, локально 0.5 → 1.5
    expect(samplePreset(c, 0.25).scale).toBeCloseTo(1.5, 12);
    // пик в середине
    expect(samplePreset(c, 0.5).scale).toBeCloseTo(2, 12);
  });

  it('А: мультитрек — один t согласованно сэмплирует ВСЕ треки', () => {
    const c = compilePreset({
      duration: 4,
      tracks: [
        { property: 'rotate', values: [0, 360] },
        { property: 'y', values: [0, -2, 0] },
        { property: 'progress', values: [0, 1] },
      ],
    });
    const v = samplePreset(c, 1); // p=0.25
    expect(v.rotate).toBeCloseTo(90, 12);
    expect(v.y).toBeCloseTo(-1, 12); // сегмент 0: 0→-2, локально 0.5
    expect(v.progress).toBeCloseTo(0.25, 12);
    // Возвращаются ТОЛЬКО свойства треков спеки
    expect(Object.keys(v).sort()).toEqual(['progress', 'rotate', 'y']);
  });

  it('А: явные times и easing на сегмент уважаются', () => {
    const easeSquare = (t: number) => t * t;
    const c = compilePreset({
      duration: 1,
      tracks: [
        {
          property: 'opacity',
          values: [0, 1, 1],
          times: [0, 0.2, 1],
          easing: [easeSquare, (t) => t],
        },
      ],
    });
    // p=0.1 → сегмент 0 локально 0.5 → ease 0.25 → 0.25
    expect(samplePreset(c, 0.1).opacity).toBeCloseTo(0.25, 12);
    // p=0.6 → сегмент 1 (значения равны) → 1
    expect(samplePreset(c, 0.6).opacity).toBeCloseTo(1, 12);
  });
});

// ── А: delay ─────────────────────────────────────────────────────────────────

describe('presets — samplePreset: delay держит позу t=0', () => {
  it('А: t внутри [0, delay) → значения первых опорных точек', () => {
    // Mutation proof: убрать ветку delay (vt = t - delay без клампа) → RED
    const c = compilePreset(pulseLikeSpec({ delay: 0.5 }));
    expect(samplePreset(c, 0).scale).toBe(1);
    expect(samplePreset(c, 0.49).scale).toBe(1);
    // после delay — движение началось: t=0.75 → vt=0.25 → 1.5
    expect(samplePreset(c, 0.75).scale).toBeCloseTo(1.5, 12);
  });

  it('А: presetTotalDuration учитывает delay и repeat', () => {
    const c = compilePreset(pulseLikeSpec({ delay: 0.5, repeat: 2 }));
    // delay + 3 цикла × 1с
    expect(presetTotalDuration(c)).toBeCloseTo(3.5, 12);
  });
});

// ── А: repeat / repeatType / за пределами ────────────────────────────────────

describe('presets — samplePreset: repeat и границы', () => {
  it('А: repeat loop — каждый цикл заново вперёд', () => {
    const c = compilePreset(pulseLikeSpec({ repeat: 1 }));
    // второй цикл, t=1.25 → фаза 0.25 → 1.5
    expect(samplePreset(c, 1.25).scale).toBeCloseTo(1.5, 12);
    const asymmetric = compilePreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 100, 20] }],
      repeat: 1,
    });
    expect(samplePreset(asymmetric, 1).x).toBe(0); // half-open V1 boundary: next start
  });

  it("А: repeatType 'reverse' — нечётный цикл идёт назад (yoyo)", () => {
    // Mutation proof: forward = всегда true → RED
    const c = compilePreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 10] }],
      repeat: 1,
      repeatType: 'reverse',
    });
    // цикл 1 (нечётный), фаза 0.25 → эффективный p = 0.75 → 7.5
    expect(samplePreset(c, 1.25).x).toBeCloseTo(7.5, 12);
    // конец yoyo-последовательности → возврат к 0
    expect(samplePreset(c, 2).x).toBeCloseTo(0, 12);
  });

  it("А: 'mirror' reverses values while 'reverse' reverses time/easing", () => {
    const quadratic = (t: number): number => t * t;
    const spec = {
      duration: 1,
      tracks: [{ property: 'x' as const, values: [0, 100, 20], easing: quadratic }],
      repeat: 1,
    };
    const reverse = compilePreset({ ...spec, repeatType: 'reverse' });
    const mirror = compilePreset({ ...spec, repeatType: 'mirror' });
    expect(samplePreset(reverse, 1.25).x).toBe(80);
    expect(samplePreset(mirror, 1.25).x).toBe(40);
  });

  it('А: repeatDelay держит значение конца цикла между циклами', () => {
    const c = compilePreset(pulseLikeSpec({ repeat: 1, repeatDelay: 0.5 }));
    // конец цикла 0 при t=1; окно [1, 1.5) — держим конец (scale=1)
    expect(samplePreset(c, 1.2).scale).toBeCloseTo(1, 12);
    // второй цикл начался в 1.5: t=1.75 → фаза 0.25 → 1.5
    expect(samplePreset(c, 1.75).scale).toBeCloseTo(1.5, 12);
  });

  it('А: t за totalDuration → конец последнего цикла (yoyo-aware)', () => {
    const loop = compilePreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 10] }],
      repeat: 1,
    });
    expect(samplePreset(loop, 99).x).toBeCloseTo(10, 12);

    const yoyo = compilePreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 10] }],
      repeat: 1,
      repeatType: 'reverse',
    });
    expect(samplePreset(yoyo, 99).x).toBeCloseTo(0, 12);
  });

  it('А: repeat=Infinity — сэмплируется в далёком поддерживаемом t без зависаний', () => {
    const c = compilePreset(pulseLikeSpec({ repeat: Infinity }));
    expect(presetTotalDuration(c)).toBe(Infinity);
    const v = samplePreset(c, 1e9 + 0.25);
    expect(Number.isFinite(v.scale!)).toBe(true);
  });
});

// ── А: хостильное время ──────────────────────────────────────────────────────

describe('presets — samplePreset: хостильное t', () => {
  it('А: NaN → поза t=0; -Infinity → поза t=0; +Infinity → финал', () => {
    const c = compilePreset({
      duration: 1,
      tracks: [{ property: 'x', values: [3, 10] }],
    });
    expect(samplePreset(c, Number.NaN).x).toBe(3);
    expect(samplePreset(c, -Infinity).x).toBe(3);
    expect(samplePreset(c, Infinity).x).toBe(10);
    expect(samplePreset(c, -5).x).toBe(3);
  });

  it('А: NaN в reverse-режиме делегируется каноническому cursor и даёт позу t=0', () => {
    // Пинит общую границу владения временем: repeat-cursor нормализует
    // hostile time до выбора чётности reverse-итерации.
    const c = compilePreset({
      duration: 1,
      tracks: [{ property: 'x', values: [3, 10] }],
      repeat: 1,
      repeatType: 'reverse',
    });
    expect(samplePreset(c, Number.NaN).x).toBe(3);
  });
});

// ── В: детерминизм и конечность (fuzz) ──────────────────────────────────────

describe('presets — samplePreset: детерминизм и конечность', () => {
  it('В: бит-идентичность повторного прогона (детерминизм)', () => {
    const c = compilePreset({
      duration: 2.7,
      tracks: [
        { property: 'scale', values: [1, 1.12, 0.96, 1] },
        { property: 'rotate', values: [0, 8, -6, 0] },
      ],
      repeat: 3,
      repeatType: 'reverse',
      delay: 0.3,
    });
    const ts: number[] = [];
    for (let i = 0; i <= 500; i++) ts.push((i / 500) * 12);
    const runA = ts.map((t) => samplePreset(c, t));
    const runB = ts.map((t) => samplePreset(c, t));
    expect(runA).toEqual(runB);
  });

  it('В: fuzz 10k+ хостильных входов — выход ВСЕГДА конечен', () => {
    // Конечность несёт sampleKeyframes (overflow-guard `isFinite(value) ? value : to`).
    // Mutation proof: в src/internal/sample-keyframes.ts заменить finite-result guard
    // на `return value` → overflow-спека [-MAX, MAX, 0] даёт ±Infinity → RED здесь.
    const hostileT = [
      Number.NaN,
      Infinity,
      -Infinity,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      1e308,
      -1e308,
      0,
      -0,
    ];
    const specs: PresetSpec[] = [
      pulseLikeSpec(),
      pulseLikeSpec({ repeat: Infinity }),
      pulseLikeSpec({ repeat: 2, repeatType: 'reverse', repeatDelay: 0.25 }),
      {
        // overflow-края: range = MAX - (-MAX) → ±Infinity внутри интерполяции
        duration: 1,
        tracks: [{ property: 'x', values: [-Number.MAX_VALUE, Number.MAX_VALUE, 0] }],
      },
      {
        duration: 1e-6,
        tracks: [{ property: 'progress', values: [0, 1] }],
        repeat: 1000,
      },
    ];
    // seed-less детерминированный LCG — без Math.random (дисциплина репо)
    let seed = 0x1234_5678;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffff_ffff;
    };
    let checked = 0;
    for (const spec of specs) {
      const c = compilePreset(spec);
      for (const t of hostileT) {
        if (c.repeat === Infinity && (t === Infinity || t === Number.MAX_VALUE || t === 1e308)) {
          expect(() => samplePreset(c, t)).toThrowError(/^LM166$/);
          continue;
        }
        const v = samplePreset(c, t);
        for (const key of Object.keys(v) as (keyof typeof v)[]) {
          expect(Number.isFinite(v[key]!)).toBe(true);
          checked++;
        }
      }
      for (let i = 0; i < 2500; i++) {
        const t = (next() - 0.5) * 2e9;
        const v = samplePreset(c, t);
        for (const key of Object.keys(v) as (keyof typeof v)[]) {
          expect(Number.isFinite(v[key]!)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});
