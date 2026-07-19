/**
 * compiler/runtime.ts — private executor compiled-nano артефактов (#208).
 *
 * Это build-tool деталь, не runtime-tier: сюда попадают ТОЛЬКО вызовы,
 * которые compiler доказанно понизил. Математика (springLinear) — общий SSOT
 * с ./nano на build-стороне; исполнительный WAAPI-хвост НАМЕРЕННО дублирует
 * nano/index байт-в-байт по семантике: непереговорный потолок nano 1024 B
 * не оплачивает функциональную границу общего хвоста (§7.3), а паритет
 * запечатан differential-сьютом compiler-nano-lowering (C4: журнал
 * keyframes/options, reduced-политика, finished/commitStyles/cancel).
 * Любая правка хвоста здесь или в nano/index обязана пройти этот сьют.
 * Parser, IR, spring solver и compiler в модуль не входят.
 */

import type { NanoControls, NanoTarget } from '../../nano/index.js';

export type { NanoControls, NanoTarget } from '../../nano/index.js';

/** Компактная форма, которую инъецирует compiler: opacity/durationMs/easing. */
export interface CompiledNanoCall {
  readonly o: number;
  readonly d: number;
  readonly e: string;
}

export function animateCompiled(target: NanoTarget, artifact: CompiledNanoCall): NanoControls {
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  const reduced = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animations = Array.from(source, (element) => {
    const animation = element.animate({ opacity: artifact.o }, {
      duration: reduced ? 0 : artifact.d,
      easing: reduced ? 'linear' : artifact.e,
      delay: 0,
      fill: 'both',
    });
    return animation;
  }) as NanoControls;
  animations.finished = Promise.all(animations.map((animation) => new Promise<Animation>((resolve, reject) => {
    animation.finished.catch(reject);
    animation.addEventListener('finish', () => {
      try {
        animation.commitStyles();
        animation.cancel();
      } catch { /* fill сохраняет финал на платформе без commitStyles */ }
      resolve(animation);
    });
  })));
  return animations;
}
