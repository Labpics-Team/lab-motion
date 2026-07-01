/**
 * @labpics/motion/lit — Lit 3 bindings for the headless motion engine.
 *
 * Subpath export: import { MotionController, LabMotionSpringElement } from '@labpics/motion/lit'
 *
 * Zero runtime dependencies — lit is a peerDependency only (types-only import
 * in controller.ts + runtime import in element.ts, both isolated to this
 * subpath; the core bundle never imports './lit').
 *
 * Two layers:
 *   - MotionController — idiomatic Lit ReactiveController for use inside any
 *     LitElement (or any ReactiveControllerHost): `new MotionController(this, 0)`.
 *   - LabMotionSpringElement (`<lab-motion-spring>`) — generic custom-element
 *     wrapper over the same controller, usable framework-agnostically (plain
 *     HTML/JS, no build step required beyond importing this module).
 *
 * SSR-safe: no window/document/customElements access at module top level
 * beyond typeof-guarded feature checks — safe to import under Node/SSR.
 */

export { MotionController, type MotionControllerOptions, type MatchMediaFn } from './controller.js';
export { LabMotionSpringElement, LAB_MOTION_SPRING_TAG } from './element.js';
