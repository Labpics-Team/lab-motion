/**
 * #223 — бюджет ошибки реконструкции в ЕДИНИЦАХ РЕЗУЛЬТАТА (maxValueError).
 *
 * Закон: effectiveTolerance = min(normalizedTolerance, maxValueError/|to−from|),
 * вычисляется один раз ДО кэша и сегментера; вырожденный span не делит.
 * Проверяется фактически сериализованная кривая (samples → плотная сетка),
 * а не raw-узлы: округление эмита входит в доказанный бюджет.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE,
  compileSpringPlan,
  readCompositorSpring,
  type CompositorPlan,
} from '../src/compositor/core.js';
import { compileSpringExecutionArtifactTupleUnchecked } from '../src/compositor/curve.js';
import { __resetSpringExecutionCache } from '../src/compositor/execution.js';
import { sampleSerializedSpring } from '../src/compositor/sample.js';
import { MotionParamError } from '../src/errors.js';
import type { SpringParams } from '../src/spring.js';

// Корпус режимов. Три быстрых (ω₀ = 10) были ЕДИНСТВЕННЫМИ до 2026-07-25 —
// и именно поэтому корпус не видел дефекта горизонта: у быстрой пружины закон
// оседания оставляет терминальному снапу остаток ε/ω₀ = 5e-4, вдесятеро ниже
// дефолтного бюджета, и снап тонул в шуме сетки. У медленной (ω₀ ≤ 2) остаток
// равен ε = 0.005 — ДВА дефолтных бюджета, и снап в 1 выносил ошибку за
// обещанный контракт (замер {1,1,4}, span 1000, запрошено 2.5 px: 5.0 px).
// Медленные режимы добавлены как невырегрессия.
const REGIMES: Record<string, SpringParams> = {
  underdamped: { mass: 1, stiffness: 100, damping: 10 },
  critical: { mass: 1, stiffness: 100, damping: 20 },
  overdamped: { mass: 1, stiffness: 100, damping: 40 },
  slowUnderdamped: { mass: 1, stiffness: 1, damping: 1 },       // ω₀ = 1, ζ = 0.5
  slowNearCritical: { mass: 1, stiffness: 1, damping: 1.98 },   // ω₀ = 1, ζ = 0.99
  slowOverdamped: { mass: 1, stiffness: 1, damping: 4 },        // ω₀ = 1, ζ = 2
  verySlow: { mass: 4, stiffness: 1, damping: 2 },              // ω₀ = 0.5, ζ = 0.5
};

/** Худшая ошибка реконструкции в единицах значения на плотной независимой сетке. */
function worstValueError(
  plan: CompositorPlan,
  spring: SpringParams,
  from: number,
  to: number,
  v0: number,
  probes = 1500,
): number {
  const samples = new Float64Array(plan.nodes.length * 2);
  for (let i = 0; i < plan.nodes.length; i++) {
    samples[i * 2] = plan.nodes[i]!.percent;
    samples[i * 2 + 1] = plan.nodes[i]!.progress;
  }
  const out = { value: 0, velocity: 0 };
  let worst = 0;
  for (let i = 0; i <= probes; i++) {
    const tMs = plan.duration * i / probes;
    const reconstructed = from +
      sampleSerializedSpring(samples, plan.duration, tMs).value * (to - from);
    const reference = readCompositorSpring(spring, { from, to, v0, t: tMs / 1000 }, out);
    const err = Math.abs(reconstructed - reference.value);
    if (err > worst) worst = err;
  }
  return worst;
}

describe('#223 maxValueError: абсолютный бюджет в единицах свойства', () => {
  it('property: плотная реконструкция соблюдает бюджет на всех режимах, спанах и v0', () => {
    const budget = 0.25;
    for (const [name, spring] of Object.entries(REGIMES)) {
      for (const v0 of [0, 3, -3]) {
        for (const [from, to] of [[0, 1], [0, 100], [0, 1000], [100, -50]] as const) {
          // #228: overdamped при effective 2.5e-4 больше НЕ упирается в кап —
          // локальная энергетическая сетка влезает (прежний skip снят).
          const plan = compileSpringPlan({
            spring, property: 'opacity', from, to, v0, maxValueError: budget,
          });
          const worst = worstValueError(plan, spring, from, to, v0);
          // ОБЕЩАНО min(normalized·span, budget) — тот же min-закон, что и в
          // производстве. Сверять с одним лишь `budget` было дырой: при span = 1
          // связывает normalized (0.0025 ед. значения), а бюджет 0.25 — в СТО раз
          // слабее, и стократное превышение прошло бы зелёным.
          const promised = Math.min(DEFAULT_TOLERANCE * Math.abs(to - from), budget);
          expect(worst, `${name} v0=${v0} span=${to - from}`)
            .toBeLessThanOrEqual(promised * (1 + 1e-9));
        }
      }
    }
  });

  it('горизонт: снап в 1 укладывается в бюджет при tolerance ≥ дефолта', () => {
    // ДЫРА, ЗАКРЫТАЯ 2026-07-25. Прежний закон горизонта при
    // `tolerance >= DEFAULT_TOLERANCE` возвращал settleTimeUpperBound без
    // проверки остатка, а тот гарантирует лишь |p−1| ≤ ε/max(1,ω₀) при v0 = 0
    // и ≤ ε при v0 ≠ 0 (ε = 0.005 = два дефолтных бюджета). Терминальный узел
    // форсится в ровно 1, поэтому остаток — ПРЯМАЯ ошибка реконструкции.
    //
    // Замеры ДО правки (span 1000, запрошено ≤ 2.5 px):
    //   {1,1,4}    v0 = 0  → 5.000 px = 2.000× бюджета
    //   {1,1,1.98} v0 = 0  → 4.615 px = 1.846×
    //   {1,1,1}    v0 = 3  → 4.882 px = 1.953×
    //   {4,1,2}    v0 = 0  → 4.333 px = 1.733×
    // Mutation proof: вернуть в springCompileHorizon шорткат
    // `if (tolerance >= DEFAULT_TOLERANCE) return settle` → RED на всех четырёх.
    const span = 1000;
    for (const [name, spring] of Object.entries(REGIMES)) {
      for (const v0 of [0, 3, -3]) {
        // Отношение maxValueError/span в окне [DEFAULT, 2·DEFAULT): ровно та
        // зона, где действовал шорткат и где normalized связывает бюджет.
        for (const ratio of [DEFAULT_TOLERANCE, 0.003, 0.00499]) {
          const plan = compileSpringPlan({
            spring, property: 'opacity', from: 0, to: span, v0,
            maxValueError: ratio * span,
          });
          const worst = worstValueError(plan, spring, 0, span, v0);
          const promised = Math.min(DEFAULT_TOLERANCE, ratio) * span;
          expect(worst, `${name} v0=${v0} ratio=${ratio}`)
            .toBeLessThanOrEqual(promised * (1 + 1e-9));
        }
      }
    }
  });

  it('property-развёртка по (ω₀, ζ): обещание держится на всей физической сетке', () => {
    // Корпус именованных режимов ловит то, что в него положили. Эта развёртка
    // ловит то, о чём никто не подумал: лог-равномерная сетка по собственной
    // частоте и демпфированию — 12 × 8 × 3 v0 × 2 бюджета ≈ 576 планов.
    //
    // Замер на полной версии этой сетки (26 ω₀ × 16 ζ × 3 массы × 4 v0 × 4
    // пары бюджет/span ≈ 12 000 планов) ДО правки горизонта 2026-07-25:
    // 780 нарушений, худшее 2.0000× бюджета (ω₀ = 0.458, ζ = 1.553, v0 = 0).
    // ПОСЛЕ: нарушений ноль, худшее 0.6989× (ω₀ = 3.816, ζ = 0.201, v0 = 4) —
    // то есть худший случай определяет конвейер сетка+RDP+эмит, а не снап.
    // Промежуточный вариант закона (ужесточение ε/ω₀ и для ζ ≥ 1 при v0 ≠ 0)
    // эта же развёртка отвергла: 288 нарушений, худшее 4.997×.
    let worst = 0;
    let worstAt = '';
    for (let a = 0; a < 12; a++) {
      const omega0 = Math.exp(Math.log(0.3) + (a / 11) * (Math.log(60) - Math.log(0.3)));
      for (let b = 0; b < 8; b++) {
        const zeta = Math.exp(Math.log(0.15) + (b / 7) * (Math.log(12) - Math.log(0.15)));
        const spring = {
          mass: 1,
          stiffness: omega0 * omega0,
          damping: 2 * zeta * omega0,
        };
        for (const v0 of [0, 4, -4]) {
          for (const [budget, span] of [[2.5, 1000], [0.25, 1000]] as const) {
            let plan: CompositorPlan;
            try {
              plan = compileSpringPlan({
                spring, property: 'opacity', from: 0, to: span, v0, maxValueError: budget,
              });
            } catch {
              continue; // LM016/LM091: непосильный бюджет отвергается явно — это не нарушение
            }
            const promised = Math.min(DEFAULT_TOLERANCE * span, budget);
            const ratio = worstValueError(plan, spring, 0, span, v0, 600) / promised;
            if (ratio > worst) {
              worst = ratio;
              worstAt = `ω₀=${omega0.toFixed(3)} ζ=${zeta.toFixed(3)} v0=${v0} budget=${budget}`;
            }
          }
        }
      }
    }
    expect(worst, `худшее отношение ошибки к бюджету: ${worstAt}`).toBeLessThanOrEqual(1);
  }, 60_000);

  it('горизонт: явная tolerance ВЫШЕ дефолта тоже держит обещание', () => {
    // Вторая половина той же дыры: пользователь вправе ослабить бюджет
    // (`tolerance: 0.01`), и тогда шорткат срабатывал тем более. Обещание
    // масштабируется вместе с запросом, а не остаётся на уровне ε.
    for (const [name, spring] of Object.entries(REGIMES)) {
      for (const tolerance of [0.005, 0.01, 0.02]) {
        const plan = compileSpringPlan({
          spring, property: 'opacity', from: 0, to: 1, tolerance,
        });
        const worst = worstValueError(plan, spring, 0, 1, 0);
        expect(worst, `${name} tolerance=${tolerance}`)
          .toBeLessThanOrEqual(tolerance * (1 + 1e-9));
      }
    }
  });

  it('LM170: переполненный span (MAX↔−MAX) и субнормальный бюджет не занижают tolerance до 0', () => {
    const spring = REGIMES.underdamped!;
    for (const [from, to, budget] of [
      [-Number.MAX_VALUE, Number.MAX_VALUE, 0.25], // span → ∞ ⇒ normalized 0
      [0, 1e300, 1e-300],                          // underflow ⇒ normalized 0
    ] as const) {
      let code = '';
      try {
        compileSpringPlan({ spring, property: 'opacity', from, to, maxValueError: budget });
      } catch (error) {
        code = (error as MotionParamError).code;
      }
      expect(code, `from=${from} to=${to}`).toBe('LM170');
    }
  });

  it('fail-closed: непосильный бюджет отвергается LM016, а не нарушается тихо', () => {
    // ζ=2, ω₀=10 при effective 6.25e-8: даже адаптивная сетка (#228) превышает
    // BASE_GRID_MAX (прежний порог span=1000 адаптив теперь компилирует —
    // покрыто property-тестом выше).
    let code = '';
    try {
      compileSpringPlan({
        spring: REGIMES.overdamped!, property: 'opacity',
        from: 0, to: 4_000_000, maxValueError: 0.25,
      });
    } catch (error) {
      code = (error as MotionParamError).code;
    }
    expect(code).toBe('LM016');
  });

  it('scaling: крупный span с абсолютным бюджетом строит СТРОЖЕ дефолта (больше узлов)', () => {
    const spring = REGIMES.underdamped!;
    const relaxed = compileSpringPlan({ spring, property: 'opacity', from: 0, to: 1000 });
    const strict = compileSpringPlan({
      spring, property: 'opacity', from: 0, to: 1000, maxValueError: 0.25,
    });
    // 0.25/1000 = 2.5e-4 < 1/400: mutant min→max или abs·span дал бы равенство.
    expect(strict.nodes.length).toBeGreaterThan(relaxed.nodes.length);
  });

  it('min-закон: бюджет слабее normalized не ослабляет кривую', () => {
    const spring = REGIMES.critical!;
    const byDefault = compileSpringPlan({ spring, property: 'opacity', from: 0, to: 1 });
    const looser = compileSpringPlan({
      // 10/1 = 10 progress-единиц — заведомо слабее DEFAULT_TOLERANCE.
      spring, property: 'opacity', from: 0, to: 1, maxValueError: 10,
    });
    expect(looser.easing).toBe(byDefault.easing);
    expect(looser.nodes.length).toBe(byDefault.nodes.length);
  });

  it('вырожденный span: деление не выполняется, действует normalized (без NaN/∞)', () => {
    const spring = REGIMES.underdamped!;
    const still = compileSpringPlan({
      spring, property: 'opacity', from: 5, to: 5, maxValueError: 1e-9,
    });
    const normalized = compileSpringPlan({ spring, property: 'opacity', from: 5, to: 5 });
    expect(still.easing).toBe(normalized.easing);
    expect(Number.isFinite(still.duration)).toBe(true);
  });

  it('LM170: нефинитный/неположительный бюджет отклоняется до побочных эффектов', () => {
    const spring = REGIMES.underdamped!;
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      let code = '';
      try {
        compileSpringPlan({
          spring, property: 'opacity', from: 0, to: 1, maxValueError: bad,
        });
      } catch (error) {
        code = (error as MotionParamError).code;
      }
      expect(code, String(bad)).toBe('LM170');
    }
  });

  it('cache: эквивалентные authoring-входы попадают в ОДИН artifact, разные — не коллидируют', () => {
    __resetSpringExecutionCache();
    const spring = REGIMES.underdamped!;
    const budget = 0.25;
    const span = 1000;
    const plan = compileSpringPlan({
      spring, property: 'opacity', from: 0, to: span, maxValueError: budget,
    });
    // Тот же effective normalized tolerance напрямую — обязан быть cache hit
    // с ТЕМ ЖЕ tuple (identity стабильна между вызовами).
    const effective = budget / span;
    const tupleA = compileSpringExecutionArtifactTupleUnchecked(spring, 0, effective);
    const tupleB = compileSpringExecutionArtifactTupleUnchecked(spring, 0, effective);
    expect(tupleA).toBe(tupleB);
    expect(tupleA[0]).toBe(plan.easing);
    // Другой бюджет — другой effective — другой artifact (нет коллизии ключа).
    const other = compileSpringPlan({
      spring, property: 'opacity', from: 0, to: span, maxValueError: budget * 40,
    });
    expect(other.easing).not.toBe(plan.easing);
  });

  it('multi-channel: свёрнутый min общей кривой соблюдает бюджет КАЖДОГО канала', () => {
    const spring = REGIMES.underdamped!;
    const channels = [
      { from: 0, to: 100, maxValueError: 0.5 },
      { from: 0, to: 1000, maxValueError: 0.5 },
    ] as const;
    // Документированный канон вызывающего: min по каналам с absolute budget.
    const folded = Math.min(
      ...channels.map((c) => c.maxValueError / Math.abs(c.to - c.from)),
    );
    expect(folded).toBeLessThan(DEFAULT_TOLERANCE);
    const shared = compileSpringPlan({
      spring, property: 'opacity', from: 0, to: 1, tolerance: folded,
    });
    for (const channel of channels) {
      const worst = worstValueError(shared, spring, channel.from, channel.to, 0);
      expect(worst).toBeLessThanOrEqual(channel.maxValueError * (1 + 1e-9));
    }
  });
});
