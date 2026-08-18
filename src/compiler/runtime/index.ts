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

/**
 * Компактная форма, которую инъецирует compiler (#221): готовый frame, тайминг
 * и политика исполнения. Производитель — только одноверсионный compiler,
 * формат не публичный контракт: артефакт и импорт эмитятся одной сборкой.
 */
export interface CompiledNanoCall {
  /** Канонизированный PropertyIndexedKeyframes-эквивалент (to-only). */
  readonly f: Readonly<Record<string, string | number>>;
  readonly d: number;
  readonly e: string;
  /** delay в мс; отсутствие = 0. */
  readonly y?: number | undefined;
  /** stagger в мс на индекс элемента; отсутствие = 0. */
  readonly g?: number | undefined;
  /** Явная reduced-политика; отсутствие = ambient prefers-reduced-motion. */
  readonly r?: boolean | undefined;
}

export function animateCompiledNano(target: NanoTarget, artifact: CompiledNanoCall): NanoControls {
  const { f, d, e, y = 0, g = 0, r } = artifact;
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  const reduced = r
    ?? (typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Один frame-объект на вызов: литерал артефакта разделяется всеми элементами.
  const animations = Array.from(source, (element, index) => element.animate(f, {
    duration: reduced ? 0 : d,
    easing: reduced ? 'linear' : e,
    delay: reduced ? 0 : y + g * index,
    fill: 'both',
  })) as NanoControls;
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

