import { describe, expect, it } from 'vitest';
import {
  evaluateFreezeConformance,
  evaluateTrajectoryConformance,
  S5_MOTION_CONTRACT,
} from '../bench/compare/motion-conformance.mjs';

type Point = { readonly t: number; readonly x: number };

const linear = (t: number) => 600 * Math.max(0, Math.min(1, t / 2.4));
const sample = (curve: (t: number) => number): Point[] => Array.from(
  { length: 121 }, (_, index) => ({ t: index / 50, x: curve(index / 50) }),
);

// RK4 решает исходное ОДУ; фикстура не повторяет аналитическую формулу oracle.
function springSamples(): Point[] {
  const points: Point[] = [{ t: 0, x: 0 }];
  const step = 0.0005;
  const acceleration = (x: number, velocity: number) => 40 * (600 - x) - 8 * velocity;
  let x = 0;
  let velocity = 0;
  for (let tick = 1; tick <= 4800; tick++) {
    const dx1 = velocity;
    const dv1 = acceleration(x, velocity);
    const dx2 = velocity + dv1 * step / 2;
    const dv2 = acceleration(x + dx1 * step / 2, dx2);
    const dx3 = velocity + dv2 * step / 2;
    const dv3 = acceleration(x + dx2 * step / 2, dx3);
    const dx4 = velocity + dv3 * step;
    const dv4 = acceleration(x + dx3 * step, dx4);
    x += step * (dx1 + 2 * dx2 + 2 * dx3 + dx4) / 6;
    velocity += step * (dv1 + 2 * dv2 + 2 * dv3 + dv4) / 6;
    if (tick % 40 === 0) points.push({ t: tick / 2000, x });
  }
  return points;
}

const spring = springSamples();
const pair = (baseline: unknown, blocked: unknown = baseline) => ({
  evidence: { baseline, blocked },
});

describe('bounded independent S5 motion contract', () => {
  it('не расширяет допуск за счёт неопределённости часов', () => {
    const advanced = sample((t) => linear(t + 0.025));
    expect(evaluateTrajectoryConformance(advanced, 'linear').verdict).toBe('pass');
    expect(evaluateTrajectoryConformance(advanced, 'linear', 10).verdict).toBe('fail');
    expect(evaluateTrajectoryConformance(sample(linear), 'linear', 20).verdict).toBe('pass');
  });

  it.each([-1, NaN, Infinity, 20.001])('неизвестные или чрезмерно неточные часы (%s) не дают PASS', (uncertainty) => {
    expect(evaluateTrajectoryConformance(sample(linear), 'linear', uncertainty)).toMatchObject({
      verdict: 'inconclusive', reason: 'clock-uncertainty-exceeds-contract',
    });
  });

  it('freezes the explicit S5 budgets including spring parameters', () => {
    expect(S5_MOTION_CONTRACT).toEqual({
      id: 's5-motion-v1', distancePx: 600, durationMs: 2400,
      positionTolerancePx: 3, timeToleranceMs: 20, maxObservationGapMs: 50,
      spring: { stiffness: 40, damping: 8, mass: 1 },
    });
    expect(Object.isFrozen(S5_MOTION_CONTRACT)).toBe(true);
    expect(Object.isFrozen(S5_MOTION_CONTRACT.spring)).toBe(true);
  });

  it('accepts a complete linear trajectory and reports nominal error and observed coverage', () => {
    const points = sample(linear);
    const result = evaluateTrajectoryConformance(points, 'linear');
    expect(result).toMatchObject({
      verdict: 'pass', reason: 'within-s5-motion-contract', samples: 121, maxErrorPx: 0,
    });
    expect(result.maxGapMs).toBeCloseTo(20, 10);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(points).toEqual(sample(linear));
  });

  it('accepts the independent numerical spring solution including its overshoot', () => {
    expect(Math.max(...spring.map((point) => point.x))).toBeGreaterThan(640);
    const result = evaluateTrajectoryConformance(spring, 'spring');
    expect(result.verdict).toBe('pass');
    expect(result.maxErrorPx).toBeLessThan(0.000001);
    expect(evaluateFreezeConformance('lab-spring', pair(spring))).toMatchObject({
      baseline: { verdict: 'pass' }, blocked: { verdict: 'pass' },
    });
  });

  it.each(['lab', 'motion', 'gsap', 'anime', 'waapi-ctl', 'motion-mini', 'anime-waapi'])(
    'maps %s to the linear contract', (id) => {
      expect(evaluateFreezeConformance(id, pair(sample(linear)))).toMatchObject({
        baseline: { verdict: 'pass' }, blocked: { verdict: 'pass' },
      });
    },
  );

  it('rejects unsupported models and participants without silently choosing a curve', () => {
    for (const model of ['ease', '', null, undefined]) {
      expect(() => evaluateTrajectoryConformance(sample(linear), model)).toThrow(/model/i);
    }
    for (const id of ['unknown', 'toString', '__proto__', '', null]) {
      expect(() => evaluateFreezeConformance(id, pair(sample(linear)))).toThrow(/participant/i);
    }
  });

  it.each([
    ['frozen', (_t: number) => 0],
    ['quadratic', (t: number) => 600 * (t / 2.4) ** 2],
    ['early', (t: number) => linear(t + 0.1)],
    ['late', (t: number) => linear(t - 0.1)],
    ['short distance', (t: number) => linear(t) * 0.8],
    ['long distance', (t: number) => linear(t) * 1.2],
  ])('fails the same wrong %s curve in both baseline and blocked capture', (_label, curve) => {
    expect(evaluateFreezeConformance('lab', pair(sample(curve)))).toMatchObject({
      baseline: { verdict: 'fail' }, blocked: { verdict: 'fail' },
    });
  });

  it('detects 25 percent held from 0.6 to 1.54 seconds before a jump to 65 percent', () => {
    const blocked = sample((t) => t >= 0.6 && t <= 1.54 ? 150 : linear(t));
    expect(blocked.find((point) => point.t === 1.56)?.x).toBe(390);
    expect(evaluateFreezeConformance('lab', pair(sample(linear), blocked))).toMatchObject({
      baseline: { verdict: 'pass' },
      blocked: { verdict: 'fail', reason: 'position-outside-contract' },
    });
  });

  it('detects a spring held before its first peak even if it later jumps to wall time', () => {
    const held = spring.find((point) => point.t === 0.3)!.x;
    const blocked = spring.map((point) => point.t >= 0.3 && point.t <= 1.2
      ? { ...point, x: held } : point);
    expect(evaluateFreezeConformance('lab-spring', pair(spring, blocked))).toMatchObject({
      baseline: { verdict: 'pass' }, blocked: { verdict: 'fail' },
    });
  });

  it('keeps each trajectory verdict independent of run validity and its paired verdict', () => {
    const run = { ...pair(sample(() => 0), sample(linear)), valid: false };
    expect(evaluateFreezeConformance('lab', run)).toMatchObject({
      baseline: { verdict: 'fail' }, blocked: { verdict: 'pass' },
    });
  });

  it('enumerates every pause window on the finite 20 ms linear observation grid', () => {
    // Все 7260 окон этой сетки; скрытое движение между точками этим не доказано.
    const points = sample(linear);
    let windows = 0;
    for (let start = 0; start < points.length - 1; start++) {
      for (let end = start + 1; end < points.length; end++) {
        const held = points[start]!.x;
        const blocked = points.map((point, index) => index >= start && index <= end
          ? { ...point, x: held } : point);
        const result = evaluateTrajectoryConformance(blocked, 'linear');
        // За 20 мс ошибка 5 px внутри бюджета 8 px; за 40 мс уже 10 px.
        expect(result.verdict, `pause ${start * 20}..${end * 20} ms`)
          .toBe(end - start === 1 ? 'pass' : 'fail');
        windows++;
      }
    }
    expect(windows).toBe(7260);
  });

  it.each(['linear', 'spring'])('accepts deterministic small signed perturbations for %s', (model) => {
    const points = model === 'linear' ? sample(linear) : spring;
    for (let seed = 1; seed <= 32; seed++) {
      let state = seed;
      const perturbed = points.map((point) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return { ...point, x: point.x + (state / 0xffffffff * 2 - 1) * 2.99 };
      });
      expect(evaluateTrajectoryConformance(perturbed, model).verdict).toBe('pass');
    }
  });

  it.each([-1, 1])('enforces the inclusive spatial and temporal envelope in direction %s', (sign) => {
    const atBoundary = sample((t) => t === 1.2 ? linear(t) + sign * 8 : linear(t));
    expect(evaluateTrajectoryConformance(atBoundary, 'linear').verdict).toBe('pass');
    const outside = atBoundary.map((point) => point.t === 1.2
      ? { ...point, x: point.x + sign * 0.000001 } : point);
    expect(evaluateTrajectoryConformance(outside, 'linear').verdict).toBe('fail');
  });

  it.each([
    [1, 1], [2, -1],
  ])('includes exact spring extremum %s inside a time envelope', (n, direction) => {
    const extremumTime = n * Math.PI / Math.sqrt(24);
    const extremumX = 600 * (1 - Math.exp(-4 * extremumTime) * (-1) ** n);
    const observedTime = extremumTime + 0.01;
    const index = Math.floor(observedTime * 50);
    const points = spring.map((point, current) => current === index
      ? { t: observedTime, x: extremumX + direction * 3 } : point);
    expect(evaluateTrajectoryConformance(points, 'spring').verdict).toBe('pass');
    const outside = points.map((point, current) => current === index
      ? { ...point, x: point.x + direction * 0.000001 } : point);
    expect(evaluateTrajectoryConformance(outside, 'spring').verdict).toBe('fail');
  });

  it('clamps the early time envelope and linear completion before adding pixel tolerance', () => {
    for (const [time, boundary, outside] of [[0, -3, -3.001], [2.4, 603, 603.001]]) {
      const points = sample((t) => t === time ? boundary! : linear(t));
      expect(evaluateTrajectoryConformance(points, 'linear').verdict).toBe('pass');
      expect(evaluateTrajectoryConformance(points.map((point) => point.t === time
        ? { ...point, x: outside! } : point), 'linear').verdict).toBe('fail');
    }
  });

  it('does not infer continuous motion from sparse perfect observations', () => {
    const points = [0, 0.6, 1.2, 1.8, 2.4].map((t) => ({ t, x: linear(t) }));
    expect(evaluateTrajectoryConformance(points, 'linear')).toMatchObject({
      verdict: 'inconclusive', reason: 'observation-gap-exceeds-contract', samples: 5,
    });
  });

  it.each(['leading', 'trailing', 'interior'])('rejects a %s coverage hole', (location) => {
    const points = sample(linear).filter((point) => location === 'leading' ? point.t >= 0.06
      : location === 'trailing' ? point.t <= 2.34 : point.t < 0.6 || point.t > 0.66);
    expect(evaluateTrajectoryConformance(points, 'linear').verdict).toBe('inconclusive');
  });

  it('includes leading and trailing gaps in the 50 ms coverage budget', () => {
    const times = Array.from({ length: 47 }, (_, index) => (index + 1) / 20);
    const points = times.map((t) => ({ t, x: linear(t) }));
    const result = evaluateTrajectoryConformance(points, 'linear');
    expect(result.verdict).toBe('pass');
    expect(result.maxGapMs).toBeCloseTo(50, 10);
    for (const index of [0, points.length - 1]) {
      const moved = points.map((point, current) => current === index
        ? { t: point.t + (index === 0 ? 1 : -1) * 0.000001,
          x: linear(point.t + (index === 0 ? 1 : -1) * 0.000001) } : point);
      expect(evaluateTrajectoryConformance(moved, 'linear').verdict).toBe('inconclusive');
    }
  });

  it('does not let observations outside the window close missing endpoints', () => {
    const outsideOnly = [{ t: -0.001, x: 0 }, { t: 2.401, x: 600 }];
    expect(evaluateTrajectoryConformance(outsideOnly, 'linear')).toMatchObject({
      verdict: 'inconclusive', reason: 'no-observations-in-window', samples: 0, maxGapMs: 2400,
    });
    const interior = sample(linear).filter((point) => point.t >= 0.06 && point.t <= 2.34);
    expect(evaluateTrajectoryConformance([outsideOnly[0], ...interior, outsideOnly[1]], 'linear')
      .verdict).toBe('inconclusive');
    expect(evaluateTrajectoryConformance([
      { t: -1, x: 999 }, ...sample(linear), { t: 3, x: -999 },
    ], 'linear')).toMatchObject({ verdict: 'pass', samples: 121, maxErrorPx: 0 });
  });

  it('preserves a definite violation when valid observations also have coverage gaps', () => {
    expect(evaluateTrajectoryConformance([{ t: 1, x: 0 }], 'linear')).toMatchObject({
      verdict: 'fail', reason: 'position-outside-contract', samples: 1, maxErrorPx: 250,
    });
  });

  it.each([
    ['missing array', undefined], ['null', null], ['object', {}],
    ['empty', []], ['sparse', Array(3)], ['missing point', [undefined]],
    ['missing coordinate', [{ t: 0 }]], ['null point', [null]],
    ['string time', [{ t: '0', x: 0 }]], ['string coordinate', [{ t: 0, x: '0' }]],
    ['NaN time', [{ t: Number.NaN, x: 0 }]], ['infinite time', [{ t: Infinity, x: 0 }]],
    ['NaN coordinate', [{ t: 0, x: Number.NaN }]],
    ['infinite coordinate', [{ t: 0, x: -Infinity }]],
    ['duplicate time', [{ t: 0, x: 0 }, { t: 0, x: 1 }]],
    ['reversed time', [{ t: 1, x: 250 }, { t: 0, x: 0 }]],
  ])('returns a JSON-safe inconclusive verdict for %s', (_label, points) => {
    const result = evaluateTrajectoryConformance(points, 'linear');
    expect(result.verdict).toBe('inconclusive');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('invalidates the whole capture before considering apparent violations', () => {
    for (const invalid of [
      [{ t: 1, x: 0 }, { t: 1, x: 250 }],
      [{ t: 1, x: 0 }, { t: 3, x: Number.NaN }],
    ]) {
      expect(evaluateTrajectoryConformance(invalid, 'linear')).toMatchObject({
        verdict: 'inconclusive', maxErrorPx: null, maxGapMs: null,
      });
    }
    expect(evaluateFreezeConformance('lab', {})).toMatchObject({
      baseline: { verdict: 'inconclusive' }, blocked: { verdict: 'inconclusive' },
    });
  });
});
