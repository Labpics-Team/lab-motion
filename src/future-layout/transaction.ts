/**
 * src/future-layout/transaction.ts — one-shot transaction сопряжённой
 * поверхности: lifecycle, cancel, tier и постоянное число effects.
 *
 * Порядок (спека «COMMIT TRANSACTION»):
 *   capture old → commit final state → commit barrier → verify target →
 *   capture new → build snapshot tree → ready → start effects → active
 *   phase → release snapshots.
 * Commit конечного DOM НЕ откатывается при cancel(): cancel немедленно
 * раскрывает уже committed DOM (skipTransition снимает snapshot-плоскости).
 *
 * Representation (эмпирически сертифицирована в browser): сопряжённая
 * геометрия G·F_j·R_j=1 живёт в pseudo-tree same-document View Transition —
 * 5 генерируемых CSS-анимаций (group scale, old scale+opacity, new
 * scale+opacity) на ::view-transition-group/old/new. WAAPI-pseudoElement в
 * Chromium не исполняется (animation создаётся, но не влияет на рендер и не
 * продлевает transition), поэтому нативный tier — только generated CSS
 * (compositor-driven transform/opacity, off-main). Pseudo-модель
 * сертифицируется экспериментом: group-бокс обязан равняться committed ширине
 * (host-fit B=W1); иначе — snap без Infinity/NaN в CSS.
 *
 * Tier выбирается capability-экспериментом, не предположением:
 *   VT доступен + модель псевдодерева доказана + артефакт доказуем →
 *   native (постоянное число CSS-effects = 5); иначе snap (мгновенное
 *   раскрытие committed DOM).
 *
 * Terminal authority: vt.finished (transition завершается, когда все
 * CSS-анимации псевдодерева закончились). Без observer в active phase не
 * планируется ни одного rAF (спека «OBSERVER CLOCK»).
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
    removeProperty?(name: string): string;
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

/** Same-document View Transition: структурный контракт (thenable-совместимый
 * ready/finished, skipTransition). Capability определяется экспериментом. */
export interface SurfaceViewTransitionLike {
  readonly ready?: Promise<void> | undefined;
  readonly finished?: Promise<void> | undefined;
  skipTransition?(): void;
}

/** Same-document View Transition host: capability определяется экспериментом
 * (startViewTransition может отсутствовать), CSS-инжект обязателен всегда.
 * injectCss аддитивен: повторный вызов дополняет тот же временный stylesheet. */
export interface SurfaceHostLike {
  injectCss?(css: string): void;
  removeCss?(): void;
  startViewTransition?(update: () => void | Promise<void>): unknown;
}

/** Сертифицированная pseudo-модель host: ширина group-бокса (база B) и
 * placement-transform group, который обязан сохраниться в keyframes. */
export interface SurfacePseudoModel {
  readonly groupWidth: number;
  readonly placement: string;
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
  /** Capability/model эксперимент: сертифицированная pseudo-модель
   * (читается после VT-ready); undefined — модель недоказуема → snap. */
  readonly readPseudoModel?: ((name: string) => SurfacePseudoModel | undefined) | undefined;
}

/** Допуск сертификации базы B: group-бокс равен committed ширине. */
const MODEL_CERT_TOLERANCE_PX = 0.5;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const thenable = (value: unknown): value is PromiseLike<void> =>
  value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function';

/** 5 генерируемых CSS-анимаций псевдодерева (постоянное число effects):
 * group — внешний scale G(t)=W(t)/B; old/new — counter-scale R_j и opacity
 * crossfade. transform-origin: left top: граница растёт от левого края,
 * placement group сохранён в keyframes (UA ставит group через transform). */
function effectsCss(
  name: string,
  artifact: SurfaceExecutionArtifact,
  placement: string,
): string {
  const w0 = artifact.fromWidth;
  const w1 = artifact.toWidth;
  const dur = `${artifact.durationMs}ms`;
  const s0 = w0 / w1;
  const s1 = w1 / w0;
  return (
    `@keyframes ${name}-g { from { transform: ${placement} scaleX(${s0}); } to { transform: ${placement} scaleX(1); } }\n`
    + `@keyframes ${name}-os { from { transform: scaleX(1); } to { transform: scaleX(${s0}); } }\n`
    + `@keyframes ${name}-oo { from { opacity: 1; } to { opacity: 0; } }\n`
    + `@keyframes ${name}-ns { from { transform: scaleX(${s1}); } to { transform: scaleX(1); } }\n`
    + `@keyframes ${name}-no { from { opacity: 0; } to { opacity: 1; } }\n`
    + `::view-transition-group(${name}) { transform-origin: left top; animation: ${name}-g ${dur} ${artifact.easing} both; }\n`
    + `::view-transition-image-pair(${name}) { overflow: hidden; }\n`
    + `::view-transition-old(${name}) { transform-origin: left top; animation: ${name}-os ${dur} ${artifact.reciprocalEasing} both, ${name}-oo ${dur} ${artifact.blendEasing} both; }\n`
    + `::view-transition-new(${name}) { transform-origin: left top; animation: ${name}-ns ${dur} ${artifact.reciprocalEasing} both, ${name}-no ${dur} ${artifact.blendEasing} both; }`
  );
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
  let cssInjected = false;
  let vt: SurfaceViewTransitionLike | undefined;

  const committed = deferred();
  const ready = deferred();
  const finished = deferred();
  let observer: ReturnType<typeof createSurfaceObserver> | undefined;
  let inputCleanup: (() => void) | undefined;
  const generation = seams.generation;
  const vtName = generation?.viewTransitionName ?? 'lm-surface';
  // Superseded читается после каждого await: getter мутируется coordinator'ом
  // асинхронно, поэтому проверка — вызов, а не закэшированное значение.
  const isSuperseded = (): boolean => generation !== undefined && generation.superseded;

  const finalize = (terminal: SurfaceState): void => {
    if (state === 'released' || state === 'canceled' || state === 'failed') return;
    state = terminal;
    observer?.stop();
    inputCleanup?.();
    inputCleanup = undefined;
    // Terminal cleanup: временный stylesheet снимается ровно один раз
    // (спека «VIEW TRANSITION HOST»); skipTransition немедленно раскрывает
    // committed DOM, снимая snapshot-плоскости (cancel/supersede/finish).
    // Host-facing шаги изолированы: оторванный style element (re-render
    // фреймворка) не должен срывать generation release и резолвы обещаний.
    if (cssInjected) {
      cssInjected = false;
      try { seams.host?.removeCss?.(); } catch { /* host уже отсоединён */ }
    }
    if (vt !== undefined) {
      try { vt.skipTransition?.(); } catch { /* transition уже завершён */ }
      vt = undefined;
    }
    // Имя снимается только если цель всё ещё носит НАШЕ имя: при supersede
    // на той же цели новая generation уже назначила собственное имя.
    if (target.style.getPropertyValue('view-transition-name') === generation?.viewTransitionName) {
      try { target.style.removeProperty?.('view-transition-name'); } catch { /* цель уничтожена */ }
    }
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

  // Единственный commit конечного layout (либо FutureLayoutTransaction).
  // Canceled-гард: cancel ДО исполнения update callback не коммитит DOM.
  const applyCommit = (): void | Promise<void> => {
    if (canceled) return;
    const result = options.commit !== undefined
      ? options.commit()
      : target.style.setProperty('width', `${toWidth}px`);
    // Публикация состояния — только после фактического применения commit.
    generation?.commit();
    return result;
  };

  // Commit уходит в microtask: старый визуальный state захвачен до него, а
  // барьер продолжается ДО резолва committed, чтобы наблюдатель committed
  // видел уже начавшийся capture-new/running, а не застрявший committing.
  void Promise.resolve().then(() => {
    if (canceled) return;
    state = 'committing';
    // UA-анимации псевдодерева отключаются ДО startViewTransition: браузер
    // не успевает запустить собственный transition поверх Lab Motion.
    if (generation !== undefined && seams.host?.injectCss !== undefined) {
      seams.host.injectCss(generation.generatedCss);
      cssInjected = true;
    }
    // VT capability — эксперимент: синхронный throw host не оставляет
    // partial owner; commit применяется напрямую (final DOM определён),
    // snapshot-плоскостей нет → транзакция продолжается как snap.
    const host = seams.host;
    if (host?.startViewTransition !== undefined) {
      try {
        const started = host.startViewTransition(applyCommit);
        vt = started !== null && typeof started === 'object'
          ? started as SurfaceViewTransitionLike
          : undefined;
      } catch {
        vt = undefined;
      }
      // Skip (cancel/supersede) может случиться до прикрепления terminal-
      // цепи: ранний catch гасит unhandled rejection, не влияя на цепи ниже.
      if (vt !== undefined && thenable(vt.finished)) {
        (vt.finished as Promise<void>).catch(() => {});
      }
    }
    // Без VT update callback исполняется здесь же (вне barrier ничего не
    // удерживает старый кадр — commit обязателен на всех путях).
    if (vt === undefined) applyCommit();

    // VT ready резолвится после update callback + snapshot capture: это
    // честный барьер «commit применён, псевдодерево готово».
    const readyGate: Promise<void> = vt !== undefined && thenable(vt.ready)
      ? vt.ready
      : Promise.resolve();
    return readyGate.then(() => {
      if (isSuperseded()) return finalize('released');
      return barrier();
    }).then(() => {
      if (canceled) return;
      if (isSuperseded()) return finalize('released');
      // Scroll correction выполняется внутри commit barrier.
      if (scroll0 !== undefined && seams.scrollTo !== undefined) {
        seams.scrollTo(scroll0);
      }
      // verify target still valid + capture new
      state = 'capturing-new';
      captureWidth();

      if (options.reducedMotion === true) {
        // Reduced character switch: мгновенное раскрытие committed DOM.
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

      // Сопряжённая геометрия существует только в pseudo-tree VT: без VT
      // snapshot-плоскостей нет — честный snap вместо имитации.
      if (vt === undefined || seams.readPseudoModel === undefined) return snap();

      // Сертификация pseudo-модели (host-fit база B = committed ширина):
      // недоказанная модель → fail-closed snap.
      const model = seams.readPseudoModel(vtName);
      if (
        model === undefined
        || !Number.isFinite(model.groupWidth)
        || Math.abs(model.groupWidth - toWidth) > MODEL_CERT_TOLERANCE_PX
      ) {
        return snap();
      }

      tier = 'future-layout-native';
      // Generated CSS (5 effects) инжектится после сертификации модели:
      // CSS-анимации псевдодерева продлевают transition до своего финала.
      seams.host?.injectCss?.(effectsCss(
        vtName,
        artifact,
        model.placement,
      ));

      // Stale ready не запускает effects: supersede между инжектом и стартом
      // гасит визуальное представление этой транзакции.
      if (isSuperseded()) return finalize('released');

      // Supersede останавливает active representation: снимаются effects и
      // observer, committed DOM раскрывается skipTransition.
      generation?.onSupersede(() => finalize('released'));

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

      // Terminal authority: transition завершается, когда все CSS-анимации
      // псевдодерева закончились (vt.finished). Без observer rAF в active
      // phase нет вовсе; reject (skip) поглощается — finalize идемпотентен.
      const terminal = vt?.finished;
      if (thenable(terminal)) {
        terminal.then(
          () => finalize('released'),
          () => finalize('released'),
        );
      } else {
        // Fallback для host без finished-контракта: duration-граница.
        const guard = setTimeout(() => finalize('released'), artifact.durationMs + 250);
        // Unref-совместимость не требуется: guard живёт не дольше run.
        void guard;
      }
    });
  }).catch(() => {
    // Host-сбой (update callback бросил, barrier упал): commit может быть не
    // применён — применяем его напрямую, чтобы final DOM был определён, и
    // терминализируем как failed без partial owner.
    try {
      if (target.style.getPropertyValue('width') !== `${toWidth}px` && !canceled) {
        if (options.commit === undefined) target.style.setProperty('width', `${toWidth}px`);
      }
    } catch { /* цель уничтожена: final DOM недоопределим, фиксируем failed */ }
    finalize('failed');
  });

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
