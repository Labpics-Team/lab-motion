import { sampleSpringBasisUnchecked } from '../internal/solver.js';
import type { SpringParams } from '../internal/types.js';
import { BASE_GRID_MAX, fitsSpringCurveBudget, springCompileHorizon, type SpringNode } from '../compositor/segmenter.js';
import { emitArtifact, type SpringExecutionArtifactTuple } from '../compositor/curve.js';
import { createSpringLinearCacheState, DEFAULT_CACHE_CAPACITY, lookupSpringLinearCache, storeSpringLinearCache } from '../compositor/cache.js';

const cache = /* @__PURE__ */ createSpringLinearCacheState<SpringExecutionArtifactTuple>(DEFAULT_CACHE_CAPACITY);
const basis = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };

/** For a free spring E = (ω(x−goal))² + v² decreases, so the left boundary bounds the entire chord error. */
export function motionSpringNodes(physics: SpringParams, goal: number, v0: number, duration: number, tolerance: number): SpringNode[] | undefined {
  const omega = Math.sqrt(physics.stiffness / physics.mass), acceleration = Math.hypot(omega, physics.damping / physics.mass);
  const nodes: SpringNode[] = [];
  let t = 0, firstTime = 0;
  for (;;) {
    sampleSpringBasisUnchecked(physics, t, basis);
    const position = goal*basis._value + v0*basis._valueV0;
    const velocity = goal*basis._velocity + v0*basis._velocityV0;
    if (!Number.isFinite(position) || !Number.isFinite(velocity)) return;
    if (t === duration) {
      if (Math.abs(position - goal) > tolerance/8) return;
      nodes.push({progress:goal,percent:100});
      return nodes;
    }
    const percent = t/duration*100;
    nodes.push({progress:t===firstTime ? v0*(percent/100*duration) : position, percent});
    const bound=acceleration*Math.hypot(omega*(position-goal),velocity);
    const next=Math.min(duration,t + Math.sqrt((t===0 ? .25 : 4)*tolerance/bound));
    if (!(next>t) || nodes.length>=BASE_GRID_MAX) return;
    if (t===0) firstTime=next;
    t=next;
  }
}

export function tryMotionSpring(physics:SpringParams, v0:number, tolerance:number):SpringExecutionArtifactTuple | undefined {
  const {mass,stiffness,damping}=physics;
  const hit=lookupSpringLinearCache(cache,mass,stiffness,damping,v0,tolerance);
  if(hit) return hit;
  if (!fitsSpringCurveBudget(physics,v0,tolerance)) return;
  const duration=springCompileHorizon(physics,v0,tolerance);
  const nodes=motionSpringNodes(physics,1,v0,duration,tolerance);
  if (!nodes) return;
  const result=emitArtifact(nodes,tolerance,duration*1000);
  storeSpringLinearCache(cache,mass,stiffness,damping,v0,tolerance,result);
  return result;
}
