/**
 * decay/index.ts — S9 subpath public re-export.
 *
 * Изолированный subpath-экспорт headless exponential decay/inertia generator.
 * Импортируется как `@labpics/motion/decay`.
 *
 * В бандл попадает только при явном импорте — в core-bundle НЕ включён
 * (Zero-DOM core + ESM subpath-tree-shaking, инвариант North 6).
 */
export { createDecay } from '../decay.js';
export type { DecayModel, DecayOptions } from '../decay.js';
