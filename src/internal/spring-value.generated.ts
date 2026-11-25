// Generated from solver.ts by scripts/project-spring-value.mjs. Do not edit.
import type { SpringParams } from './types.js';

export function makeSpringValueSampler(params: SpringParams, v0: number): (t: number) => number {
  const { mass: m, stiffness: k, damping: c } = params;
  const omega0 = Math.sqrt(k / m);
  const zeta = c / (2 * m * omega0);
  if (zeta < 1) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const B = (v0 - zeta * omega0) / omegaD;
    return t => {
      if (t <= 0) return 0;
      const decay = Math.exp(-zeta * omega0 * t);
      const cosD = Math.cos(omegaD * t);
      const sinD = Math.sin(omegaD * t);
      const mode = B * sinD - cosD;
      return 1 + decay * mode;
    };
  }
  if (zeta === 1) {
    const B = v0 - omega0;
    return t => {
      if (t <= 0) return 0;
      const decay = Math.exp(-omega0 * t);
      const mode = B * t - 1;
      return 1 + mode * decay;
    };
  }
  const sqrtTerm = Math.sqrt(zeta * zeta - 1);
  const r2 = -omega0 * (zeta + sqrtTerm);
  const r1 = omega0 * omega0 / r2;
  const denominator = r1 - r2;
  return t => {
    if (t <= 0) return 0;
    const e1 = Math.exp(r1 * t);
    const modalDelta = Math.expm1(-denominator * t);
    const valueV0 = (-e1 * modalDelta) / denominator;
    return -Math.expm1(r2 * t) + (r2 + v0) * valueV0;
  };
}
