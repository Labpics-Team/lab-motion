/**
 * test/tokens.test.ts — motion-токены (M3): пины значений/имён + контракты.
 * Классы: contract (api-surface + пины значений — токен есть КОНТРАКТ, тихий
 * сдвиг значения ломает потребителя), А (известные числа distanceScale),
 * В (финитность-фазз, монотонность), Д (mutation-хуки в клэмпе/полосе).
 *
 * ── RED PROOF ──
 * - Сдвинуть duration.normal 250→240 → пин RED.
 * - Сменить easing.standard css/координаты → пин RED.
 * - Сломать клэмп distanceScale (убрать t>1 ветку) → «клэмп к max» RED.
 * - Сделать пружину-пресет неоседающей → «пресеты валидны» RED.
 * - Добавить/убрать экспорт → api-surface RED.
 */

import { describe, expect, it } from 'vitest';
import * as tokens from '../src/tokens/index.js';
import {
  duration,
  easing,
  spring,
  staggerGap,
  distanceScale,
  distanceScaleConfig,
} from '../src/tokens/index.js';
import { spring as springPhysics, type SpringParams } from '../src/spring.js';

// ─── api-surface-pin ─────────────────────────────────────────────────────────

describe('tokens: api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов (типы стёрты)', () => {
    expect(Object.keys(tokens).sort()).toEqual([
      'distanceScale',
      'distanceScaleConfig',
      'duration',
      'easing',
      'spring',
      'staggerGap',
    ]);
  });
});

// ─── Длительности: пины значений и имён ──────────────────────────────────────

describe('tokens: duration — пины значений/имён', () => {
  it('точные значения шкалы (мс)', () => {
    expect(duration).toEqual({
      instant: 0,
      fast: 150,
      normal: 250,
      slow: 400,
      slower: 600,
    });
  });

  it('шкала строго возрастает (кроме instant=0)', () => {
    const vals = [duration.instant, duration.fast, duration.normal, duration.slow, duration.slower];
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]!);
  });
});

// ─── Изинги: имена, css-строки, эндпоинты fn ─────────────────────────────────

describe('tokens: easing — пины координат/имён + fn-эндпоинты', () => {
  it('точные css cubic-bezier() строки (в духе Material/Fluent)', () => {
    expect(easing.standard.css).toBe('cubic-bezier(0.33, 0, 0.67, 1)');
    expect(easing.entrance.css).toBe('cubic-bezier(0, 0, 0.2, 1)');
    expect(easing.exit.css).toBe('cubic-bezier(0.4, 0, 1, 1)');
    expect(easing.emphasized.css).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });

  it('ровно эти имена изинг-токенов', () => {
    expect(Object.keys(easing).sort()).toEqual(['emphasized', 'entrance', 'exit', 'standard']);
  });

  it('каждый fn: эндпоинты 0→0, 1→1, монотонно неубывает, финитен в [0,1]', () => {
    for (const name of Object.keys(easing) as (keyof typeof easing)[]) {
      const fn = easing[name].fn;
      expect(fn(0)).toBeCloseTo(0, 6);
      expect(fn(1)).toBeCloseTo(1, 6);
      let prev = -Infinity;
      for (let k = 0; k <= 50; k++) {
        const y = fn(k / 50);
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9); // неубывание (позиционный изинг)
        prev = y;
      }
    }
  });

  it('не кричащие: значения fn в [0,1] не вылетают за [−ε, 1+ε] (без overshoot/bounce)', () => {
    for (const name of Object.keys(easing) as (keyof typeof easing)[]) {
      const fn = easing[name].fn;
      for (let k = 0; k <= 100; k++) {
        const y = fn(k / 100);
        expect(y).toBeGreaterThanOrEqual(-0.001);
        expect(y).toBeLessThanOrEqual(1.001);
      }
    }
  });
});

// ─── Пружины-пресеты: пины + валидность (оседают) ────────────────────────────

describe('tokens: spring — пресеты валидны и запинены', () => {
  it('точные параметры пресетов', () => {
    expect(spring.default).toEqual({ mass: 1, stiffness: 170, damping: 26 });
    expect(spring.gentle).toEqual({ mass: 1, stiffness: 120, damping: 30 });
    expect(spring.snappy).toEqual({ mass: 1, stiffness: 260, damping: 28 });
    expect(spring.bounce).toEqual({ mass: 1, stiffness: 180, damping: 12 });
  });

  it('каждый пресет проходит валидатор ядра (оседает — spring() не бросает)', () => {
    for (const name of Object.keys(spring) as (keyof typeof spring)[]) {
      const p: SpringParams = spring[name];
      expect(() => springPhysics(p, 0.1)).not.toThrow();
    }
  });

  it('дефолт НЕ пружинистый (пренебрежимый overshoot), bounce — единственный underdamped', () => {
    // Критерий overshoot: 2√(k·m) — граница критич. демпфирования; damping < этого = underdamped.
    const critical = (p: SpringParams): number => 2 * Math.sqrt(p.stiffness * p.mass);
    // default/gentle/snappy — около/над критич. (спокойные), bounce — заметно ниже.
    expect(spring.bounce.damping).toBeLessThan(critical(spring.bounce) * 0.6); // явно пружинит
    expect(spring.default.damping).toBeGreaterThan(critical(spring.default) * 0.9); // почти критичен
  });
});

// ─── staggerGap: пины ────────────────────────────────────────────────────────

describe('tokens: staggerGap — пины значений/имён', () => {
  it('точные значения шага каскада (мс)', () => {
    expect(staggerGap).toEqual({ tight: 20, normal: 40, loose: 70 });
  });
});

// ─── distanceScale: известные числа + клэмп + финитность ─────────────────────

describe('tokens: distanceScale — травел → длительность', () => {
  it('дефолтная полоса: границы и середина (известные числа)', () => {
    expect(distanceScale(0)).toBe(150); // minDuration
    expect(distanceScale(400)).toBe(400); // maxDuration
    expect(distanceScale(200)).toBe(275); // 150 + 0.5·250
    expect(distanceScale(100)).toBe(212.5); // 150 + 0.25·250
  });

  it('клэмп вне полосы (за max → maxDuration; |отриц| внутрь)', () => {
    expect(distanceScale(999)).toBe(400); // клэмп сверху
    expect(distanceScale(-100)).toBe(distanceScale(100)); // |·| симметрия
  });

  it('монотонно неубывает по травелу', () => {
    let prev = -Infinity;
    for (let d = 0; d <= 500; d += 10) {
      const ms = distanceScale(d);
      expect(ms).toBeGreaterThanOrEqual(prev);
      prev = ms;
    }
  });

  it('финитность: враждебный вход (NaN/∞) → граница, не NaN', () => {
    expect(distanceScale(NaN)).toBe(150); // → d=0 → minDuration
    expect(distanceScale(Infinity)).toBe(150); // не финитен → d=0
    expect(distanceScale(-Infinity)).toBe(150);
    expect(Number.isFinite(distanceScale(12345))).toBe(true);
  });

  it('вырожденная/невалидная полоса (max<=min) → minDuration (без деления на ~0)', () => {
    const cfg: tokens.DistanceScaleConfig = { minDistance: 5, maxDistance: 5, minDuration: 100, maxDuration: 300 };
    expect(distanceScale(50, cfg)).toBe(100);
    const inverted: tokens.DistanceScaleConfig = { minDistance: 400, maxDistance: 100, minDuration: 100, maxDuration: 300 };
    expect(distanceScale(200, inverted)).toBe(100);
  });

  it('кастомная полоса интерполирует линейно', () => {
    const cfg: tokens.DistanceScaleConfig = { minDistance: 0, maxDistance: 100, minDuration: 0, maxDuration: 1000 };
    expect(distanceScale(50, cfg)).toBe(500);
    expect(distanceScale(25, cfg)).toBe(250);
  });

  it('дефолтный конфиг привязан к duration.fast/slow', () => {
    expect(distanceScaleConfig.minDuration).toBe(duration.fast);
    expect(distanceScaleConfig.maxDuration).toBe(duration.slow);
  });
});
