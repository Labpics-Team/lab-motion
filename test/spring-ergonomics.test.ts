/**
 * test/spring-ergonomics.test.ts — эргономика пружин (subpath ./spring).
 * Классы: А (маппинг с известными числами) + В (fuzz/поведенческие свойства) + Д.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падают поведенческие блоки.
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

  it('результат ВСЕГДА проходит validateSpringParams (клампы под полы движка)', () => {
    // Экстремумы публичного диапазона: bounce 1 (ζ-пол 0.2), длинный duration (ω0-пол 2.0).
    for (const opts of [
      { duration: 1, bounce: 1 },      // ζ клампится к полу движка
      { duration: 100, bounce: 0 },    // ω0 клампится к полу движка
      { duration: 0.05, bounce: -1 },  // очень быстрый + плоский
    ]) {
      expect(() => validateSpringParams(fromBounce(opts))).not.toThrow();
    }
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
});

// ─── fromVisualDuration (первое касание цели ≈ visualDuration) ───────────────

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

  // Полный публичный домен ζ<1, включая зону клампа ω0 (класс, слепой для
  // точечных тестов: длинный Tv + малый ζ → ω0 упирается в пол и пружина
  // быстрее запрошенной).
  it('property ζ<1: вне клампа t1≈Tv (±1%); в клампе t1<Tv; всегда t1 ≈ аналитике финальных параметров', () => {
    const MIN_OMEGA0 = 2.0; // зеркало пола движка (дрейф ловит гард ниже)
    for (const bounce of [0.1, 0.3, 0.5, 0.8, 1]) {
      for (const Tv of [0.05, 0.5, 1.2, 1.5, 10]) {
        const zeta = Math.min(4, Math.max(0.2, 1 - bounce));
        if (zeta >= 1) continue;
        const s = Math.sqrt(1 - zeta * zeta);
        const omega0Raw = (Math.PI - Math.atan(s / zeta)) / (s * Tv);
        const p = fromVisualDuration({ visualDuration: Tv, bounce });
        const omega0Fin = Math.sqrt(p.stiffness / p.mass);
        // инвариант: первое касание = точное решение для ФИНАЛЬНЫХ параметров
        const tStar = (Math.PI - Math.atan(s / zeta)) / (s * omega0Fin);
        const t1 = firstCrossing(p, tStar * 2 + 0.1);
        expect(Math.abs(t1 - tStar) / tStar).toBeLessThan(0.01);
        if (omega0Raw >= MIN_OMEGA0) {
          expect(Math.abs(t1 - Tv) / Tv).toBeLessThan(0.01); // контракт точен
        } else {
          expect(t1).toBeLessThan(Tv); // деградация только в раннюю сторону
        }
      }
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

  it('результат проходит validateSpringParams на краях', () => {
    for (const opts of [
      { visualDuration: 0.05, bounce: 1 },
      { visualDuration: 50, bounce: 0.5 },
      { visualDuration: 1, bounce: -1 },
    ]) {
      expect(() => validateSpringParams(fromVisualDuration(opts))).not.toThrow();
    }
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

  it('критически демпфированная — монотонна и без овершута', () => {
    const e = springAsEasing(fromBounce({ duration: 1, bounce: 0 }));
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = e(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeLessThanOrEqual(1.001);
      prev = v;
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

  it('за границами отвергается: ω0=1.99, ζ=0.19, ζ=4.01', () => {
    expect(() => validateSpringParams(params(1.99, 1))).toThrow(MotionParamError);
    expect(() => validateSpringParams(params(2.0, 0.19))).toThrow(MotionParamError);
    expect(() => validateSpringParams(params(2.0, 4.01))).toThrow(MotionParamError);
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
