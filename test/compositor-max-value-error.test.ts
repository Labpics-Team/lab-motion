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

const REGIMES: Record<string, SpringParams> = {
  underdamped: { mass: 1, stiffness: 100, damping: 10 },
  critical: { mass: 1, stiffness: 100, damping: 20 },
  overdamped: { mass: 1, stiffness: 100, damping: 40 },
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
          // Жёсткая overdamped при бюджете 2.5e-4 прогресса упирается в
          // физический кап сетки — этот случай покрыт fail-closed тестом ниже.
          if (name === 'overdamped' && Math.abs(to - from) === 1000) continue;
          const plan = compileSpringPlan({
            spring, property: 'opacity', from, to, v0, maxValueError: budget,
          });
          const worst = worstValueError(plan, spring, from, to, v0);
          expect(worst, `${name} v0=${v0} span=${to - from}`)
            .toBeLessThanOrEqual(budget * (1 + 1e-9));
        }
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
    // ζ=2, ω₀=10 при effective 2.5e-4: доказанная сетка превышает BASE_GRID_MAX.
    let code = '';
    try {
      compileSpringPlan({
        spring: REGIMES.overdamped!, property: 'opacity',
        from: 0, to: 1000, maxValueError: 0.25,
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
