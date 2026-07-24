/**
 * compiler/runtime.ts — private executor compiled-nano артефактов (#208, #221).
 *
 * Это build-tool деталь, не runtime-tier: сюда попадают ТОЛЬКО вызовы,
 * которые compiler доказанно понизил. Математика (springLinear) — общий SSOT
 * с ./nano на build-стороне; исполнительный WAAPI-хвост НАМЕРЕННО дублирует
 * nano/index байт-в-байт по семантике: непереговорный потолок nano 1024 B
 * не оплачивает функциональную границу общего хвоста (§7.3), а паритет
 * запечатан differential-сьютом compiler-nano-lowering (C4: журнал
 * keyframes/options, delay/stagger/explicit-reduced политика,
 * finished/commitStyles/cancel). Любая правка хвоста здесь или в nano/index
 * обязана пройти этот сьют. Parser, IR, spring solver и compiler в модуль
 * не входят.
 */

import type { NanoControls, NanoTarget } from '../../nano/index.js';

export type { NanoControls, NanoTarget } from '../../nano/index.js';

/**
 * Компактная форма, которую инъецирует compiler: f — готовый кадр
 * (PropertyIndexedKeyframes-эквивалент), d/e — duration/easing, y/g —
 * delay/stagger (мс), r — статически доказанный reducedMotion (1/0;
 * отсутствие — ambient matchMedia в момент вызова, как у nano).
 */
export interface CompiledNanoCall {
  readonly f: Readonly<Record<string, number | string>>;
  readonly d: number;
  readonly e: string;
  readonly y?: number | undefined;
  readonly g?: number | undefined;
  readonly r?: 0 | 1 | undefined;
}

export function animateCompiled(target: NanoTarget, artifact: CompiledNanoCall): NanoControls {
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  // r: 0|1|undefined — `??` пропускает явный 0 как falsy (то же поведение,
  // что прежний тернарий с === 1), ambient-ветка только при отсутствии r.
  const reduced = artifact.r
    ?? (typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Один frame-объект на ВЕСЬ вызов (литерал артефакта), не на элемент —
  // паритет с nano, который строит кадр один раз.
  const frame = artifact.f as PropertyIndexedKeyframes;
  const animations = Array.from(source, (element, index) => element.animate(frame, {
    duration: reduced ? 0 : artifact.d,
    easing: reduced ? 'linear' : artifact.e,
    delay: reduced ? 0 : (artifact.y ?? 0) + (artifact.g ?? 0) * index,
    fill: 'both',
  })) as NanoControls;
  animations.finished = Promise.all(animations.map((animation) => new Promise<Animation>((resolve, reject) => {
    animation.finished.catch(reject);
    animation.addEventListener('finish', () => queueMicrotask(() => {
      animation.finished.catch(reject);
      if (animation.playState !== 'finished') return;
      try {
        animation.commitStyles();
        animation.cancel();
      } catch { /* fill сохраняет финал на платформе без commitStyles */ }
      resolve(animation);
    }));
  })));
  return animations;
}
