/**
 * test/solver-pole-space.test.ts — доказательная программа #226:
 * устойчивый pole-space solver без потери медленного overdamped-полюса.
 *
 * Классы:
 *   R. Exact RED — контрольная система (1, 1e18, 2e17): ζ=1e8; старая форма
 *      −ω₀(ζ−√(ζ²−1)) теряла медленный полюс (r_slow=0 ⇒ неподвижная кривая,
 *      а валидатор ЛОЖНО отвергал систему через LM091: rate=0 ⇒ t_settle=∞).
 *   O. High-precision оракул — полюса характеристического уравнения
 *      m·r²+c·r+k=0 вычисляются НЕЗАВИСИМО: точное целочисленное c²−4km
 *      (BigInt, декомпозиция double бит-в-бит) + isqrt со 120 guard-битами;
 *      производственные формулы не импортируются и не переиспользуются.
 *   D. Differential старой/новой формы на нормальном домене ≤ ULP-envelope.
 *   S. Scale invariance: (m,k,c)→(λm,λk,λc) с λ=2^n — бит-в-бит (квотиенты
 *      c/m, k/m идентичны при точном масштабировании), включая subnormal mass
 *      и near-overflow stiffness.
 *   N. Near-critical sweep с обеих сторон: без NaN/∞ и без скачка выше
 *      machine envelope (обе ветви непрерывно сходятся к критической форме —
 *      доказательство branch-политики по знаку Δ без magic-epsilon).
 *   L. Basis linearity: solve(v0) = base + v0·basis (стиффовый домен включён).
 *   B. Sampler ≡ solveSpring.value бит-в-бит (те же формулы и порядок).
 *
 * Mutation targets (обязаны погибать):
 *   - возврат r_slow → −ω₀(ζ−√(ζ²−1)) — R (0 vs 0.393) и валидатор LM091;
 *   - swap r_slow/r_fast, знак полюса, poleGap 2s→s — O на умеренном overdamped;
 *   - velocity ω²→α² / потеря тождества Виета — O (velocity);
 *   - Δ>0 → Δ>=0 (критическая ветвь) — точная критическая форма (N);
 *   - rate ω₀/(ζ+d) → ω₀·(ζ+d) в settle-bound — R (валидатор снова отверг бы).
 */

import { describe, expect, it } from 'vitest';
import {
  makeSpringValueSampler,
  sampleSpringBasisUnchecked,
  solveSpring,
  type MutableSpringBasis,
} from '../src/internal/solver.js';
import { settleTimeAtRestUpperBound, spring, type SpringParams } from '../src/spring.js';

// ─── Независимый оракул полюсов (BigInt, точная декомпозиция double) ─────────

/** Значение = m · 2^e; арифметика точная (BigInt), без плавающих ошибок. */
interface Big {
  readonly m: bigint;
  readonly e: number;
}

const decomposeView = new DataView(new ArrayBuffer(8));

/** Точная декомпозиция конечного double в M·2^E (бит-паттерн, не парсинг). */
function fromNumber(x: number): Big {
  decomposeView.setFloat64(0, x);
  const hi = decomposeView.getUint32(0);
  const lo = decomposeView.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exponent = (hi >>> 20) & 0x7ff;
  const mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exponent === 0) return { m: sign * mantissa, e: -1074 };
  return { m: sign * (mantissa | (1n << 52n)), e: exponent - 1075 };
}

const bigMul = (a: Big, b: Big): Big => ({ m: a.m * b.m, e: a.e + b.e });

function bigAdd(a: Big, b: Big): Big {
  if (a.m === 0n) return b;
  if (b.m === 0n) return a;
  if (a.e === b.e) return { m: a.m + b.m, e: a.e };
  const [high, low] = a.e > b.e ? [a, b] : [b, a];
  return { m: (high.m << BigInt(high.e - low.e)) + low.m, e: low.e };
}

const bigNeg = (a: Big): Big => ({ m: -a.m, e: a.e });

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

const GUARD_BITS = 120;

/** √(m·2^e) с ~120 guard-битами точности (достаточно для 1e-30 rel). */
function bigSqrt(a: Big): Big {
  let shift = 2 * GUARD_BITS;
  if ((a.e - shift) % 2 !== 0) shift += 1;
  return { m: isqrt(a.m << BigInt(shift)), e: (a.e - shift) / 2 };
}

const bitLength = (n: bigint): number => (n < 0n ? -n : n).toString(2).length;

function bigDiv(a: Big, b: Big): Big {
  // Сдвиг гарантирует ≥ GUARD_BITS значащих бит В ЧАСТНОМ независимо от
  // соотношения длин операндов (иначе длинный знаменатель съедал точность).
  const shift = Math.max(0, bitLength(b.m) - bitLength(a.m)) + GUARD_BITS;
  return { m: (a.m << BigInt(shift)) / b.m, e: a.e - b.e - shift };
}

/** Big → double: усечение до 54 бит + масштаб (≤1 ulp — достаточно оракулу). */
function toNumber(a: Big): number {
  const negative = a.m < 0n;
  let magnitude = negative ? -a.m : a.m;
  let exponent = a.e;
  const excess = magnitude.toString(2).length - 54;
  if (excess > 0) {
    magnitude >>= BigInt(excess);
    exponent += excess;
  }
  const value = Number(magnitude) * 2 ** exponent;
  return negative ? -value : value;
}

type OraclePoles =
  | { readonly kind: 'over'; readonly rSlow: number; readonly rFast: number }
  | { readonly kind: 'critical'; readonly alpha: number }
  | { readonly kind: 'under'; readonly alpha: number; readonly omegaD: number };

/**
 * Полюса m·r²+c·r+k=0 точной целочисленной арифметикой. Медленный корень —
 * формой −2k/(c+√(c²−4km)) (сложение, не вычитание): оракул устойчив по
 * построению и не зависит от производственной параметризации α/ω²/Δ.
 */
function oraclePoles(p: SpringParams): OraclePoles {
  const m = fromNumber(p.mass);
  const k = fromNumber(p.stiffness);
  const c = fromNumber(p.damping);
  const two = fromNumber(2);
  const discriminant = bigAdd(bigMul(c, c), bigNeg(bigMul(bigMul(fromNumber(4), k), m)));
  if (discriminant.m > 0n) {
    const root = bigSqrt(discriminant);
    const sum = bigAdd(c, root);
    return {
      kind: 'over',
      rSlow: toNumber(bigNeg(bigDiv(bigMul(two, k), sum))),
      rFast: toNumber(bigNeg(bigDiv(sum, bigMul(two, m)))),
    };
  }
  if (discriminant.m === 0n) {
    return { kind: 'critical', alpha: toNumber(bigDiv(c, bigMul(two, m))) };
  }
  const root = bigSqrt(bigNeg(discriminant));
  return {
    kind: 'under',
    alpha: toNumber(bigDiv(c, bigMul(two, m))),
    omegaD: toNumber(bigDiv(root, bigMul(two, m))),
  };
}

/** Оракульное (value, velocity) + масштабы допусков из оракульных полюсов. */
function oracleSolve(p: SpringParams, t: number, v0: number): {
  value: number;
  velocity: number;
  valueScale: number;
  velocityScale: number;
} {
  const poles = oraclePoles(p);
  if (poles.kind === 'over') {
    const { rSlow, rFast } = poles;
    const gap = rSlow - rFast;
    // Оба модальных коэффициента прямыми хорошо обусловленными формами.
    const A = (v0 + rFast) / gap;
    const B = -(v0 + rSlow) / gap;
    const eS = Math.exp(rSlow * t);
    const eF = Math.exp(rFast * t);
    const value = 1 + A * eS + B * eF;
    const velocity = A * rSlow * eS + B * rFast * eF;
    const valueScale = Math.max(1, Math.abs(A), Math.abs(B));
    return {
      value,
      velocity,
      valueScale,
      velocityScale: Math.max(Math.abs(velocity), valueScale * Math.abs(rFast) * Math.max(eS, eF), Math.abs(v0)),
    };
  }
  if (poles.kind === 'critical') {
    const { alpha } = poles;
    const decay = Math.exp(-alpha * t);
    const value = 1 - (1 + (alpha - v0) * t) * decay;
    const velocity = decay * (v0 - alpha * (v0 - alpha) * t);
    const valueScale = Math.max(1, Math.abs((alpha - v0) * t) * decay);
    return { value, velocity, valueScale, velocityScale: Math.max(Math.abs(velocity), Math.abs(v0), alpha * valueScale) };
  }
  const { alpha, omegaD } = poles;
  const decay = Math.exp(-alpha * t);
  const cosD = Math.cos(omegaD * t);
  const sinD = Math.sin(omegaD * t);
  const D = (alpha - v0) / omegaD;
  const value = 1 - decay * (cosD + D * sinD);
  const velocity = decay * (v0 * cosD + (omegaD - (alpha * (v0 - alpha)) / omegaD) * sinD);
  const amplitude = Math.hypot(1, D);
  return {
    value,
    velocity,
    valueScale: Math.max(1, amplitude),
    velocityScale: Math.max(Math.abs(velocity), Math.abs(v0), amplitude * (alpha + omegaD)),
  };
}

/** Параметры из (m, ω₀, ζ): k = m·ω₀², c = 2m·ζ·ω₀ (обычная воронка тестов). */
const paramsOf = (m: number, w: number, z: number): SpringParams =>
  ({ mass: m, stiffness: m * w * w, damping: 2 * m * z * w });

/** Устойчивая скорость медленной моды для нормировки сетки времени. */
function slowRate(p: SpringParams): number {
  const alpha = p.damping / p.mass / 2;
  const omega2 = p.stiffness / p.mass;
  const delta = omega2 - alpha * alpha;
  return delta >= 0 ? alpha : omega2 / (alpha + Math.sqrt(-delta));
}

// Контрольная система #226: ω₀=1e9, ζ=1e8, r_slow physически ≈ −5.
const STIFF: SpringParams = { mass: 1, stiffness: 1e18, damping: 2e17 };

// ─── R. Exact RED ────────────────────────────────────────────────────────────

describe('R: контрольная система (1, 1e18, 2e17)', () => {
  it('solveSpring возвращает медленную моду 1−e^(−5t), а не неподвижную кривую', () => {
    // Физически: r_slow = −ω²/(α+s) = −1e18/2e17 = −5 (точно в double).
    // Старая форма: ζ−√(ζ²−1) → 0 ⇒ r_slow=0 ⇒ value(0.1)=0. RED ловит именно это.
    const { value, velocity } = solveSpring(STIFF, 0.1, 0);
    const expected = -Math.expm1(-0.5); // 1−e^(−0.5): вклад быстрой моды ≤ 2.5e-17
    expect(Math.abs(value - expected)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(velocity - 5 * Math.exp(-0.5))).toBeLessThanOrEqual(1e-11);
  });

  it('валидатор принимает быстро оседающую жёсткую пружину (прежде ЛОЖНЫЙ LM091)', () => {
    // rate = ω₀/(ζ+d) = 5 ⇒ t_settle ≈ 5.2 c ≤ бюджета. Старая форма давала
    // rate=0 ⇒ Infinity ⇒ LM091 — ложное «не оседает». Также убивает мутант
    // rate → ω₀·(ζ+d) только на этом краю? нет: тот ускоряет rate — ловится D.
    const settle = settleTimeAtRestUpperBound(STIFF);
    expect(Number.isFinite(settle)).toBe(true);
    expect(settle).toBeLessThanOrEqual(2000 / 60);
    const result = spring(STIFF, 0.1); // не бросает
    expect(Math.abs(result.value - -Math.expm1(-0.5))).toBeLessThanOrEqual(1e-12);
  });

  it('makeSpringValueSampler на той же системе бит-в-бит равен solveSpring', () => {
    const sampler = makeSpringValueSampler(STIFF, 0);
    for (const t of [1e-9, 1e-3, 0.1, 0.5, 2]) {
      expect(Object.is(sampler(t), solveSpring(STIFF, t, 0).value)).toBe(true);
    }
  });

  it('соседние scale-equivalent системы бит-в-бит совпадают с базовой', () => {
    for (const lambda of [2 ** -40, 0.5, 2, 2 ** 40]) {
      const scaled: SpringParams = {
        mass: STIFF.mass * lambda,
        stiffness: STIFF.stiffness * lambda,
        damping: STIFF.damping * lambda,
      };
      for (const t of [1e-3, 0.1, 1]) {
        const base = solveSpring(STIFF, t, 0.25);
        const other = solveSpring(scaled, t, 0.25);
        expect(Object.is(base.value, other.value)).toBe(true);
        expect(Object.is(base.velocity, other.velocity)).toBe(true);
      }
    }
  });
});

// ─── O. High-precision оракул ────────────────────────────────────────────────

describe('O: независимый BigInt-оракул полюсов на лог-сетке', () => {
  // |ζ²−1| ≥ 1e-6: near-critical исключён (там модальная эвалюация оракула
  // плохо обусловлена сама по себе) и покрывается классом N ниже.
  const MASSES = [1, 0.003, 250];
  const OMEGAS = [1e-3, 0.5, 8, 300, 1e6];
  const ZETAS = [0.02, 0.4, 0.95, 1.05, 2.5, 40, 1e5, 1e8];
  const TAUS = [1e-6, 0.1, 1, 5, 25];

  it('value и velocity согласуются с оракулом на всей сетке', () => {
    let checked = 0;
    for (const m of MASSES) {
      for (const w of OMEGAS) {
        for (const z of ZETAS) {
          const params = paramsOf(m, w, z);
          if (!Number.isFinite(params.stiffness) || !Number.isFinite(params.damping)) continue;
          const rate = slowRate(params);
          for (const tau of TAUS) {
            const t = tau / rate;
            if (!Number.isFinite(t)) continue;
            for (const v0 of [0, 1, -3, w]) {
              const oracle = oracleSolve(params, t, v0);
              if (!Number.isFinite(oracle.value) || !Number.isFinite(oracle.velocity)) continue;
              const actual = solveSpring(params, t, v0);
              const label = `m=${m} ω₀=${w} ζ=${z} τ=${tau} v0=${v0}`;
              expect(
                Math.abs(actual.value - oracle.value),
                `value ${label}`,
              ).toBeLessThanOrEqual(5e-10 * oracle.valueScale);
              expect(
                Math.abs(actual.velocity - oracle.velocity),
                `velocity ${label}`,
              ).toBeLessThanOrEqual(5e-10 * Math.max(1, oracle.velocityScale));
              checked++;
            }
          }
        }
      }
    }
    // Сетка не выродилась в ноль сравнений (страж тавтологии).
    expect(checked).toBeGreaterThan(1500);
  });

  it('включая контрольную и субнормальные/около-переполненные системы', () => {
    const extras: readonly [SpringParams, number, number][] = [
      [STIFF, 0.1, 0],
      [STIFF, 0.5, 3],
      [{ mass: 1, stiffness: 1e15, damping: 6.4e9 }, 0.2, 0],
      [{ mass: 2 ** -1070, stiffness: 1e18 * 2 ** -1070, damping: 2e17 * 2 ** -1070 }, 0.1, 0],
      [{ mass: 2 ** 960, stiffness: 1e18 * 2 ** 960, damping: 2e17 * 2 ** 960 }, 0.1, 0],
    ];
    for (const [params, t, v0] of extras) {
      const oracle = oracleSolve(params, t, v0);
      const actual = solveSpring(params, t, v0);
      expect(Math.abs(actual.value - oracle.value)).toBeLessThanOrEqual(5e-10 * oracle.valueScale);
      expect(Math.abs(actual.velocity - oracle.velocity)).toBeLessThanOrEqual(
        5e-10 * Math.max(1, oracle.velocityScale),
      );
    }
  });
});

// ─── D. Differential старой/новой формы ──────────────────────────────────────

/** Дословная реплика ПРЕЖНЕЙ формы солвера (ω₀/ζ-параметризация). */
function legacySolve(params: SpringParams, t: number, v0: number): { value: number; velocity: number } {
  const { mass: m, stiffness: k, damping: c } = params;
  if (t <= 0) return { value: 0, velocity: v0 };
  const omega0 = Math.sqrt(k / m);
  const zeta = c / (2 * m * omega0);
  if (zeta < 1) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega0 * t);
    const cosD = Math.cos(omegaD * t);
    const sinD = Math.sin(omegaD * t);
    const B = (v0 - zeta * omega0) / omegaD;
    const mode = B * sinD - cosD;
    return {
      value: 1 + decay * mode,
      velocity: decay * (-zeta * omega0 * mode + omegaD * (sinD + B * cosD)),
    };
  }
  if (zeta === 1) {
    const decay = Math.exp(-omega0 * t);
    const B = v0 - omega0;
    const mode = B * t - 1;
    return { value: 1 + mode * decay, velocity: decay * (B - omega0 * mode) };
  }
  const sqrtTerm = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega0 * (zeta - sqrtTerm);
  const r2 = -omega0 * (zeta + sqrtTerm);
  const denominator = r1 - r2;
  const e1 = Math.exp(r1 * t);
  const modalDelta = Math.expm1(-denominator * t);
  const valueV0 = (-e1 * modalDelta) / denominator;
  const velocityV0 = e1 * (1 - (r2 * modalDelta) / denominator);
  return {
    value: -Math.expm1(r2 * t) + (r2 + v0) * valueV0,
    velocity: r1 * r2 * valueV0 + v0 * velocityV0,
  };
}

describe('D: дифференциал старой и новой формы на нормальном домене', () => {
  it('расхождение ≤ согласованного ULP-envelope (1e-8 относительного масштаба)', () => {
    // До ζ=100 ошибка старой формы ≤ ~2ζ²·eps ≈ 4.4e-12 отн. — envelope 1e-8
    // заведомо накрывает и её, и перестановку округлений α vs ζ·ω₀.
    for (const m of [1, 0.02, 13]) {
      for (const w of [0.3, 5, 90]) {
        for (const z of [0.05, 0.45, 0.97, 1.03, 2, 9, 100]) {
          const params = paramsOf(m, w, z);
          const rate = slowRate(params);
          for (const tau of [0.05, 0.7, 3, 12]) {
            const t = tau / rate;
            for (const v0 of [0, -2, 7]) {
              const fresh = solveSpring(params, t, v0);
              const legacy = legacySolve(params, t, v0);
              const scale = Math.max(1, Math.abs(legacy.value), Math.abs(legacy.velocity));
              expect(
                Math.abs(fresh.value - legacy.value),
                `value m=${m} ω₀=${w} ζ=${z} τ=${tau} v0=${v0}`,
              ).toBeLessThanOrEqual(1e-8 * scale);
              expect(
                Math.abs(fresh.velocity - legacy.velocity),
                `velocity m=${m} ω₀=${w} ζ=${z} τ=${tau} v0=${v0}`,
              ).toBeLessThanOrEqual(1e-8 * scale * Math.max(1, w));
            }
          }
        }
      }
    }
  });
});

// ─── S. Scale invariance ─────────────────────────────────────────────────────

describe('S: масштабная инвариантность (λ — точные степени двойки)', () => {
  it('бит-в-бит для нормальных, субнормальных и near-overflow масштабов', () => {
    const base = paramsOf(1, 10, 1.7);
    for (const lambda of [2 ** -1070, 2 ** -500, 2 ** -3, 8, 2 ** 500, 2 ** 960]) {
      const scaled: SpringParams = {
        mass: base.mass * lambda,
        stiffness: base.stiffness * lambda,
        damping: base.damping * lambda,
      };
      if (!Number.isFinite(scaled.stiffness) || scaled.mass === 0) continue;
      for (const t of [1e-4, 0.05, 0.8, 6]) {
        for (const v0 of [0, 4]) {
          const expected = solveSpring(base, t, v0);
          const actual = solveSpring(scaled, t, v0);
          expect(Object.is(actual.value, expected.value), `λ=${lambda} t=${t}`).toBe(true);
          expect(Object.is(actual.velocity, expected.velocity), `λ=${lambda} t=${t}`).toBe(true);
        }
      }
    }
  });
});

// ─── N. Near-critical sweep ──────────────────────────────────────────────────

describe('N: near-critical непрерывность с обеих сторон (branch-политика Δ)', () => {
  it('точная критическая форма: x = 1−(1+ω₀t)e^(−ω₀t) (независимая запись)', () => {
    // m=1, k=100, c=20: Δ = 100−100 = 0 точно ⇒ критическая ветвь. Мутант
    // Δ>0 → Δ>=0 отправил бы систему в underdamped с ωd=0 ⇒ NaN — погибает.
    for (const t of [0.01, 0.1, 0.35, 1.2]) {
      const { value, velocity } = solveSpring({ mass: 1, stiffness: 100, damping: 20 }, t, 0);
      const u = 10 * t;
      expect(Math.abs(value - (1 - (1 + u) * Math.exp(-u)))).toBeLessThanOrEqual(1e-13);
      expect(Math.abs(velocity - 100 * t * Math.exp(-u))).toBeLessThanOrEqual(1e-11);
    }
  });

  it('сходимость к критической форме с обеих сторон без NaN/∞ и скачков', () => {
    const criticalDamping = 20; // m=1, k=100
    for (let j = 4; j <= 44; j += 4) {
      const epsilon = 2 ** -j;
      const under = { mass: 1, stiffness: 100, damping: criticalDamping * (1 - epsilon) };
      const over = { mass: 1, stiffness: 100, damping: criticalDamping * (1 + epsilon) };
      for (const t of [0.02, 0.1, 0.5, 2]) {
        for (const v0 of [0, -5, 12]) {
          const a = solveSpring(under, t, v0);
          const b = solveSpring(over, t, v0);
          expect(Number.isFinite(a.value) && Number.isFinite(a.velocity)).toBe(true);
          expect(Number.isFinite(b.value) && Number.isFinite(b.velocity)).toBe(true);
          // Физическое расстояние между системами O(ε); машинный envelope —
          // с запасом на кансель-зону √ε у самой границы.
          const envelope = Math.max(1e-9, 64 * Math.sqrt(epsilon));
          expect(Math.abs(a.value - b.value), `ε=2^-${j} t=${t} v0=${v0}`)
            .toBeLessThanOrEqual(envelope * Math.max(1, Math.abs(v0)));
        }
      }
    }
  });
});

// ─── L. Basis linearity ──────────────────────────────────────────────────────

describe('L: базис линеен по v0, включая стиффовый домен', () => {
  it('solve(v0) = base + v0·basis (реконструкция ≤ 1e-10 относительного)', () => {
    const shared: MutableSpringBasis = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };
    const systems: readonly SpringParams[] = [
      paramsOf(1, 13, 0.4),
      paramsOf(1, 13, 1),
      paramsOf(1, 13, 3.5),
      STIFF,
    ];
    for (const params of systems) {
      const rate = slowRate(params);
      for (const tau of [0.05, 0.6, 4]) {
        const t = tau / rate;
        sampleSpringBasisUnchecked(params, t, shared);
        for (const v0 of [-7, -0.1, 0.3, 40]) {
          const direct = solveSpring(params, t, v0);
          const reconstructedValue = shared._value + v0 * shared._valueV0;
          const reconstructedVelocity = shared._velocity + v0 * shared._velocityV0;
          const scale = Math.max(1, Math.abs(direct.value), Math.abs(v0));
          expect(Math.abs(reconstructedValue - direct.value)).toBeLessThanOrEqual(1e-10 * scale);
          expect(Math.abs(reconstructedVelocity - direct.velocity)).toBeLessThanOrEqual(
            1e-10 * Math.max(1, Math.abs(direct.velocity), Math.abs(v0)),
          );
        }
      }
    }
  });
});

// ─── B. Sampler ≡ solveSpring бит-в-бит ──────────────────────────────────────

describe('B: makeSpringValueSampler бит-в-бит равен solveSpring.value', () => {
  it('все три режима, обычный и стиффовый домены, произвольные v0', () => {
    const systems: readonly SpringParams[] = [
      paramsOf(1, 10, 0.35),
      { mass: 1, stiffness: 100, damping: 20 },
      paramsOf(1, 10, 2.2),
      paramsOf(0.02, 300, 45),
      STIFF,
    ];
    for (const params of systems) {
      for (const v0 of [0, -3, 11]) {
        const sampler = makeSpringValueSampler(params, v0);
        const rate = slowRate(params);
        for (const tau of [0, 1e-7, 0.03, 0.9, 5, 20]) {
          const t = tau / rate;
          expect(
            Object.is(sampler(t), solveSpring(params, t, v0).value),
            `ζ-система ${JSON.stringify(params)} τ=${tau} v0=${v0}`,
          ).toBe(true);
        }
      }
    }
  });
});
