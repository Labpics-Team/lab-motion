import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE,
  compileSpringPlan,
  type CompositorPlan,
} from '../src/compositor/index.js';
import { compileSpringExecutionArtifactTupleUnchecked } from '../src/compositor/curve.js';
import { effectiveSpringTolerance } from '../src/compositor/effective-tolerance.js';
import { MotionParamError } from '../src/errors.js';
import { solveSpring } from '../src/internal/solver.js';
import type { SpringParams } from '../src/spring.js';

const SPRINGS = {
  underdamped: { mass: 1, stiffness: 180, damping: 12 },
  critical: { mass: 1, stiffness: 100, damping: 20 },
  overdamped: { mass: 1, stiffness: 100, damping: 30 },
  slow: { mass: 2, stiffness: 8, damping: 2 },
} satisfies Record<string, SpringParams>;

function sampleSerializedPlan(plan: CompositorPlan, elapsedMs: number): number {
  const percent = elapsedMs / plan.duration * 100;
  for (let index = 1; index < plan.nodes.length; index++) {
    const right = plan.nodes[index]!;
    if (percent <= right.percent) {
      const left = plan.nodes[index - 1]!;
      const position = (percent - left.percent) / (right.percent - left.percent);
      return left.progress + position * (right.progress - left.progress);
    }
  }
  return plan.nodes[plan.nodes.length - 1]!.progress;
}

function observedValueError(
  plan: CompositorPlan,
  spring: SpringParams,
  span: number,
  v0: number,
): number {
  let observed = 0;
  for (let index = 0; index <= 8192; index++) {
    const elapsedMs = plan.duration * index / 8192;
    const reconstructed = sampleSerializedPlan(plan, elapsedMs);
    const analytic = solveSpring(spring, elapsedMs / 1000, v0).value;
    observed = Math.max(observed, Math.abs(reconstructed - analytic) * span);
  }
  return observed;
}

describe('#223 effective output-space tolerance', () => {
  it('chooses the strict minimum and avoids division for an exact zero span', () => {
    expect(effectiveSpringTolerance(0.01, 100, 300, 0.5)).toBe(0.0025);
    expect(effectiveSpringTolerance(0.001, 100, 300, 0.5)).toBe(0.001);
    expect(effectiveSpringTolerance(0.0025, 7, 7, 0.25)).toBe(0.0025);
    expect(effectiveSpringTolerance(0.0025, 0, Number.MIN_VALUE, 0.25)).toBe(0.0025);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects maxValueError=%s with LM172',
    (maxValueError) => {
      expect(() => compileSpringPlan({
        spring: SPRINGS.underdamped,
        property: 'opacity',
        from: 0,
        to: 100,
        maxValueError,
      })).toThrowError(expect.objectContaining<Partial<MotionParamError>>({ code: 'LM172' }));
    },
  );

  it('scales one spring across spans 1, 100, and 1000', () => {
    for (const span of [1, 100, 1000]) {
      const effective = Math.min(DEFAULT_TOLERANCE, 0.25 / span);
      const absolute = compileSpringPlan({
        spring: SPRINGS.underdamped,
        property: 'opacity',
        from: 0,
        to: span,
        maxValueError: 0.25,
      });
      const normalized = compileSpringPlan({
        spring: SPRINGS.underdamped,
        property: 'opacity',
        from: 0,
        to: span,
        tolerance: effective,
      });
      expect(absolute.easing).toBe(normalized.easing);
    }
  });

  it('bounds the serialized curve for damping regimes, slow springs, and v0', () => {
    const span = 200;
    const budget = 0.25;
    for (const [name, spring] of Object.entries(SPRINGS)) {
      for (const v0 of [-5, 0, 5]) {
        const plan = compileSpringPlan({
          spring,
          property: 'transform',
          from: -50,
          to: 150,
          v0,
          maxValueError: budget,
        });
        expect(observedValueError(plan, spring, span, v0), `${name}, v0=${v0}`)
          .toBeLessThanOrEqual(budget);
      }
    }
  });

  it('keys artifacts by effective tolerance rather than authoring form', () => {
    const span = 1000;
    const budget = 0.25;
    const effective = budget / span;
    const plan = compileSpringPlan({
      spring: SPRINGS.underdamped,
      property: 'opacity',
      from: 0,
      to: span,
      maxValueError: budget,
    });
    const equivalent = compileSpringExecutionArtifactTupleUnchecked(
      SPRINGS.underdamped,
      0,
      effective,
    );
    const different = compileSpringExecutionArtifactTupleUnchecked(
      SPRINGS.underdamped,
      0,
      effective * 2,
    );
    expect(equivalent[0]).toBe(plan.easing);
    expect(different).not.toBe(equivalent);
  });

  it('uses the strictest normalized tolerance for a shared multi-channel artifact', () => {
    const channels = [
      { span: 100, budget: 0.5 },
      { span: 1000, budget: 0.25 },
    ] as const;
    const sharedTolerance = Math.min(
      DEFAULT_TOLERANCE,
      ...channels.map(({ span, budget }) => budget / span),
    );
    const shared = compileSpringPlan({
      spring: SPRINGS.underdamped,
      property: 'opacity',
      from: 0,
      to: 1,
      tolerance: sharedTolerance,
    });
    for (const { span, budget } of channels) {
      expect(observedValueError(shared, SPRINGS.underdamped, span, 0))
        .toBeLessThanOrEqual(budget);
    }
  });
});
