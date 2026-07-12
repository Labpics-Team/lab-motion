/**
 * Публичный фасад compositor: ядро не зависит от дополнительных композиций,
 * поэтому новые возможности не могут замкнуть граф импортов через этот barrel.
 */

export * from './core.js';
export {
  compileStaggerPlan,
  CompositorStaggerGroup,
  type CompositorStaggerOptions,
  type CompositorStaggerPlan,
  type CompositorStaggerGroupOptions,
} from './stagger.js';
