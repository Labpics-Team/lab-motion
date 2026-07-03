import { describe, expect, it } from 'vitest';
import { settleTimeUpperBound, spring, springUnchecked, validateSpringParams } from '../src/spring.js';
import { MotionParamError } from '../src/errors.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from '../src/internal/constants.js';

/**
 * Test: settleTimeUpperBound — дифференциал против независимой формулы
 * Class: В (Differential) + mutation-закалка валидатора (Stryker-скоуп spring.ts)
 *
 * Контекст (2026-07-03): валидатор перешёл с коробочных полов на выведенный
 * settle-бюджет. Первый Stryker-прогон après показал 61.96% на spring.ts —
 * прежние тесты дергали валидатор только через accept/reject при mass=1,
 * поэтому арифметика settleTimeUpperBound была прозрачна для мутантов:
 *   - `stiffness / mass` → `stiffness * mass` НЕВИДИМ при mass=1 (ω₀ тот же);
 *   - мутанты amp/needLn сдвигают границу, но не переворачивают вердикт
 *     на далёких от неё входах.
 *
 * Закалка:
 *   (1) точечный дифференциал: settleTimeUpperBound === независимая
 *       реализация формулы из шапки spring.ts на сетке (m, ω₀, ζ) с
 *       mass ≠ 1 и ζ по обе стороны от 1 (включая зону вырождения ±1e-3);
 *   (2) физическое свойство: t_settle не зависит от массы при фиксированных
 *       (ω₀, ζ) — кусает ЛЮБОЙ мутант, портящий вывод ω₀/ζ из m/k/c;
 *   (3) accept/reject с mass ≠ 1 — вердикт правильный не только при m=1;
 *   (4) ζ=0 → Infinity (rate > 0 гард);
 *   (5) hostile-t пины clampFinite (NaN→0, overflow→±MAX_VALUE) — ветки
 *       защитной сети достижимы только злым t, не валидной пружиной.
 *
 * RED proof (mutation targets):
 *   - `stiffness / mass` → `* mass` в ω₀ → (2) падает (масса влияет);
 *   - `zeta * omega0` → `/` в rate → (1) падает;
 *   - потеря ln(ω₀)-члена / amp-члена в needLn → (1) падает;
 *   - слом ζ-отвода (0.999/1.001) → (1) падает на ζ=1 и ζ=1±5e-4.
 */

const SETTLE_BUDGET_S = MAX_FRAMES * FIXED_DT_S;

/** Независимая реализация формулы из шапки spring.ts (не импорт!). */
function canonicalSettle(mass: number, stiffness: number, damping: number): number {
  const omega0 = Math.sqrt(stiffness / mass);
  const zetaRaw = damping / (2 * Math.sqrt(stiffness * mass));
  const zeta = Math.abs(zetaRaw - 1) < 1e-3 ? (zetaRaw < 1 ? 0.999 : 1.001) : zetaRaw;
  const rate = zeta < 1 ? zeta * omega0 : omega0 * (zeta - Math.sqrt(zeta * zeta - 1));
  if (!(rate > 0)) return Infinity;
  const amp =
    zeta < 1
      ? 1 / Math.sqrt(1 - zeta * zeta)
      : (zeta + Math.sqrt(zeta * zeta - 1)) / (2 * Math.sqrt(zeta * zeta - 1));
  const needLn =
    Math.log(1 / CONVERGENCE_THRESHOLD) +
    Math.max(0, Math.log(omega0)) +
    Math.log(Math.max(1, amp));
  return needLn / rate;
}

/** Параметры из (m, ω₀, ζ): k = m·ω₀², c = 2m·ζ·ω₀. */
const paramsOf = (m: number, w: number, z: number) =>
  ({ mass: m, stiffness: m * w * w, damping: 2 * m * z * w });

describe('settleTimeUpperBound: дифференциал против независимой формулы', () => {
  // Сетка покрывает: mass ≠ 1 (killer для ω₀-мутантов), ζ под/над/у 1
  // (обе ветки rate/amp + зона вырождения), ln(ω₀)-член (ω₀ > 1 и < 1).
  const MASSES = [0.25, 1, 4];
  const OMEGAS = [0.5, 2, 10, 200];
  const ZETAS = [0.05, 0.5, 0.9995, 1, 1.0005, 2, 6];

  it('сетка (m × ω₀ × ζ): относительное расхождение < 1e-12', () => {
    for (const m of MASSES) {
      for (const w of OMEGAS) {
        for (const z of ZETAS) {
          const p = paramsOf(m, w, z);
          const got = settleTimeUpperBound(p);
          const want = canonicalSettle(p.mass, p.stiffness, p.damping);
          expect(Number.isFinite(got)).toBe(true);
          expect(Math.abs(got - want) / want).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('масса-инвариантность: t_settle(m) идентичен при фиксированных (ω₀, ζ)', () => {
    // Физика: ω₀ и ζ полностью определяют нормированную траекторию; масса
    // сокращается. Мутант ω₀=√(k·m) даёт ω₀=m·ω₀ → зависимость от массы.
    for (const w of [1, 5]) {
      for (const z of [0.3, 3]) {
        const base = settleTimeUpperBound(paramsOf(1, w, z));
        for (const m of [0.1, 2, 64]) {
          const got = settleTimeUpperBound(paramsOf(m, w, z));
          expect(Math.abs(got - base) / base).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('ζ=0 (незатухающая) → Infinity; damping<0 отвергается раньше валидатором', () => {
    expect(settleTimeUpperBound({ mass: 1, stiffness: 100, damping: 0 })).toBe(Infinity);
  });

  it('вырождение ζ→1: значение непрерывно-ограничено (отвод на 0.999/1.001)', () => {
    // Без отвода rate → ω₀·0 у ζ=1+ε (overdamped-ветка) и amp → ∞ у ζ→1.
    const exact = settleTimeUpperBound(paramsOf(1, 10, 1));
    const below = settleTimeUpperBound(paramsOf(1, 10, 0.998));
    const above = settleTimeUpperBound(paramsOf(1, 10, 1.002));
    // Все три конечны и одного масштаба (в пределах 2× друг от друга).
    for (const v of [exact, below, above]) expect(Number.isFinite(v)).toBe(true);
    expect(exact / below).toBeGreaterThan(0.5);
    expect(exact / below).toBeLessThan(2);
    expect(exact / above).toBeGreaterThan(0.5);
    expect(exact / above).toBeLessThan(2);
  });
});

describe('validateSpringParams: вердикт при mass ≠ 1', () => {
  it('принимает {mass:4, stiffness:400, damping:40} — ω₀=10, ζ=0.5', () => {
    expect(() => validateSpringParams({ mass: 4, stiffness: 400, damping: 40 })).not.toThrow();
  });
  it('отвергает {mass:100, stiffness:100, damping:2} — ω₀=1, ζ=0.01 (rate 0.01)', () => {
    expect(() => validateSpringParams({ mass: 100, stiffness: 100, damping: 2 }))
      .toThrow(MotionParamError);
  });
  it('отвергает {mass:0.25, stiffness:0.01, damping:0.11} — ω₀=0.2, ζ=1.1 (медленная мода)', () => {
    // slow = 0.2·(1.1 − √0.21) ≈ 0.128 rad/s → t ≈ 42s > 33.3s.
    expect(() => validateSpringParams({ mass: 0.25, stiffness: 0.01, damping: 0.11 }))
      .toThrow(MotionParamError);
  });
  it('бюджет в сообщении совпадает с MAX_FRAMES·FIXED_DT_S', () => {
    let msg = '';
    try {
      validateSpringParams({ mass: 100, stiffness: 100, damping: 2 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(SETTLE_BUDGET_S.toFixed(1));
  });
});

describe('clampFinite защитная сеть: достижима только hostile-t', () => {
  const P = { mass: 1, stiffness: 64, damping: 4 }; // валидная underdamped

  it('t=NaN → value/velocity = 0 (NaN-фоллбек «пружина в покое»)', () => {
    const r = spring(P, NaN);
    expect(r.value).toBe(0);
    expect(r.velocity).toBe(0);
  });

  // Ветки ±MAX_VALUE стража НЕДОСТИЖИМЫ через springUnchecked: солвер
  // (internal/solver.ts) снапает t ≤ 0 в покой, при t > 0 все экспоненты
  // затухают (v0=0 на этом пути), а NaN-комбинации (Inf·cos − Inf·sin)
  // падают в NaN-ветку выше. Это документированный класс «недостижимые
  // defensive-ветки» (см. stryker.config.mjs) — страж остаётся как сеть
  // на случай смены солвера, покрытие его не является целью.
  it('t > 0 у валидной пружины: вывод конечен без участия стража (позитивный контроль)', () => {
    const r = springUnchecked(P, 1e6);
    expect(r.value).toBe(1); // полностью осевшая пружина
    expect(Math.abs(r.velocity)).toBe(0); // |·| схлопывает IEEE −0
  });
});
