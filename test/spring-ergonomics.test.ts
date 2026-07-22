/**
 * test/spring-ergonomics.test.ts — эргономика пружин (subpath ./spring).
 * Классы: А (маппинг с известными числами) + В (fuzz/поведенческие свойства) + Д.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый поведенческий блок своим ассертом.
 * Mutation-proof: сломать ζ=1−bounce (→1+bounce) → «bounce=0 критическое
 * демпфирование» RED; сломать ω0=2π/T → «известные числа T=1s» RED;
 * подменить пресет → пин пресетов RED.
 */

import { describe, expect, it } from 'vitest';
import * as ergo from '../src/spring/index.js';
import { fromBounce, fromVisualDuration, springPresets, springAsEasing } from '../src/spring/index.js';
import { spring, validateSpringParams, MotionParamError } from '../src/index.js';

// ─── fromBounce (канон SwiftUI/Motion: ζ = 1 − bounce, ω0 = 2π/duration) ─────

describe('spring-ergonomics: fromBounce — известные числа', () => {
  it('T=1s, bounce=0 → критическое демпфирование: k=(2π)², c=2√k', () => {
    const p = fromBounce({ duration: 1, bounce: 0 });
    expect(p.mass).toBe(1);
    expect(p.stiffness).toBeCloseTo((2 * Math.PI) ** 2, 4); // ≈ 39.478
    expect(p.damping).toBeCloseTo(2 * Math.sqrt(p.stiffness), 4); // ζ = 1
  });

  it('bounce=0.5 → ζ=0.5 (демпфирование вдвое ниже критического)', () => {
    const p = fromBounce({ duration: 1, bounce: 0.5 });
    const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
    expect(zeta).toBeCloseTo(0.5, 4);
  });

  it('bounce=-0.5 → ζ=1.5 (пере-демпфированная «плоская» пружина)', () => {
    const p = fromBounce({ duration: 1, bounce: -0.5 });
    const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
    expect(zeta).toBeCloseTo(1.5, 4);
  });

  it('duration ↓ вдвое → stiffness ↑ вчетверо (ω0=2π/T)', () => {
    const a = fromBounce({ duration: 2, bounce: 0 });
    const b = fromBounce({ duration: 1, bounce: 0 });
    expect(b.stiffness / a.stiffness).toBeCloseTo(4, 3);
  });

  it('mass прокидывается (k и c масштабируются)', () => {
    const p = fromBounce({ duration: 1, bounce: 0, mass: 2 });
    expect(p.mass).toBe(2);
    const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
    expect(zeta).toBeCloseTo(1, 4);
    expect(Math.sqrt(p.stiffness / p.mass)).toBeCloseTo(2 * Math.PI, 3); // ω0 не зависит от массы
  });

  it('точное преобразование (#218): координаты НЕ подменяются под бюджет исполнителя', () => {
    // Прежняя воронка «досаживала» ω₀/ζ под frame-loop budget — подмена
    // запрошенной физики. Теперь: точный закон ω₀=2π/T, ζ=1−bounce всегда.
    // duration=100, bounce=0 (пример из #218): ω₀=2π/100, ζ=1 ТОЧНО.
    const slow = fromBounce({ duration: 100, bounce: 0 });
    expect(Math.sqrt(slow.stiffness / slow.mass)).toBeCloseTo((2 * Math.PI) / 100, 12);
    expect(slow.damping / (2 * Math.sqrt(slow.stiffness * slow.mass))).toBeCloseTo(1, 12);
    expect(slow.stiffness).toBeCloseTo(0.0039478417604357434, 15);
    expect(slow.damping).toBeCloseTo(0.12566370614359174, 15);
    // bounce=1 честно означает ζ=0 ⇒ damping=0 (незатухающая).
    const elastic = fromBounce({ duration: 1, bounce: 1 });
    expect(elastic.damping).toBe(0);
    // Чистый spring() вычисляет обе; медленная в бюджете frame-loop, а
    // незатухающая — граница ИСПОЛНИТЕЛЯ (LM091), не конструктора.
    expect(Number.isFinite(spring(slow, 3).value)).toBe(true);
    expect(Number.isFinite(spring(elastic, 3).value)).toBe(true);
    expect(() => validateSpringParams(elastic)).toThrow(MotionParamError);
    // Быстрый плоский край остаётся представимым у frame-loop.
    expect(() => validateSpringParams(fromBounce({ duration: 0.05, bounce: -1 }))).not.toThrow();
  });

  it('поведенческое свойство: при t=duration пружина у цели (|1−x| < 0.15)', () => {
    for (const bounce of [0, 0.25, 0.5]) {
      for (const T of [0.3, 0.8, 2]) {
        const p = fromBounce({ duration: T, bounce });
        expect(Math.abs(1 - spring(p, T).value)).toBeLessThan(0.15);
      }
    }
  });

  it('невалидные входы → MotionParamError', () => {
    expect(() => fromBounce({ duration: 0, bounce: 0 })).toThrow(MotionParamError);
    expect(() => fromBounce({ duration: -1, bounce: 0 })).toThrow(MotionParamError);
    expect(() => fromBounce({ duration: NaN, bounce: 0 })).toThrow(MotionParamError);
    expect(() => fromBounce({ duration: 1, bounce: NaN })).toThrow(MotionParamError);
    expect(() => fromBounce({ duration: 1, bounce: 2 })).toThrow(MotionParamError);
    expect(() => fromBounce({ duration: 1, bounce: -2 })).toThrow(MotionParamError);
  });

  it('граница валидации bounce точная: ±1 принимается, ±(1+ε) отвергается', () => {
    for (const make of [
      (b: number) => fromBounce({ duration: 1, bounce: b }),
      (b: number) => fromVisualDuration({ visualDuration: 1, bounce: b }),
    ]) {
      expect(() => make(1)).not.toThrow();
      expect(() => make(-1)).not.toThrow();
      expect(() => make(1 + 1e-9)).toThrow(MotionParamError);
      expect(() => make(-1 - 1e-9)).toThrow(MotionParamError);
    }
  });
});

// ─── fromVisualDuration (первое касание цели ≈ visualDuration) ───────────────
// Оракул — замкнутое аналитическое решение первого пересечения x(t)=1, не
// differential против реализации Motion: вендорить их солвер в zero-dep репо
// ради теста дороже, чем даёт; семантика «первого визуального касания»
// заземлена цитатой доки Motion (см. шапку src/spring/index.ts).

describe('spring-ergonomics: fromVisualDuration', () => {
  /** Численно найти первое t, где x(t) >= 1. */
  function firstCrossing(p: ReturnType<typeof fromVisualDuration>, horizon: number): number {
    const N = 4000;
    for (let i = 1; i <= N; i++) {
      const t = (i / N) * horizon;
      if (spring(p, t).value >= 1) return t;
    }
    return Infinity;
  }

  it('bounce=0.3: первое касание цели ≈ visualDuration (±1%, допуск = замер 0.01% + запас)', () => {
    for (const Tv of [0.3, 0.6, 1.2]) {
      const p = fromVisualDuration({ visualDuration: Tv, bounce: 0.3 });
      const t1 = firstCrossing(p, Tv * 3);
      expect(Math.abs(t1 - Tv) / Tv).toBeLessThan(0.01);
    }
  });

  // Полный публичный домен ζ<1 — точный закон без какой-либо коэрсии (#218).
  it('property ζ<1: t1≈Tv (±1%) на ВСЁМ домене, ζ = 1−bounce ТОЧНО', () => {
    for (const bounce of [0.1, 0.3, 0.5, 0.8, 1]) {
      for (const Tv of [0.05, 0.5, 1.2, 1.5, 10, 60]) {
        const zetaRaw = 1 - bounce;
        const p = fromVisualDuration({ visualDuration: Tv, bounce });
        const zetaFin = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
        // Упругость сохранена точно: никакой бюджетной коэрсии не существует.
        expect(Math.abs(zetaFin - zetaRaw)).toBeLessThanOrEqual(1e-12);
        // Контракт длительности: первое касание ровно в Tv (допуск — шаг
        // численной сетки firstCrossing + запас).
        const t1 = firstCrossing(p, Tv * 2 + 0.1);
        expect(Math.abs(t1 - Tv) / Tv).toBeLessThan(0.01);
      }
    }
  });

  it('bounce=1 (ζ=0): точное касание незатухающей x=1−cos: ω₀ = π/(2Tv)', () => {
    for (const Tv of [0.2, 1, 5]) {
      const p = fromVisualDuration({ visualDuration: Tv, bounce: 1 });
      expect(p.damping).toBe(0);
      expect(Math.sqrt(p.stiffness / p.mass)).toBeCloseTo(Math.PI / (2 * Tv), 12);
    }
  });

  it('ζ>=1 (bounce<=0): пересечения x=1 нет, к visualDuration значение в [0.9, 1)', () => {
    for (const bounce of [0, -0.5, -1]) {
      for (const Tv of [0.1, 0.5, 2]) {
        const p = fromVisualDuration({ visualDuration: Tv, bounce });
        expect(firstCrossing(p, Tv * 4)).toBe(Infinity); // монотонный подход снизу
        const x = spring(p, Tv).value;
        expect(x).toBeGreaterThanOrEqual(0.9);
        expect(x).toBeLessThan(1);
      }
    }
  });

  it('края: физика всегда валидна; представимость frame-loop решает исполнитель (#218)', () => {
    // Конструктор больше не «гарантирует» валидатор исполнителя — он точен.
    for (const opts of [
      { visualDuration: 0.05, bounce: 1 },  // ζ=0: физика ок, frame-loop откажет
      { visualDuration: 50, bounce: 0.5 },  // медленная: физика ок
      { visualDuration: 1, bounce: -1 },    // плоская быстрая: в бюджете
    ]) {
      const p = fromVisualDuration(opts);
      expect(Number.isFinite(spring(p, opts.visualDuration).value)).toBe(true);
    }
    expect(() => validateSpringParams(fromVisualDuration({ visualDuration: 1, bounce: -1 })))
      .not.toThrow();
    expect(() => validateSpringParams(fromVisualDuration({ visualDuration: 0.05, bounce: 1 })))
      .toThrow(MotionParamError); // ζ=0 — незатухающая: граница frame-loop
  });

  it('невалидные входы → MotionParamError', () => {
    expect(() => fromVisualDuration({ visualDuration: 0, bounce: 0 })).toThrow(MotionParamError);
    expect(() => fromVisualDuration({ visualDuration: 1, bounce: 3 })).toThrow(MotionParamError);
  });
});

// ─── Пресеты (канон react-spring) ────────────────────────────────────────────

describe('spring-ergonomics: пресеты', () => {
  it('пин состава и значений (tension/friction react-spring, mass=1)', () => {
    expect(Object.keys(springPresets).sort()).toEqual(
      ['default', 'gentle', 'molasses', 'slow', 'stiff', 'wobbly'],
    );
    expect(springPresets.default).toEqual({ mass: 1, stiffness: 170, damping: 26 });
    expect(springPresets.gentle).toEqual({ mass: 1, stiffness: 120, damping: 14 });
    expect(springPresets.wobbly).toEqual({ mass: 1, stiffness: 180, damping: 12 });
    expect(springPresets.stiff).toEqual({ mass: 1, stiffness: 210, damping: 20 });
    expect(springPresets.slow).toEqual({ mass: 1, stiffness: 280, damping: 60 });
    expect(springPresets.molasses).toEqual({ mass: 1, stiffness: 280, damping: 120 });
  });

  it('каждый пресет валиден для движка', () => {
    for (const p of Object.values(springPresets)) {
      expect(() => validateSpringParams(p)).not.toThrow();
    }
  });

  it('пресеты заморожены (мутация объекта — TypeError в strict)', () => {
    expect(Object.isFrozen(springPresets)).toBe(true);
    expect(Object.isFrozen(springPresets.default)).toBe(true);
  });
});

// ─── springAsEasing ──────────────────────────────────────────────────────────

describe('spring-ergonomics: springAsEasing', () => {
  it('эндпоинты точны: e(0)=0, e(1)=1 (дисциплина NE2)', () => {
    const e = springAsEasing(springPresets.default);
    expect(e(0)).toBe(0);
    expect(e(1)).toBe(1);
    expect(e(-1)).toBe(0);
    expect(e(2)).toBe(1);
  });

  it('property ζ>=1: монотонна и без овершута на плотной сетке (1000 точек)', () => {
    for (const bounce of [0, -0.5, -1]) {
      const e = springAsEasing(fromBounce({ duration: 1, bounce }));
      let prev = 0;
      for (let i = 1; i <= 1000; i++) {
        const v = e(i / 1000);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(v).toBeLessThanOrEqual(1.0001);
        prev = v;
      }
    }
  });

  it('упругая (wobbly) — имеет овершут > 1 внутри', () => {
    const e = springAsEasing(springPresets.wobbly);
    let max = 0;
    for (let i = 1; i < 100; i++) max = Math.max(max, e(i / 100));
    expect(max).toBeGreaterThan(1.01);
  });

  it('fuzz: злые t → всегда конечно', () => {
    const e = springAsEasing(springPresets.default);
    for (const t of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -0, 1e-320]) {
      expect(Number.isFinite(e(t))).toBe(true);
    }
  });

  it('детерминизм: две функции от одних параметров бит-в-бит', () => {
    const a = springAsEasing(springPresets.gentle);
    const b = springAsEasing(springPresets.gentle);
    for (let i = 0; i <= 20; i++) expect(a(i / 20)).toBe(b(i / 20));
  });
});

// ─── Дрейф-гард зеркальных констант ──────────────────────────────────────────
// src/spring/index.ts держит копии полов движка (MIN_OMEGA0/MIN_ZETA/MAX_ZETA),
// потому что ядро их не экспортирует (поверхность запинена). Этот тест пинит
// полы по ФАКТИЧЕСКОМУ поведению валидатора: сдвиг полов в ядре без обновления
// зеркала делает его RED.

describe('spring-ergonomics: полы движка = зеркало констант субпутя', () => {
  const params = (omega0: number, zeta: number) =>
    ({ mass: 1, stiffness: omega0 * omega0, damping: 2 * zeta * omega0 });

  it('границы принимаются: ω0=2.0 (пол), ζ=0.2 (пол), ζ=4 (потолок)', () => {
    expect(() => validateSpringParams(params(2.0, 0.2))).not.toThrow();
    expect(() => validateSpringParams(params(2.0, 4))).not.toThrow();
  });

  it('выведенный закон (2026-07-03): бывшие коробочные края принимаются, за бюджетом — отказ', () => {
    // Демаскировка полов: эти входы отвергались коробкой (ω₀≥2, ζ∈[0.2,4]),
    // хотя их медленная мода оседает в бюджет кадра-капа.
    expect(() => validateSpringParams(params(1.99, 1))).not.toThrow();
    expect(() => validateSpringParams(params(2.0, 0.19))).not.toThrow();
    expect(() => validateSpringParams(params(2.0, 4.01))).not.toThrow();
    // Честные отказы: физически неоседающие в бюджет (rate → 0).
    expect(() => validateSpringParams(params(1.0, 0.1))).toThrow(MotionParamError);
    expect(() => validateSpringParams(params(0.1, 1.0))).toThrow(MotionParamError);
  });
});

// ─── API surface pin ──────────────────────────────────────────────────────────

describe('spring-ergonomics-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(ergo).sort()).toEqual(
      ['fromBounce', 'fromVisualDuration', 'springAsEasing', 'springPresets'],
    );
  });

  it('SSR: node env — не бросает', () => {
    expect(() => {
      fromBounce({ duration: 0.5, bounce: 0.2 });
      springAsEasing(springPresets.stiff)(0.5);
    }).not.toThrow();
  });
});
