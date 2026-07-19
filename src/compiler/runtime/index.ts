/**
 * compiler/runtime.ts — private executor compiled-nano артефактов (#208).
 *
 * Это build-tool деталь, не runtime-tier: сюда попадают ТОЛЬКО вызовы,
 * которые compiler доказанно понизил. Исполнительный хвост — общий runNano
 * (SSOT c ./nano): reduced-motion, native WAAPI lifecycle, `finished`,
 * `commitStyles()` и `cancel()` совпадают с runtime по построению.
 * Parser, IR, spring solver и compiler в этот модуль не входят.
 */

import { runNano, type NanoControls, type NanoTarget } from '../../nano/run.js';

export type { NanoControls, NanoTarget } from '../../nano/run.js';

/** Компактная форма, которую инъецирует compiler: opacity/durationMs/easing. */
export interface CompiledNanoCall {
  readonly o: number;
  readonly d: number;
  readonly e: string;
}

export function animateCompiled(target: NanoTarget, artifact: CompiledNanoCall): NanoControls {
  // Та же политика ./nano: prefers-reduced-motion читается в момент вызова
  // (двухстрочная platform-читалка намеренно дублируется — см. nano/index).
  const reduced = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return runNano(target, { opacity: artifact.o }, artifact.d, artifact.e, 0, 0, reduced);
}
