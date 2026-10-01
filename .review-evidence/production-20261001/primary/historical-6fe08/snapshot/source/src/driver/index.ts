/**
 * driver/index.ts — S7 subpath public re-export.
 *
 * Изолированный subpath-экспорт управляемого animation driver.
 * Импортируется как `@labpics/motion/driver`.
 *
 * В бандл попадает только при явном импорте — в core-bundle НЕ включён
 * (Zero-DOM core + ESM subpath-tree-shaking, инвариант North 6).
 */
export { createDriver } from '../driver.js';
export type { AnimationControls, DriverOptions } from '../driver.js';
