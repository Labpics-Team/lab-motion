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
import type { SurfaceGeneration } from './coordinator.js';
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

/** Первый значимый input intent: finish раскрывает committed DOM завершением,
 * cancel — отменой; block игнорирует input до терминального состояния. */
export type SurfaceInputPolicy = 'finish' | 'cancel' | 'block';

/** V1: preserve-start для bounded list viewport; none — без коррекции. */
export type SurfaceScrollAnchor = 'preserve-start' | 'none';

export interface SurfaceTargetLike {
  readonly style: {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
    removeProperty?(name: string): void;
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
  /** Default 'finish': первый input intent раскрывает committed DOM. */
  readonly inputPolicy?: SurfaceInputPolicy | undefined;
  /** Default 'preserve-start': коррекция scroll внутри commit barrier. */
  readonly scrollAnchor?: SurfaceScrollAnchor | undefined;
  /** FutureLayoutTransaction.commit: конечное изменение state/DOM.
   * По умолчанию — единственный inline-width commit. */
  readonly commit?: (() => void | Promise<void>) | undefined;
}

/** Same-document View Transition host: capability определяется экспериментом
 * (startViewTransition может отсутствовать), CSS-инжект обязателен всегда. */
export interface SurfaceHostLike {
  injectCss?(css: string): void;
  removeCss?(): void;
  startViewTransition?(update: () => void | Promise<void>): unknown;
}

export interface SurfaceSeams extends SurfaceObserverClock {
  /** Барьер commit: по умолчанию один доставленный кадр. */
  readonly commitBarrier?: (() => Promise<void>) | undefined;
  /** Scroll anchor: чтение позиции ДО commit. */
  readonly getScroll?: (() => number) | undefined;
  /** Scroll anchor: запись позиции внутри commit barrier. */
  readonly scrollTo?: ((position: number) => void) | undefined;
  /** Input policy: подписка на первый значимый intent; возврат — cleanup. */
  readonly onInputIntent?: ((handler: () => void) => () => void) | undefined;
  /** Document-scoped coordinator generation (terminal authority). */
  readonly generation?: SurfaceGeneration | undefined;
  /** VT host: generated CSS входит в consumer total; cleanup на terminal. */
  readonly host?: SurfaceHostLike | undefined;
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
  let inputCleanup: (() => void) | undefined;
  let hostCssInjected = false;
  const generation = seams.generation;

  const finalize = (terminal: SurfaceState): void => {
    if (state === 'released' || state === 'canceled' || state === 'failed') return;
    state = terminal;
    for (const effect of effects) {
      try { effect.cancel(); } catch { /* эффект уже завершён */ }
    }
    observer?.stop();
    inputCleanup?.();
    inputCleanup = undefined;
    // Terminal cleanup: временные CSS rules и имя снимаются ровно один раз,
    // style element после завершения не остаётся (спека «VIEW TRANSITION HOST»).
    if (hostCssInjected) {
      hostCssInjected = false;
      seams.host?.removeCss?.();
    }
    target.style.removeProperty?.('view-transition-name');
    // Terminal authority coordinator'а: опубликованная generation — finish,
    // неопубликованная (snap/skip) — skip; cleanup ровно один раз.
    if (generation !== undefined && !generation.released) {
      if (generation.published) generation.finish();
      else generation.skip();
    }
    // Терминальный путь не оставляет висящих awaiter'ов: на happy path оба
    // уже зарезолвлены, на failed/canceled это no-op-страховка контракта.
    ready.resolve();
    committed.resolve();
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
  // Scroll anchor: позиция фиксируется ДО commit, корректируется в barrier.
  const scroll0 = options.scrollAnchor !== 'none' && seams.getScroll !== undefined
    ? seams.getScroll()
    : undefined;

  const barrier = seams.commitBarrier ?? (() => Promise.resolve());

  // Commit уходит в microtask: старый визуальный state захвачен до него, а
  // барьер продолжается ДО резолва committed, чтобы наблюдатель committed
  // видел уже начавшийся capture-new/running, а не застрявший committing.
  void Promise.resolve().then(() => {
    if (canceled) return;
    state = 'committing';
    // Единственный commit конечного layout (либо FutureLayoutTransaction).
    // При наличии same-document VT capability commit проходит внутри
    // startViewTransition; host throw не ломает transaction (commit уже
    // применён) — capability определяется экспериментом, не предположением.
    const applyCommit = (): void | Promise<void> => (options.commit !== undefined
      ? options.commit()
      : target.style.setProperty('width', `${toWidth}px`));
    const host = seams.host;
    const commitResult = host?.startViewTransition !== undefined
      ? host.startViewTransition(applyCommit)
      : applyCommit();
    generation?.commit();

    return Promise.resolve(commitResult).then(() => barrier()).then(() => {
      if (canceled) return;
      // Scroll correction выполняется внутри commit barrier.
      if (scroll0 !== undefined && seams.scrollTo !== undefined) {
        seams.scrollTo(scroll0);
      }
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
      // Generated CSS (отключение UA-анимаций псевдодерева) инжектится до
      // старта effects: Lab Motion effects стартуют только после готовности
      // host. Removal — ровно один раз в finalize.
      if (generation !== undefined && seams.host?.injectCss !== undefined) {
        seams.host.injectCss(generation.generatedCss);
        hostCssInjected = true;
      }
      startEffects(target, artifact);
      ready.resolve();
      state = 'running';
      committed.resolve();

      // Input policy: первый значимый intent раскрывает committed DOM.
      // 'block' не подписывается; cleanup выполняется в finalize.
      const policy = options.inputPolicy ?? 'finish';
      if (policy !== 'block' && seams.onInputIntent !== undefined) {
        inputCleanup = seams.onInputIntent(() => {
          if (policy === 'cancel') cancel();
          else finalize('released');
        });
      }

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
    // Вызов МЕТОДОМ на элементе: оторванная ссылка animate бросает
    // Illegal invocation в реальных движках.
    const timing = { duration: artifact.durationMs, fill: 'both', delay: 0 };
    const one = 'scaleX(1)';
    const shrink = `scaleX(${artifact.fromWidth / artifact.toWidth})`;
    const grow = `scaleX(${artifact.toWidth / artifact.fromWidth})`;
    // Постоянное число effects (5), независимо от числа логических строк:
    // outer boundary scale, old/new reciprocal scale, old/new opacity.
    effects.push(el.animate!({ transform: [shrink, one] }, { ...timing, easing: artifact.easing }));
    effects.push(el.animate!({ transform: [one, shrink] }, { ...timing, easing: artifact.reciprocalEasing }));
    effects.push(el.animate!({ transform: [grow, one] }, { ...timing, easing: artifact.reciprocalEasing }));
    effects.push(el.animate!({ opacity: [1, 0] }, { ...timing, easing: artifact.blendEasing }));
    effects.push(el.animate!({ opacity: [0, 1] }, { ...timing, easing: artifact.blendEasing }));
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

  const cancel = (): void => {
    if (canceled) return;
    canceled = true;
    // Commit конечного состояния не откатывается: раскрываем committed DOM.
    finalize('canceled');
  };

  return {
    committed: committed.promise,
    ready: ready.promise,
    finished: finished.promise,
    cancel,
    get state(): SurfaceState {
      return state;
    },
    get tier(): SurfaceTier {
      return tier;
    },
  };
}
