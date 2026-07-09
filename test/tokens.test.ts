/**
 * test/tokens.test.ts — motion-токены: пины значений/имён + контракты SSOT.
 * Классы: contract (api-surface + пины значений — токен есть КОНТРАКТ, тихий
 * сдвиг значения ломает потребителя; пересечение имён с ДС-схемой labui обязано
 * совпадать байт-в-байт), А (известные числа distanceScale, формулы канонической
 * пары), В (финитность-фазз, монотонность), Д (mutation-хуки в клэмпе/полосе).
 *
 * ── RED PROOF ──
 * - Сдвинуть duration.base 200→190 → пин RED.
 * - Сменить easing.standard css/координаты → пин RED.
 * - Разъехаться с формулой SSOT в springFromDurationBounce → «формулы» RED.
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
  springFromDurationBounce,
  staggerGap,
  distanceScale,
  distanceScaleConfig,
} from '../src/tokens/index.js';
import { spring as springPhysics, type SpringParams } from '../src/spring.js';
import { MotionParamError } from '../src/errors.js';

// ─── api-surface-pin ─────────────────────────────────────────────────────────

describe('tokens: api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов (типы стёрты)', () => {
    expect(Object.keys(tokens).sort()).toEqual([
      'distanceScale',
      'distanceScaleConfig',
      'duration',
      'easing',
      'spring',
      'springFromDurationBounce',
      'staggerGap',
    ]);
  });
});

// ─── Длительности: пины значений и имён (SSOT labui) ─────────────────────────

describe('tokens: duration — пины значений/имён (= SSOT labui)', () => {
  it('точные значения шкалы (мс): спайн 100/200/300/500', () => {
    expect(duration).toEqual({
      instant: 0,
      fast: 100,
      base: 200,
      slow: 300,
      slower: 500,
    });
  });

  it('шкала строго возрастает (кроме instant=0)', () => {
    const vals = [duration.instant, duration.fast, duration.base, duration.slow, duration.slower];
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]!);
  });
});

// ─── Изинги: имена, css-строки, эндпоинты fn (SSOT labui / M3 official) ──────

describe('tokens: easing — пины координат/имён + fn-эндпоинты', () => {
  it('точные css cubic-bezier() строки (= SSOT labui, официальные кривые M3)', () => {
    expect(easing.standard.css).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(easing.decelerate.css).toBe('cubic-bezier(0, 0, 0, 1)');
    expect(easing.accelerate.css).toBe('cubic-bezier(0.3, 0, 1, 1)');
    expect(easing.emphasized.css).toBe('cubic-bezier(0.38, 1.21, 0.22, 1)');
  });

  it('ровно эти имена изинг-токенов', () => {
    expect(Object.keys(easing).sort()).toEqual([
      'accelerate',
      'decelerate',
      'emphasized',
      'standard',
    ]);
  });

  it('каждый fn: эндпоинты 0→0, 1→1, финитен в [0,1]', () => {
    for (const name of Object.keys(easing) as (keyof typeof easing)[]) {
      const fn = easing[name].fn;
      expect(fn(0)).toBeCloseTo(0, 6);
      expect(fn(1)).toBeCloseTo(1, 6);
      for (let k = 0; k <= 50; k++) {
        expect(Number.isFinite(fn(k / 50))).toBe(true);
      }
    }
  });

  it('сдержанные кривые (standard/decelerate/accelerate): монотонны, без overshoot', () => {
    for (const name of ['standard', 'decelerate', 'accelerate'] as const) {
      const fn = easing[name].fn;
      let prev = -Infinity;
      for (let k = 0; k <= 100; k++) {
        const y = fn(k / 100);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9); // неубывание
        expect(y).toBeGreaterThanOrEqual(-0.001);
        expect(y).toBeLessThanOrEqual(1.001); // БЕЗ overshoot
        prev = y;
      }
    }
  });

  it('emphasized — ЕДИНСТВЕННЫЙ overshoot: превышает 1, сдержан (≤ 6%), садится в 1', () => {
    const fn = easing.emphasized.fn;
    let peak = -Infinity;
    for (let k = 0; k <= 200; k++) {
      const y = fn(k / 200);
      expect(y).toBeGreaterThanOrEqual(-0.001); // вниз не ныряет
      if (y > peak) peak = y;
    }
    expect(peak).toBeGreaterThan(1); // overshoot существует…
    expect(peak).toBeLessThanOrEqual(1.06); // …и сдержан (не кричит)
    expect(fn(1)).toBeCloseTo(1, 6); // посадка точно в цель
  });
});

// ─── Каноническая пара (duration, bounce): формулы SSOT + валидация ──────────

describe('tokens: springFromDurationBounce — формулы SSOT и грани', () => {
  it('вывод физической тройки — в точности формулы ДС-схемы labui', () => {
    // ζ = 1 − bounce; m = 1; ω₀ = 2π/duration; k = ω₀²·m; c = 2·ζ·ω₀·m
    for (const [durationS, bounce] of [
      [0.35, 0],
      [0.5, 0.3],
      [1, 0.5],
      [0.2, 0],
    ] as const) {
      const omega0 = (2 * Math.PI) / durationS;
      const p = springFromDurationBounce(durationS, bounce);
      expect(p.mass).toBe(1);
      expect(p.stiffness).toBe(omega0 * omega0);
      expect(p.damping).toBe(2 * (1 - bounce) * omega0);
    }
  });

  it('bounce=0 — критическое демпфирование: c = 2√(k·m) точно', () => {
    const p = springFromDurationBounce(0.35, 0);
    expect(p.damping).toBeCloseTo(2 * Math.sqrt(p.stiffness * p.mass), 12);
  });

  it('детерминизм: одинаковый вход → бит-идентичный выход', () => {
    expect(springFromDurationBounce(0.5, 0.3)).toEqual(springFromDurationBounce(0.5, 0.3));
  });

  it('выход принимается солвером ядра (spring() не бросает)', () => {
    const p = springFromDurationBounce(0.5, 0.3);
    expect(() => springPhysics(p, 0.1)).not.toThrow();
  });

  it('враждебный вход → MotionParamError (никаких NaN наружу)', () => {
    for (const [d, b] of [
      [0, 0],
      [-1, 0],
      [NaN, 0],
      [Infinity, 0],
      [0.5, -0.1],
      [0.5, 1], // ζ=0 — вечный звон, в live-движке непредставим
      [0.5, 1.5],
      [0.5, NaN],
    ] as const) {
      expect(() => springFromDurationBounce(d, b)).toThrow(MotionParamError);
    }
  });
});

// ─── Пружины-пресеты: пины + валидность (оседают) ────────────────────────────

describe('tokens: spring — пресеты валидны и запинены', () => {
  it('точные параметры движковых пресетов', () => {
    expect(spring.default).toEqual({ mass: 1, stiffness: 170, damping: 26 });
    expect(spring.gentle).toEqual({ mass: 1, stiffness: 120, damping: 30 });
    expect(spring.snappy).toEqual({ mass: 1, stiffness: 260, damping: 28 });
    expect(spring.bounce).toEqual({ mass: 1, stiffness: 180, damping: 12 });
  });

  it('ДС-пресеты smooth/expressive = каноническая пара SSOT (не дублируют значения)', () => {
    expect(spring.smooth).toEqual(springFromDurationBounce(0.35, 0));
    expect(spring.expressive).toEqual(springFromDurationBounce(0.5, 0.3));
  });

  it('каждый пресет проходит валидатор ядра (оседает — spring() не бросает)', () => {
    for (const name of Object.keys(spring) as (keyof typeof spring)[]) {
      const p: SpringParams = spring[name];
      expect(() => springPhysics(p, 0.1)).not.toThrow();
    }
  });

  it('дефолт и smooth НЕ пружинистые; bounce/expressive — underdamped (opt-in)', () => {
    // Критерий overshoot: 2√(k·m) — граница критич. демпфирования; damping < этого = underdamped.
    const critical = (p: SpringParams): number => 2 * Math.sqrt(p.stiffness * p.mass);
    expect(spring.bounce.damping).toBeLessThan(critical(spring.bounce) * 0.6); // явно пружинит
    expect(spring.expressive.damping).toBeCloseTo(critical(spring.expressive) * 0.7, 9); // ζ=0.7
    expect(spring.default.damping).toBeGreaterThan(critical(spring.default) * 0.9); // почти критичен
    expect(spring.smooth.damping).toBeCloseTo(critical(spring.smooth), 9); // ζ=1 точно
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
    expect(distanceScale(0)).toBe(100); // minDuration
    expect(distanceScale(400)).toBe(300); // maxDuration
    expect(distanceScale(200)).toBe(200); // 100 + 0.5·200
    expect(distanceScale(100)).toBe(150); // 100 + 0.25·200
  });

  it('клэмп вне полосы (за max → maxDuration; |отриц| внутрь)', () => {
    expect(distanceScale(999)).toBe(300); // клэмп сверху
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
    expect(distanceScale(NaN)).toBe(100); // → d=0 → minDuration
    expect(distanceScale(Infinity)).toBe(100); // не финитен → d=0
    expect(distanceScale(-Infinity)).toBe(100);
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
