/**
 * test/waapi-emit.test.ts — WAAPI-эмит (subpath ./waapi, S11).
 * Классы: А (известные числа маппинга) + В (fuzz/differential против
 * sampleKeyframes) + Д (mutation-хуки в формулах маппинга).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падают все поведенческие блоки.
 * Mutation-proof: сломать iterations=repeat+1 (→repeat) → «repeat=2 → iterations=3»
 * RED; сломать маппинг 'reverse'→'alternate' → таблица направлений RED; сломать
 * масштаб offsets при repeatDelay → «hold-запекание» RED; сломать клауза
 * равноудалённых стопов linear() → известные числа easingToLinear RED.
 *
 * Заземление (MDN, точные цитаты в Graphiti research «S11 WAAPI»):
 * - per-keyframe easing действует «от этого кейфрейма до следующего» — 1:1 с
 *   нашей per-segment моделью;
 * - offset ∈ [0,1] по возрастанию;
 * - iterations = ПОЛНОЕ число проигрываний (наш repeat = дополнительные);
 * - у WAAPI НЕТ per-iteration delay → repeatDelay запекается hold-сегментом;
 * - CSS linear(): равноудалённые стопы не требуют процентов.
 */

import { describe, expect, it } from 'vitest';
import * as waapi from '../src/waapi/index.js';
import { animateWaapi, compileWaapi, easingToLinear, supportsWaapi } from '../src/waapi/index.js';
import { MotionParamError } from '../src/index.js';
import { sampleKeyframes } from '../src/keyframes/index.js';
import { easeOut } from '../src/easing/index.js';

// ─── easingToLinear ──────────────────────────────────────────────────────────

describe('waapi: easingToLinear', () => {
  it('identity на 5 точках → равноудалённые стопы без процентов', () => {
    expect(easingToLinear((t) => t, 5)).toBe('linear(0, 0.25, 0.5, 0.75, 1)');
  });

  it('эндпоинты берутся из fn(0)/fn(1) и округляются до 4 знаков', () => {
    const s = easingToLinear(easeOut, 3);
    expect(s.startsWith('linear(0, ')).toBe(true);
    expect(s.endsWith(', 1)')).toBe(true);
    // easeOut(0.5) = 1 − 0.5³ = 0.875
    expect(s).toBe('linear(0, 0.875, 1)');
  });

  it('враждебный easing (NaN/Infinity изнутри) → все значения конечны (NE1)', () => {
    const evil = (t: number): number => (t < 0.3 ? NaN : t < 0.7 ? Infinity : t);
    const s = easingToLinear(evil, 9);
    expect(s).toMatch(/^linear\([^)]+\)$/);
    for (const v of s.slice(7, -1).split(', ')) {
      expect(Number.isFinite(Number(v))).toBe(true);
    }
  });

  it('детерминизм: две генерации бит-в-бит', () => {
    expect(easingToLinear(easeOut)).toBe(easingToLinear(easeOut));
  });

  it('невалидное число точек → MotionParamError', () => {
    for (const points of [1, 0, -3, 2.5, NaN, Infinity]) {
      expect(() => easingToLinear((t) => t, points)).toThrow(MotionParamError);
    }
  });
});

// ─── compileWaapi: известные числа ───────────────────────────────────────────

describe('waapi: compileWaapi — маппинг известных чисел', () => {
  it('values+duration → offsets/duration_ms/iterations/direction по умолчанию', () => {
    const r = compileWaapi({ property: 'opacity', values: [0, 1], duration: 2 });
    expect(r.keyframes).toEqual([
      { offset: 0, opacity: 0 },
      { offset: 1, opacity: 1 },
    ]);
    expect(r.timing.duration).toBe(2000); // секунды движка → миллисекунды WAAPI
    expect(r.timing.iterations).toBe(1);
    expect(r.timing.direction).toBe('normal');
    expect(r.timing.fill).toBe('both');
  });

  it('times прокидываются в offset как есть', () => {
    const r = compileWaapi({
      property: 'opacity',
      values: [0, 0.9, 1],
      times: [0, 0.8, 1],
      duration: 1,
    });
    expect(r.keyframes.map((k) => k.offset)).toEqual([0, 0.8, 1]);
  });

  it('times по умолчанию — равномерное распределение', () => {
    const r = compileWaapi({ property: 'x', values: [0, 5, 10, 20], duration: 1 });
    expect(r.keyframes.map((k) => k.offset)).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it('per-segment easing → per-keyframe easing на всех, кроме последнего', () => {
    const r = compileWaapi({
      property: 'opacity',
      values: [0, 0.5, 1],
      duration: 1,
      easing: [(t) => t, easeOut],
      easingPoints: 3,
    });
    expect(r.keyframes[0]!['easing']).toBe('linear(0, 0.5, 1)');
    expect(r.keyframes[1]!['easing']).toBe('linear(0, 0.875, 1)');
    expect('easing' in r.keyframes[2]!).toBe(false);
  });

  it('один общий easing применяется ко всем сегментам', () => {
    const r = compileWaapi({
      property: 'opacity',
      values: [0, 0.5, 1],
      duration: 1,
      easing: easeOut,
      easingPoints: 3,
    });
    expect(r.keyframes[0]!['easing']).toBe('linear(0, 0.875, 1)');
    expect(r.keyframes[1]!['easing']).toBe('linear(0, 0.875, 1)');
  });

  it('repeat → iterations = repeat + 1 (наш repeat = дополнительные повторы)', () => {
    expect(compileWaapi({ property: 'o', values: [0, 1], duration: 1, repeat: 2 }).timing.iterations).toBe(3);
    expect(compileWaapi({ property: 'o', values: [0, 1], duration: 1, repeat: 0 }).timing.iterations).toBe(1);
    expect(
      compileWaapi({ property: 'o', values: [0, 1], duration: 1, repeat: Infinity }).timing.iterations,
    ).toBe(Infinity);
  });

  it("repeatType: 'loop'→'normal', 'reverse'/'mirror'→'alternate'", () => {
    const dir = (repeatType: 'loop' | 'reverse' | 'mirror') =>
      compileWaapi({ property: 'o', values: [0, 1], duration: 1, repeat: 1, repeatType }).timing.direction;
    expect(dir('loop')).toBe('normal');
    expect(dir('reverse')).toBe('alternate');
    expect(dir('mirror')).toBe('alternate');
  });

  it('format форматирует значения (числа → строки с единицами)', () => {
    const r = compileWaapi({
      property: 'transform',
      values: [0, 10],
      duration: 1,
      format: (v) => `translateX(${v}px)`,
    });
    expect(r.keyframes[0]!['transform']).toBe('translateX(0px)');
    expect(r.keyframes[1]!['transform']).toBe('translateX(10px)');
  });
});

// ─── compileWaapi: hold-запекание repeatDelay ────────────────────────────────

describe('waapi: repeatDelay → hold-сегмент (у WAAPI нет per-iteration delay)', () => {
  it('loop: duration растягивается, offsets масштабируются, хвост держит значение', () => {
    const r = compileWaapi({
      property: 'opacity',
      values: [0, 1],
      duration: 1,
      repeat: 1,
      repeatDelay: 1,
    });
    expect(r.timing.duration).toBe(2000); // (1s движения + 1s hold) в мс
    const offs = r.keyframes.map((k) => k.offset);
    expect(offs).toEqual([0, 0.5, 1]); // движение сжато в первую половину
    expect(r.keyframes[1]!['opacity']).toBe(1);
    expect(r.keyframes[2]!['opacity']).toBe(1); // hold той же величины
  });

  it('repeatDelay без repeat не запекается (нет следующего цикла — нечего ждать)', () => {
    const r = compileWaapi({ property: 'o', values: [0, 1], duration: 1, repeatDelay: 1 });
    expect(r.timing.duration).toBe(1000);
    expect(r.keyframes.map((k) => k.offset)).toEqual([0, 1]);
  });

  it('reverse/mirror + repeatDelay>0 → MotionParamError рано (честная граница)', () => {
    for (const repeatType of ['reverse', 'mirror'] as const) {
      expect(() =>
        compileWaapi({
          property: 'o',
          values: [0, 1],
          duration: 1,
          repeat: 1,
          repeatType,
          repeatDelay: 0.5,
        }),
      ).toThrow(MotionParamError);
    }
  });
});

// ─── compileWaapi: валидация ─────────────────────────────────────────────────

describe('waapi: compileWaapi — невалидные входы → MotionParamError', () => {
  const base = { property: 'opacity', values: [0, 1] as readonly number[], duration: 1 };

  it('values: длина < 2, не-конечные', () => {
    expect(() => compileWaapi({ ...base, values: [1] })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, values: [0, NaN] })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, values: [0, Infinity] })).toThrow(MotionParamError);
  });

  it('times: несовпадение длины, невозрастание, границы не 0/1', () => {
    expect(() => compileWaapi({ ...base, times: [0] })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, times: [0.2, 1] })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, times: [0, 0.5] })).toThrow(MotionParamError);
    expect(() =>
      compileWaapi({ ...base, values: [0, 1, 2], times: [0, 0.8, 0.7] as number[] }),
    ).toThrow(MotionParamError);
    // Дип ВНУТРИ при валидных границах — ловится именно проверкой неубывания,
    // а не проверкой границ (класс, слепой для кейса выше).
    expect(() =>
      compileWaapi({ ...base, values: [0, 1, 2, 3], times: [0, 0.9, 0.3, 1] as number[] }),
    ).toThrow(MotionParamError);
  });

  it('сегменты нулевой ширины (совпадающие times) валидны и эмитятся как есть', () => {
    const r = compileWaapi({
      ...base,
      values: [0, 10, 20, 30],
      times: [0, 0.5, 0.5, 1] as number[],
    });
    expect(r.keyframes.map((k) => k.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(r.keyframes[1]!['opacity']).toBe(10);
    expect(r.keyframes[2]!['opacity']).toBe(20); // мгновенный переход в одном offset
  });

  it('duration/repeat/repeatDelay/property/easing', () => {
    expect(() => compileWaapi({ ...base, duration: 0 })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, duration: NaN })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, repeat: -1 })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, repeat: 1.5 })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, repeatDelay: -0.1 })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, property: '' })).toThrow(MotionParamError);
    expect(() => compileWaapi({ ...base, easing: [(t: number) => t] })).not.toThrow(); // 1 easing на 1 сегмент — валидно
    expect(() =>
      compileWaapi({ ...base, values: [0, 1, 2], easing: [(t: number) => t] }),
    ).toThrow(MotionParamError); // 1 easing на 2 сегмента
  });
});

// ─── Differential против sampleKeyframes (класс В) ───────────────────────────

describe('waapi: differential — значения в стопах совпадают с sampleKeyframes', () => {
  it('в каждом offset значение кейфрейма = sampleKeyframes(p=offset)', () => {
    const values = [0, 40, 10, 100];
    const times = [0, 0.25, 0.6, 1];
    const r = compileWaapi({ property: 'x', values, times, duration: 2 });
    for (let i = 0; i < values.length; i++) {
      const fromEngine = sampleKeyframes(values, times, [(t) => t, (t) => t, (t) => t], times[i]!);
      expect(r.keyframes[i]!['x']).toBe(fromEngine);
    }
  });
});

describe('waapi: differential — интерьер сегмента против rAF-пути', () => {
  it('linear()-аппроксимация ≈ sampleKeyframes с реальным easing (допуск сетки 33 точек)', () => {
    // Оба пути обязаны давать одну кривую: rAF-путь считает easing точно,
    // WAAPI-путь — кусочно-линейно по 33 стопам. Погрешность аппроксимации
    // кубика на шаге 1/32: h²/8·max|f''| ≈ 7.3e-4 → на шкале 0..100 это <0.1.
    const values = [0, 100];
    const times = [0, 1];
    const r = compileWaapi({ property: 'x', values, times, duration: 1, easing: easeOut });
    const linearStops = (r.keyframes[0]!['easing'] as string)
      .slice(7, -1)
      .split(', ')
      .map(Number);
    const sampleLinear = (t: number): number => {
      const pos = t * (linearStops.length - 1);
      const i = Math.min(Math.floor(pos), linearStops.length - 2);
      const frac = pos - i;
      return linearStops[i]! + (linearStops[i + 1]! - linearStops[i]!) * frac;
    };
    for (const p of [0.1, 0.25, 0.5, 0.77, 0.9]) {
      const waapiValue = values[0]! + (values[1]! - values[0]!) * sampleLinear(p);
      const rafValue = sampleKeyframes(values, times, [easeOut], p);
      expect(Math.abs(waapiValue - rafValue)).toBeLessThan(0.1);
    }
  });
});

// ─── fuzz (класс В) ──────────────────────────────────────────────────────────

describe('waapi: fuzz — инварианты на злых валидных входах', () => {
  it('200 сценариев: offsets неубывающие в [0,1], первый=0, последний=1, значения конечны', () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 200; n++) {
      const len = 2 + Math.floor(rnd() * 6);
      const values = Array.from({ length: len }, () => (rnd() - 0.5) * 2e5);
      const r = compileWaapi({
        property: 'x',
        values,
        duration: 0.01 + rnd() * 100,
        repeat: n % 3 === 0 ? Math.floor(rnd() * 5) : 0,
        repeatDelay: n % 3 === 0 ? rnd() : 0,
      });
      const offs = r.keyframes.map((k) => k.offset as number);
      expect(offs[0]).toBe(0);
      expect(offs[offs.length - 1]).toBe(1);
      for (let i = 1; i < offs.length; i++) expect(offs[i]!).toBeGreaterThanOrEqual(offs[i - 1]!);
      for (const k of r.keyframes) expect(Number.isFinite(k['x'] as number)).toBe(true);
      expect(Number.isFinite(r.timing.duration)).toBe(true);
      expect(r.timing.duration).toBeGreaterThan(0);
    }
  });
});

// ─── supportsWaapi / animateWaapi ────────────────────────────────────────────

describe('waapi: supportsWaapi (duck-typing, SSR-safe)', () => {
  it('node env без цели → false (Element не существует)', () => {
    expect(supportsWaapi()).toBe(false);
  });

  it('цель с animate-функцией → true; без — false', () => {
    expect(supportsWaapi({ animate: () => ({}) })).toBe(true);
    expect(supportsWaapi({})).toBe(false);
    expect(supportsWaapi(null)).toBe(false);
    expect(supportsWaapi(42)).toBe(false);
  });

  it('свойство animate есть, но не вызываемо → false (класс не-функций)', () => {
    expect(supportsWaapi({ animate: 42 })).toBe(false);
    expect(supportsWaapi({ animate: 'not-a-fn' })).toBe(false);
    expect(supportsWaapi({ animate: {} })).toBe(false);
  });
});

describe('waapi: animateWaapi — тонкий адаптер', () => {
  function fakeElement() {
    const calls: { keyframes: unknown; timing: unknown }[] = [];
    const animation = { id: 'fake-animation' };
    return {
      calls,
      animation,
      el: {
        animate(keyframes: unknown, timing: unknown) {
          calls.push({ keyframes, timing });
          return animation;
        },
      },
    };
  }

  it('компилирует и вызывает el.animate, возвращает нативный Animation', () => {
    const f = fakeElement();
    const a = animateWaapi(f.el, { property: 'opacity', values: [0, 1], duration: 1 });
    expect(a).toBe(f.animation);
    expect(f.calls).toHaveLength(1);
    const { keyframes, timing } = f.calls[0]! as {
      keyframes: Record<string, unknown>[];
      timing: Record<string, unknown>;
    };
    expect(keyframes[0]!['opacity']).toBe(0);
    expect(timing['duration']).toBe(1000);
    expect(timing['fill']).toBe('both');
  });

  it('fill переопределяем', () => {
    const f = fakeElement();
    animateWaapi(f.el, { property: 'o', values: [0, 1], duration: 1, fill: 'forwards' });
    expect((f.calls[0]!.timing as Record<string, unknown>)['fill']).toBe('forwards');
  });

  it('цель без animate → MotionParamError рано, до компиляции', () => {
    expect(() =>
      animateWaapi({} as never, { property: 'o', values: [0, 1], duration: 1 }),
    ).toThrow(MotionParamError);
  });
});

// ─── Детерминизм и поверхность ───────────────────────────────────────────────

describe('waapi: детерминизм', () => {
  it('compileWaapi дважды от одного входа → структурно идентично', () => {
    const opts = {
      property: 'opacity',
      values: [0, 0.7, 1],
      duration: 1.5,
      easing: easeOut,
      repeat: 2,
      repeatDelay: 0.3,
    };
    expect(JSON.stringify(compileWaapi(opts))).toBe(JSON.stringify(compileWaapi(opts)));
  });
});

describe('waapi-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(waapi).sort()).toEqual([
      'animateWaapi',
      'compileWaapi',
      'easingToLinear',
      'supportsWaapi',
    ]);
  });

  it('SSR: import + чистые вызовы в node env не бросают (window/document не существуют)', () => {
    expect(() => {
      easingToLinear((t) => t, 3);
      compileWaapi({ property: 'o', values: [0, 1], duration: 1 });
      supportsWaapi();
    }).not.toThrow();
  });
});
