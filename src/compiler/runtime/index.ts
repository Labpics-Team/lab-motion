/**
 * Executor for animation programs specialized at build time.
 * Native playback retains its browser contract; completion follows one shared law.
 * No solver, parser, or compiler enters the delivered runtime graph.
 */

import { nativeFinished } from '../../internal/native-finished.js';
import type { NativeControls, NativeTarget } from '../../native/index.js';

export type { NativeControls, NativeTarget } from '../../native/index.js';

/** Компактная форма, которую инъецирует compiler: opacity/durationMs/easing. */
export interface CompiledNativeCall {
  readonly o: number;
  readonly d: number;
  readonly e: string;
}

export function animateCompiled(target: NativeTarget, artifact: CompiledNativeCall): NativeControls {
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const animations = Array.from(source, (element) => element.animate({ opacity: artifact.o }, {
      duration: reduced ? 0 : artifact.d,
      easing: reduced ? 'linear' : artifact.e,
      delay: 0,
      fill: 'both',
    })) as NativeControls;
  animations.finished = Promise.all(animations.map(nativeFinished));
  return animations;
}
