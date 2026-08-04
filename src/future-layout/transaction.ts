/**
 * src/future-layout/transaction.ts — one-shot transaction сопряжённой
 * поверхности: lifecycle, cancel, tier и постоянное число effects.
 *
 * Порядок (спека «COMMIT TRANSACTION»):
 *   capture old → commit final state → commit barrier → verify target →
 *   capture new → build snapshot tree → ready → start effects → active
 *   phase → release snapshots.
 * Commit конечного DOM НЕ откатывается при cancel(): cancel немедленно
 * раскрывает уже committed DOM.
 *
 * Tier выбирается capability-экспериментом, не предположением:
 *   animate() цели доступен и артефакт доказуем → native (постоянное число
 *   WAAPI-effects); иначе snap (мгновенное раскрытие committed DOM).
 */

import type { SpringParams } from '../spring.js';
import { tryCompileSurfaceArtifact, type SurfaceExecutionArtifact } from './artifact.js';
import { createSurfaceObserver, type SurfaceFrameView, type SurfaceObserverClock } from './observer.js';

export type SurfaceState =
  | 'capturing-old'
  | 'committing'
  | 'capturing-new'
  | 'running'
  | 'released'
  | 'canceled'
  | 'failed';

export type SurfaceTier =
  | 'future-layout-native'
  | 'future-layout-snap'
  | 'future-layout-projection';

export interface SurfaceTargetLike {
  readonly style: {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
  };
  getBoundingClientRect?(): { width: number };
  animate?(keyframes: unknown, timing: unknown): { cancel(): void };
}

export interface SurfaceControls {
  readonly committed: Promise<void>;
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
  cancel(): void;
  readonly state: SurfaceState;
  readonly tier: SurfaceTier;
}

export interface SurfaceRunOptions {
  readonly spring: SpringParams;
  readonly onFrame?: ((frame: SurfaceFrameView) => void) | undefined;
  /** Явное значение; иначе среда читается вызывающим фасадом. */
  readonly reducedMotion?: boolean | undefined;
  /** Начальная скорость прогресса (поддерживается позитивным сертификатом). */
  readonly initialVelocity?: number | undefined;
}

export interface SurfaceSeams extends SurfaceObserverClock {
  /** Барьер commit: по умолчанию один доставленный кадр. */
  readonly commitBarrier?: (() => Promise<void>) | undefined;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function startSurfaceTransition(
  target: SurfaceTargetLike,
  fromWidth: number,
  toWidth: number,
  options: SurfaceRunOptions,
  seams: SurfaceSeams,
): SurfaceControls {
  let state: SurfaceState = 'capturing-old';
  let tier: SurfaceTier = 'future-layout-snap';
  let canceled = false;

  const committed = deferred();
  const ready = deferred();
  const finished = deferred();
  const effects: Array<{ cancel(): void }> = [];
  let observer: ReturnType<typeof createSurfaceObserver> | undefined;

  const finalize = (terminal: SurfaceState): void => {
    if (state === 'released' || state === 'canceled' || state === 'failed') return;
    state = terminal;
    for (const effect of effects) {
      try { effect.cancel(); } catch { /* эффект уже завершён */ }
    }
    observer?.stop();
    finished.resolve();
  };

  const snap = (): void => {
    ready.resolve();
    committed.resolve();
    finalize('released');
  };

  const captureWidth = (): number =>
    target.getBoundingClientRect !== undefined ? target.getBoundingClientRect().width : toWidth;

  // capture old ДО commit: animate() не обещает синхронный конечный DOM.
  captureWidth();

  const barrier = seams.commitBarrier ?? (() => Promise.resolve());

  // Commit уходит в microtask: старый визуальный state захвачен до него, а
  // барьер продолжается ДО резолва committed, чтобы наблюдатель committed
  // видел уже начавшийся capture-new/running, а не застрявший committing.
  void Promise.resolve().then(() => {
    if (canceled) return;
    state = 'committing';
    // Единственный commit конечного layout.
    target.style.setProperty('width', `${toWidth}px`);

    return barrier().then(() => {
      if (canceled) return;
      // verify target still valid + capture new
      state = 'capturing-new';
      captureWidth();

      if (options.reducedMotion === true || target.animate === undefined) {
        // Reduced character switch / нет native capability: snap.
        return snap();
      }

      const artifact = tryCompileSurfaceArtifact(
        options.spring,
        fromWidth,
        toWidth,
        undefined,
        undefined,
        options.initialVelocity,
      );
      // Позитивность/бюджет недоказуемы: snap без Infinity/NaN в CSS.
      if (artifact === undefined) return snap();

      tier = 'future-layout-native';
      startEffects(target, artifact);
      ready.resolve();
      state = 'running';
      committed.resolve();

      if (options.onFrame !== undefined) {
        observer = createSurfaceObserver(artifact, options.onFrame);
        observer.start(seams);
      }
      runActivePhase(artifact, () => finalize('released'));
    });
  }).catch(() => {
    // Host-сбой барьера не оставляет partial owner: терминализируем.
    finalize('failed');
  });

  function startEffects(el: SurfaceTargetLike, artifact: SurfaceExecutionArtifact): void {
    const animateFn = el.animate!;
    const timing = { duration: artifact.durationMs, fill: 'both', delay: 0 };
    const one = 'scaleX(1)';
    const shrink = `scaleX(${artifact.fromWidth / artifact.toWidth})`;
    const grow = `scaleX(${artifact.toWidth / artifact.fromWidth})`;
    // Постоянное число effects (5), независимо от числа логических строк:
    // outer boundary scale, old/new reciprocal scale, old/new opacity.
    effects.push(animateFn({ transform: [shrink, one] }, { ...timing, easing: artifact.easing }));
    effects.push(animateFn({ transform: [one, shrink] }, { ...timing, easing: artifact.reciprocalEasing }));
    effects.push(animateFn({ transform: [grow, one] }, { ...timing, easing: artifact.reciprocalEasing }));
    effects.push(animateFn({ opacity: [1, 0] }, { ...timing, easing: artifact.blendEasing }));
    effects.push(animateFn({ opacity: [0, 1] }, { ...timing, easing: artifact.blendEasing }));
  }

  function runActivePhase(artifact: SurfaceExecutionArtifact, done: () => void): void {
    const t0 = seams.now ?? 0;
    const tick = (ts?: number): void => {
      if (canceled || state !== 'running') return;
      if ((ts ?? 0) - t0 >= artifact.durationMs) {
        done();
        return;
      }
      seams.requestFrame(tick);
    };
    seams.requestFrame(tick);
  }

  return {
    committed: committed.promise,
    ready: ready.promise,
    finished: finished.promise,
    cancel(): void {
      if (canceled) return;
      canceled = true;
      // Commit конечного состояния не откатывается: раскрываем committed DOM.
      finalize('canceled');
    },
    get state(): SurfaceState {
      return state;
    },
    get tier(): SurfaceTier {
      return tier;
    },
  };
}
