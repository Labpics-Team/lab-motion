import { describe, expect, it } from 'vitest';
import { springFromPeak, springFromOscillation } from '../src/spring/index.js';
import { spring, validateSpringParams, MotionParamError } from '../src/index.js';

describe('springFromPeak — inverse constructor from observable peak (#230)', () => {
  it('reconstructs spring where velocity is 0 and position equals peak at timeToPeak', () => {
    const timeToPeak = 0.5;
    const overshoot = 0.2; // 20% overshoot -> peak value = 1.2
    const params = springFromPeak({ timeToPeak, overshoot });

    expect(() => validateSpringParams(params)).not.toThrow();

    const atPeak = spring(params, timeToPeak);
    expect(atPeak.value).toBeCloseTo(1.2, 3);
    expect(atPeak.velocity).toBeCloseTo(0, 3);
  });

  it('supports peak specified as absolute peak value (> 1)', () => {
    const timeToPeak = 0.4;
    const peak = 1.15; // 15% overshoot
    const params = springFromPeak({ timeToPeak, peak });

    expect(() => validateSpringParams(params)).not.toThrow();

    const atPeak = spring(params, timeToPeak);
    expect(atPeak.value).toBeCloseTo(1.15, 3);
    expect(atPeak.velocity).toBeCloseTo(0, 3);
  });

  it('passes mass option through correctly', () => {
    const p1 = springFromPeak({ timeToPeak: 0.5, overshoot: 0.1, mass: 1 });
    const p2 = springFromPeak({ timeToPeak: 0.5, overshoot: 0.1, mass: 2 });

    expect(p2.mass).toBe(2);
    expect(p2.stiffness).toBeCloseTo(p1.stiffness * 2, 4);
    expect(p2.damping).toBeCloseTo(p1.damping * 2, 4);
  });

  it('throws MotionParamError for invalid timeToPeak or peak/overshoot', () => {
    expect(() => springFromPeak({ timeToPeak: 0, overshoot: 0.1 })).toThrow(MotionParamError);
    expect(() => springFromPeak({ timeToPeak: -1, overshoot: 0.1 })).toThrow(MotionParamError);
    expect(() => springFromPeak({ timeToPeak: NaN, overshoot: 0.1 })).toThrow(MotionParamError);

    expect(() => springFromPeak({ timeToPeak: 0.5, overshoot: 0 })).toThrow(MotionParamError);
    expect(() => springFromPeak({ timeToPeak: 0.5, overshoot: 1 })).toThrow(MotionParamError);
    expect(() => springFromPeak({ timeToPeak: 0.5, overshoot: -0.1 })).toThrow(MotionParamError);

    expect(() => springFromPeak({ timeToPeak: 0.5, peak: 1 })).toThrow(MotionParamError);
    expect(() => springFromPeak({ timeToPeak: 0.5, peak: 2.5 })).toThrow(MotionParamError);
  });
});

describe('springFromOscillation — inverse constructor from observable oscillation (#230)', () => {
  it('reconstructs spring with specified damped period and halfLife', () => {
    const period = 0.8;
    const halfLife = 0.4;
    const params = springFromOscillation({ period, halfLife });

    expect(() => validateSpringParams(params)).not.toThrow();

    // At t = period, damped phase is 2*pi (1 full cycle)
    // Envelope ratio at t = halfLife (0.4s) should be 0.5 relative to initial displacement
    const omega0 = Math.sqrt(params.stiffness / params.mass);
    const zeta = params.damping / (2 * Math.sqrt(params.stiffness * params.mass));
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);

    expect((2 * Math.PI) / omegaD).toBeCloseTo(period, 3);
    const decayRate = zeta * omega0;
    expect(Math.exp(-decayRate * halfLife)).toBeCloseTo(0.5, 3);
  });

  it('supports frequency and decayTime parameterizations', () => {
    const frequency = 2; // 2 Hz -> period = 0.5s
    const decayTime = 0.3; // tau = 0.3s
    const params = springFromOscillation({ frequency, decayTime });

    expect(() => validateSpringParams(params)).not.toThrow();

    const omega0 = Math.sqrt(params.stiffness / params.mass);
    const zeta = params.damping / (2 * Math.sqrt(params.stiffness * params.mass));
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);

    expect(omegaD / (2 * Math.PI)).toBeCloseTo(frequency, 3);
    const decayRate = zeta * omega0;
    expect(decayRate * decayTime).toBeCloseTo(1, 3);
  });

  it('supports dampingRatio / zeta input', () => {
    const period = 1.0;
    const dampingRatio = 0.25;
    const params = springFromOscillation({ period, dampingRatio });

    expect(() => validateSpringParams(params)).not.toThrow();

    const omega0 = Math.sqrt(params.stiffness / params.mass);
    const zeta = params.damping / (2 * Math.sqrt(params.stiffness * params.mass));

    expect(zeta).toBeCloseTo(0.25, 3);
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    expect((2 * Math.PI) / omegaD).toBeCloseTo(period, 3);
  });

  it('throws MotionParamError for missing or invalid parameters', () => {
    // Missing period/frequency or missing decay spec
    expect(() => springFromOscillation({ period: 1 } as any)).toThrow(MotionParamError);
    expect(() => springFromOscillation({ halfLife: 0.5 } as any)).toThrow(MotionParamError);

    // Non-positive period/frequency
    expect(() => springFromOscillation({ period: 0, halfLife: 0.5 })).toThrow(MotionParamError);
    expect(() => springFromOscillation({ frequency: -1, halfLife: 0.5 })).toThrow(MotionParamError);

    // Invalid damping specs
    expect(() => springFromOscillation({ period: 1, halfLife: -0.1 })).toThrow(MotionParamError);
    expect(() => springFromOscillation({ period: 1, dampingRatio: 0 })).toThrow(MotionParamError);
    expect(() => springFromOscillation({ period: 1, dampingRatio: 1 })).toThrow(MotionParamError);
  });
});
