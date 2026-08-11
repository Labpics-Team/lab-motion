import { describe, expect, it } from 'vitest';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import {
  maxValueError,
  parseCssLinear,
} from '../src/compositor/error-bound.js';
import { solveSpring } from '../src/internal/solver.js';
import type { SpringParams } from '../src/spring.js';

describe('parseCssLinear', () => {
  it('parses standard linear() string correctly', () => {
    const css = 'linear(0 0%, 0.5 50%, 1 100%)';
    const stops = parseCssLinear(css);
    expect(stops).toEqual([
      { progress: 0, percent: 0 },
      { progress: 0.5, percent: 50 },
      { progress: 1, percent: 100 },
    ]);
  });

  it('handles stops with multiple percentages', () => {
    const css = 'linear(0 0%, 0.5 20% 40%, 1 100%)';
    const stops = parseCssLinear(css);
    expect(stops).toEqual([
      { progress: 0, percent: 0 },
      { progress: 0.5, percent: 20 },
      { progress: 0.5, percent: 40 },
      { progress: 1, percent: 100 },
    ]);
  });

  it('fills implicit missing percentages according to CSS spec', () => {
    const css = 'linear(0, 0.5 50%, 1)';
    const stops = parseCssLinear(css);
    expect(stops).toEqual([
      { progress: 0, percent: 0 },
      { progress: 0.5, percent: 50 },
      { progress: 1, percent: 100 },
    ]);
  });

  it('returns empty array for invalid input', () => {
    expect(parseCssLinear('')).toEqual([]);
    expect(parseCssLinear('invalid')).toEqual([]);
  });
});

describe('maxValueError', () => {
  const springUnderdamped: SpringParams = { mass: 1, stiffness: 180, damping: 12 };
  const springCritical: SpringParams = { mass: 1, stiffness: 100, damping: 20 };
  const springOverdamped: SpringParams = { mass: 1, stiffness: 100, damping: 30 };
  const springSlow: SpringParams = { mass: 2, stiffness: 8, damping: 2 };

  it('returns 0 when scale is 0 or invalid artifact', () => {
    expect(maxValueError('linear(0 0%, 1 100%)', springUnderdamped, 0)).toBe(0);
    expect(maxValueError('', springUnderdamped, 100)).toBe(0);
  });

  it('calculates error bound in result units correctly for positional arguments', () => {
    const tolerance = DEFAULT_TOLERANCE;
    const tuple = compileSpringExecutionArtifactTupleUnchecked(springUnderdamped, 0, tolerance);
    const css = tuple[0];
    const scale = 200; // 200 px target

    const errorPx = maxValueError(css, {
      spring: springUnderdamped,
      scale,
      durationMs: tuple[2],
    });
    expect(errorPx).toBeGreaterThan(0);
    // At tolerance 1/400 (0.0025), error for 200px should be around 0.5px
    expect(errorPx).toBeLessThan(scale * tolerance * 2);
  });

  it('supports options object signature (MaxValueErrorOptions)', () => {
    const tolerance = DEFAULT_TOLERANCE;
    const tuple = compileSpringExecutionArtifactTupleUnchecked(springUnderdamped, 0, tolerance);
    const css = tuple[0];

    const errorOpts = maxValueError(css, {
      spring: springUnderdamped,
      from: 100,
      to: 300,
      durationMs: tuple[2],
    });
    const errorPositional = maxValueError(css, {
      spring: springUnderdamped,
      scale: 200,
      durationMs: tuple[2],
    });

    expect(errorOpts).toBeCloseTo(errorPositional, 5);
  });

  it('guarantees tight bound: bound >= true max error and bound <= 2.0 * true max error', () => {
    const springs = [springUnderdamped, springCritical, springOverdamped, springSlow];
    const scales = [100, 450];
    const velocities = [0, 5];

    for (const spring of springs) {
      for (const v0 of velocities) {
        for (const scale of scales) {
          const tuple = compileSpringExecutionArtifactTupleUnchecked(spring, v0, DEFAULT_TOLERANCE);
          const css = tuple[0];
          const durationSec = tuple[2] / 1000;

          const bound = maxValueError(css, { spring, scale, v0, durationMs: tuple[2] });

          // Calculate true max error empirically by fine dense sampling (10,000 points)
          const stops = parseCssLinear(css);
          let trueMaxErrorNorm = 0;

          const numSamples = 8192;
          for (let k = 0; k <= numSamples; k++) {
            const t = (k / numSamples) * durationSec;
            const pct = (t / durationSec) * 100;

            // Piecewise linear value at pct
            let pLinear = stops[stops.length - 1]!.progress;
            if (pct <= stops[0]!.percent) {
              pLinear = stops[0]!.progress;
            } else {
              for (let i = 0; i < stops.length - 1; i++) {
                if (pct >= stops[i]!.percent && pct <= stops[i + 1]!.percent) {
                  const frac = (pct - stops[i]!.percent) / (stops[i + 1]!.percent - stops[i]!.percent);
                  pLinear = stops[i]!.progress + frac * (stops[i + 1]!.progress - stops[i]!.progress);
                  break;
                }
              }
            }

            const pSpring = solveSpring(spring, t, v0).value;
            const err = Math.abs(pSpring - pLinear);
            if (err > trueMaxErrorNorm) trueMaxErrorNorm = err;
          }

          const trueMaxErrorPx = scale * trueMaxErrorNorm;

          // Upper bound guarantee: bound >= trueMaxErrorPx
          expect(bound).toBeGreaterThanOrEqual(trueMaxErrorPx - 1e-10);

          // Tightness guarantee: bound <= 2.0 * trueMaxErrorPx
          if (trueMaxErrorPx > 1e-6) {
            expect(bound).toBeLessThanOrEqual(2.0 * trueMaxErrorPx);
          }
        }
      }
    }
  });
});
