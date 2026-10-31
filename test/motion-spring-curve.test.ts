import { expect, it } from 'vitest';
import { impulseSamples } from '../src/compositor/segmenter.js';
import { sampleSerializedSpringIntoUnchecked } from '../src/compositor/sample.js';

it.each([true, false])('bounds the free impulse between knots (underdamped=%s)', under => {
  const physics = under ? {mass:1, stiffness:25, damping:6} : {mass:1, stiffness:16, damping:10};
  const duration = 9, speed = 7, tolerance = 0.01;
  const raw = impulseSamples(physics, speed, duration, tolerance)!;
  expect(raw).toBeDefined();
  expect([raw[0], raw[1], raw.at(-2), raw.at(-1)]).toEqual([0,0,100,0]);
  const actual = {value:0, velocity:0};
  let worst = 0;
  for (let i = 2; i < raw.length; i += 2) {
    const t0 = raw[i-2]!/100*duration, t1 = raw[i]!/100*duration;
    expect(t1).toBeGreaterThan(t0);
    for (const fraction of [.17,.5,.82]) {
      const t = t0 + (t1-t0)*fraction;
      // The characteristic roots are −3±4i and −2,−8 respectively.
      const physical = under ? speed*Math.exp(-3*t)*Math.sin(4*t)/4 :
        speed*(Math.exp(-2*t)-Math.exp(-8*t))/6;
      sampleSerializedSpringIntoUnchecked(raw, duration*1000, t*1000, 0, actual);
      worst = Math.max(worst, Math.abs(actual.value-physical));
      expect(actual.velocity).toBeCloseTo((raw[i+1]!-raw[i-1]!)/(t1-t0),8);
    }
  }
  expect(worst).toBeLessThanOrEqual(tolerance);
});

it.each([-1e-9,1e-9])('retains the first tangent of a small nonzero impulse %i', speed => {
  const duration = 2;
  const stops = impulseSamples({mass:1,stiffness:25,damping:10},speed,duration,.05)!;
  expect(stops.length).toBeGreaterThanOrEqual(6);
  expect(stops[2]!).toBeGreaterThan(0);
  expect(stops[2]!).toBeLessThan(100);
  expect(Math.abs((stops[3]!/(stops[2]!/100*duration))/speed-1)).toBeLessThan(1e-12);
});
