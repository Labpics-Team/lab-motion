import { expect, it } from 'vitest';
import { parseCssLinear } from '../src/compositor/error-bound.js';
import { timing } from '../src/motion/model.js';
import { program, sample } from '../src/motion/program.js';
import { motionSpringCurve } from '../src/motion/spring-artifact.js';

// Independent solutions for roots −3±4i and −2,−8, respectively.
function exact(under: boolean, goal: number, speed: number, t: number): [number, number] {
  if (under) {
    const e = Math.exp(-3*t), c = Math.cos(4*t), s = Math.sin(4*t);
    return [goal + e*(-goal*c + (speed-3*goal)*s/4), e*(speed*c + (25*goal-3*speed)*s/4)];
  }
  const a = (speed-8*goal)*Math.exp(-2*t)/6, b = (2*goal-speed)*Math.exp(-8*t)/6;
  return [goal+a+b, -2*a-8*b];
}

it.each([true, false])('matches the free and driven oscillator and the emitted slope (underdamped=%s)', under => {
  const physics = under ? { mass:1, stiffness:25, damping:6 } : { mass:1, stiffness:16, damping:10 };
  const duration = 9, tolerance = 0.0001;
  for (const goal of [0, 1] as const) {
    const speed = goal ? -4 : 7;
    const effect = goal ? motionSpringCurve(physics, 1, speed, duration, tolerance) : undefined;
    const impulse = goal ? undefined : motionSpringCurve(physics, 0, speed, duration, tolerance);
    const raw = (effect?.[1] ?? impulse)!;
    expect(raw).toBeDefined();
    if (effect) {
      const stops = parseCssLinear(effect[0]).flatMap(p => [p.percent, p.progress]);
      expect(stops.map(x => x + 0)).toEqual([...raw].map(x => x + 0));
    }
    expect([raw[0], raw[1]! + 0, raw.at(-2), raw.at(-1)]).toEqual([0, 0, 100, goal]);
    expect(raw[3]!/(raw[2]!/100*duration)).toBeCloseTo(speed, 11);
    const base = program('x', { _coordinates:[0], _unit:'' }, [goal], false, timing({spring:physics}), [speed]);
    const path = { ...base, _duration:1000*duration, _segments:[
      { ...base._segments[0]!, _end:1000*duration, _artifact:effect, ...(impulse ? {_impulse:impulse} : {}) }
    ] };
    const position = [0], velocity = [0];
    let worst = 0;
    for (let i = 2; i < raw.length; i += 2) {
      const t0 = raw[i-2]!/100*duration, t1 = raw[i]!/100*duration;
      expect(t1).toBeGreaterThan(t0);
      for (const fraction of [.17, .5, .82]) {
        const t = t0+(t1-t0)*fraction;
        sample(path,t*1000,position,velocity);
        worst = Math.max(worst, Math.abs(position[0]!-exact(under,goal,speed,t)[0]));
        const slope = (raw[i+1]!-raw[i-1]!)/(t1-t0);
        expect(velocity[0]).toBeCloseTo(slope,8);
        if (t0 <= .4 && .4 < t1) expect(Math.abs(velocity[0]!-exact(under,goal,speed,t)[1])).toBeLessThan(.15);
      }
    }
    expect(worst).toBeLessThanOrEqual(tolerance);
    sample(path,1000*duration,position,velocity);
    expect([position[0],velocity[0]]).toEqual([goal,0]);
  }
});

it.each([-1e-9,1e-9])('retains the first tangent of a small nonzero impulse %i', speed => {
  const duration = 2;
  const stops = motionSpringCurve({mass:1,stiffness:25,damping:10},0,speed,duration,.05)!;
  expect(stops.length).toBeGreaterThanOrEqual(6);
  expect(stops[2]!).toBeGreaterThan(0);
  expect(stops[2]!).toBeLessThan(100);
  expect(Math.abs((stops[3]!/(stops[2]!/100*duration))/speed-1)).toBeLessThan(1e-12);
});
