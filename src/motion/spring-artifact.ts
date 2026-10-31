import { sampleSpringBasisUnchecked } from '../internal/solver.js';
import type { SpringParams } from '../internal/types.js';
import { BASE_GRID_MAX, fitsSpringCurveBudget, springCompileHorizon } from '../compositor/segmenter.js';
import type { SpringExecutionArtifactTuple } from '../compositor/curve.js';
import { createSpringLinearCacheState, DEFAULT_CACHE_CAPACITY, lookupSpringLinearCache, storeSpringLinearCache } from '../compositor/cache.js';

const cache = /* @__PURE__ */ createSpringLinearCacheState<SpringExecutionArtifactTuple>(DEFAULT_CACHE_CAPACITY);
const basis = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };

/** A step targets one, a free impulse targets zero. Both start at zero with velocity v0. */
export function motionSpringCurve(physics: SpringParams, goal: 0, v0: number, duration: number, tolerance: number): Float64Array | undefined;
export function motionSpringCurve(physics: SpringParams, goal: 1, v0: number, duration: number, tolerance: number): SpringExecutionArtifactTuple | undefined;
export function motionSpringCurve(physics: SpringParams, goal: 0 | 1, v0: number, duration: number, tolerance: number): SpringExecutionArtifactTuple | Float64Array | undefined {
  const omega = Math.sqrt(physics.stiffness / physics.mass);
  const acceleration = Math.hypot(omega, physics.damping / physics.mass);
  const precision = 10 ** Math.ceil(Math.log10(8 / tolerance));
  const samples: number[] = [];
  let percent = 0, easing = 'linear(';
  while (samples.length < 2*BASE_GRID_MAX) {
    const time = percent / 100 * duration;
    sampleSpringBasisUnchecked(physics, time, basis);
    const position = goal*basis._value + v0*basis._valueV0;
    const velocity = goal*basis._velocity + v0*basis._velocityV0;
    if (!Number.isFinite(position) || !Number.isFinite(velocity)) return;
    const end = percent === 100;
    if (end && Math.abs(position-goal) > tolerance/8) return;
    const rounded = Math.round(position * precision) / precision;
    const point = end ? goal : samples.length === 2 ? v0*time :
      goal && Number.isFinite(rounded) ? rounded : position;
    samples.push(percent,point);
    if (goal) easing += (percent ? ',' : '') + point + (percent && !end ? ' ' + percent + '%' : '');
    if (end) {
      const stops = Float64Array.from(samples);
      return goal ? [easing + ')', stops, duration * 1000] : stops;
    }

    // E = (ω(x−goal))²+v² decreases. Cauchy bounds |x''| throughout the next interval.
    const bound = acceleration * Math.hypot(omega*(position-goal), velocity);
    const step = Math.sqrt((percent ? 4 : .25)*tolerance/bound) / duration * 100;
    const limit = Math.min(percent ? 100 : 50, percent + step);
    // Choose the actual knot before evaluating the spring. Rounding down never lengthens a chord.
    const scale = 10 ** Math.ceil(Math.log10(2 / (limit - percent)));
    const short = Math.floor(limit * scale) / scale;
    const next = limit === 100 || !(short > percent && short <= limit) ? limit : short;
    if (!(next > percent)) return;
    percent = next;
  }
  return;
}

export function tryMotionSpring(physics: SpringParams, velocity: number, tolerance: number): SpringExecutionArtifactTuple | undefined {
  const { mass, stiffness, damping } = physics;
  const hit = lookupSpringLinearCache(cache, mass, stiffness, damping, velocity, tolerance);
  if (hit) return hit;
  if (!fitsSpringCurveBudget(physics, velocity, tolerance)) return;
  const curve = motionSpringCurve(physics, 1, velocity, springCompileHorizon(physics, velocity, tolerance), tolerance);
  if (curve) storeSpringLinearCache(cache, mass, stiffness, damping, velocity, tolerance, curve);
  return curve;
}
