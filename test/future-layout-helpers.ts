/**
 * test/future-layout-helpers.ts — общие фикстуры RED-тестов Future Layout.
 *
 * НЕ тест-файл (не собирается vitest'ом как сьют): локальные копии типов
 * публичной поверхности + pick-хелперы (RED-канон test/animate-facade-
 * helpers.ts:9-31), duck-мир bounded virtualized viewport c журналом
 * операций: записи стиля, замеры, effects, layout-recalc.
 */

import { makeClock, type StepClock } from './projection-helpers.js';

export { makeClock, type StepClock };

// ─── Типы публичной поверхности (локальная копия для RED-фазы) ────────────────

export type FutureLayoutStateLike =
  | 'capturing-old'
  | 'committing'
  | 'capturing-new'
  | 'running'
  | 'released'
  | 'canceled'
  | 'failed';

export type FutureLayoutTierLike =
  | 'future-layout-native'
  | 'future-layout-snap'
  | 'future-layout-projection';

export interface FutureLayoutControlsLike {
  readonly committed: Promise<void>;
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
  cancel(): void;
  readonly state: FutureLayoutStateLike;
  readonly tier: FutureLayoutTierLike;
}

export interface SurfaceFrameViewLike {
  readonly time: number;
  readonly progress: number;
  readonly width: number;
  readonly velocity: number;
  readonly delta: number;
}

export type OnFrameLike = (frame: SurfaceFrameViewLike) => void;

/** Домен: сертифицированный SurfaceExecutionArtifact (serialized P + Q + A). */
export interface SurfaceArtifactLike {
  readonly easing: string;
  readonly reciprocalEasing: string;
  readonly blendEasing: string;
  readonly durationMs: number;
  readonly minWidth: number;
}

export interface SurfacePlanLike {
  readonly artifact: SurfaceArtifactLike;
  readonly effectCount: number;
}

// ─── pick-хелперы (namespace-import → undefined на RED-заглушке) ─────────────

export function pickCompileSurfaceArtifact(
  mod: Record<string, unknown>,
): (
  spring: unknown,
  fromWidth: number,
  toWidth: number,
  tolerance?: number,
  couplingBudgetPx?: number,
  initialVelocity?: number,
) => SurfaceArtifactLike {
  return mod['compileSurfaceArtifact'] as never;
}

export function pickCertifyPositivity(
  mod: Record<string, unknown>,
): (artifact: SurfaceArtifactLike, wMin: number) => boolean {
  return mod['certifyPositivity'] as never;
}

export function pickSurfacePlan(
  mod: Record<string, unknown>,
): (spring: unknown, fromWidth: number, toWidth: number) => SurfacePlanLike {
  return mod['planSurface'] as never;
}

export function pickCreateSurfaceCoordinator(mod: Record<string, unknown>): () => SurfaceCoordinatorLike {
  return mod['createSurfaceCoordinator'] as never;
}

export interface SurfaceCoordinatorLike {
  begin(input: { target: unknown; fromWidth: number; toWidth: number }): SurfaceGenerationLike;
  readonly activeGeneration: number;
}

export interface SurfaceGenerationLike {
  readonly generation: number;
  commit(): void;
  finish(): void;
  readonly published: boolean;
}

export function pickCreateSurfaceObserver(
  mod: Record<string, unknown>,
): (artifact: SurfaceArtifactLike, onFrame: OnFrameLike) => SurfaceObserverLike {
  return mod['createSurfaceObserver'] as never;
}

export interface SurfaceObserverLike {
  start(clock: StepClock): void;
  stop(): void;
}

// ─── Fake VT host: CSS pseudo-tree representation (детерминированный) ───────

/** View Transition объект fake: ready немедленный, finished управляется
 * тестом (в реальном движке — завершение всех CSS-анимаций псевдодерева). */
export interface FakeViewTransition {
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
  skipTransition(): void;
}

export interface FakeSurfaceHost {
  injectCss(css: string): void;
  removeCss(): void;
  startViewTransition(update: () => void | Promise<void>): FakeViewTransition;
  readonly injects: string[];
  readonly removals: number;
  readonly vtCalls: number;
  readonly skips: number;
  /** Число @keyframes в инжектённом CSS = число native effects. */
  readonly effectCount: number;
  /** Естественное завершение активного VT (резолвит finished). */
  complete(): void;
}

export function makeSurfaceHost(): FakeSurfaceHost {
  let finishedResolve: (() => void) | undefined;
  let finishedReject: ((reason?: unknown) => void) | undefined;
  const host: FakeSurfaceHost = {
    injects: [],
    removals: 0,
    vtCalls: 0,
    skips: 0,
    injectCss(css: string): void {
      host.injects.push(css);
    },
    removeCss(): void {
      host.removals++;
    },
    startViewTransition(update: () => void | Promise<void>): FakeViewTransition {
      host.vtCalls++;
      // Update callback исполняется «браузером» до ready.
      void update();
      const finished = new Promise<void>((resolve, reject) => {
        finishedResolve = resolve;
        finishedReject = reject;
      });
      return {
        ready: Promise.resolve(),
        finished,
        skipTransition(): void {
          host.skips++;
          finishedReject?.(new Error('skipped'));
        },
      };
    },
    get effectCount(): number {
      return host.injects.join('\n').split('@keyframes').length - 1;
    },
    complete(): void {
      finishedResolve?.();
    },
  };
  return host;
}

/** Сертификация pseudo-модели: host-fit база B = committed ширина (360). */
export function makePseudoModelReader(groupWidth = 360): (name: string) => { groupWidth: number; placement: string } {
  return () => ({ groupWidth, placement: 'matrix(1, 0, 0, 1, 60, 40)' });
}

/** Полный native-комплект швов: host с VT + сертифицированная модель. */
export function makeSurfaceEnv(groupWidth = 360): {
  host: FakeSurfaceHost;
  readPseudoModel: (name: string) => { groupWidth: number; placement: string };
} {
  return { host: makeSurfaceHost(), readPseudoModel: makePseudoModelReader(groupWidth) };
}

// ─── Duck-мир bounded virtualized viewport ────────────────────────────────────

/** Одна операция мира: запись стиля, замер, effect или layout-recalc. */
export interface LayoutOp {
  readonly seq: number;
  readonly kind: 'set' | 'measure' | 'effect' | 'recalc' | 'materialize';
  readonly target?: string;
  readonly prop?: string;
  readonly value?: string;
}

export interface SurfaceFakeElement {
  readonly name: string;
  width: number;
  readonly inline: Map<string, string>;
  readonly style: {
    setProperty(n: string, v: string): void;
    getPropertyValue(n: string): string;
  };
  animate(keyframes: unknown, timing: unknown): { cancel(): void };
  getBoundingClientRect(): { width: number };
}

export interface SurfaceWorld {
  readonly ops: LayoutOp[];
  /** Логические строки списка (100 / 10 000 / 1 000 000). */
  readonly logicalRows: number;
  /** Материализованные строки: viewportCapacity + boundedOverscan. */
  readonly materializedRows: number;
  readonly viewport: SurfaceFakeElement;
  readonly rows: readonly SurfaceFakeElement[];
  /** VT host duck-мира: инжект CSS pseudo-tree, journal effects. */
  readonly host: FakeSurfaceHost;
  /** Сертификация pseudo-модели: host-fit база B = committed ширина. */
  readonly readPseudoModel: (name: string) => { groupWidth: number; placement: string };
  writes(target: string, prop?: string): LayoutOp[];
  effects(): LayoutOp[];
  recalcs(): LayoutOp[];
}

/**
 * Bounded viewport: материализовано min(logicalRows, capacity+overscan) строк;
 * журнал фиксирует записи стиля, замеры, effect-запуски и layout-recalc.
 */
export function makeSurfaceWorld(
  logicalRows: number,
  init: { viewportWidth?: number; capacity?: number; overscan?: number } = {},
): SurfaceWorld {
  const ops: LayoutOp[] = [];
  let seq = 0;
  const viewportWidth = init.viewportWidth ?? 240;
  const capacity = init.capacity ?? 20;
  const overscan = init.overscan ?? 5;
  const rowHeight = 24;

  const makeEl = (name: string, width: number): SurfaceFakeElement => {
    const inline = new Map<string, string>();
    const el: SurfaceFakeElement = {
      name,
      width,
      inline,
      style: {
        setProperty(n: string, v: string): void {
          ops.push({ seq: seq++, kind: 'set', target: name, prop: n, value: v });
          inline.set(n, v);
          if (n === 'width') el.width = Number.parseFloat(v);
          ops.push({ seq: seq++, kind: 'recalc', target: name });
        },
        getPropertyValue(n: string): string {
          return inline.get(n) ?? '';
        },
      },
      animate(keyframes: unknown, timing: unknown): { cancel(): void } {
        void timing;
        ops.push({ seq: seq++, kind: 'effect', target: name, value: JSON.stringify(keyframes) });
        return { cancel(): void { /* noop */ } };
      },
      getBoundingClientRect(): { width: number } {
        ops.push({ seq: seq++, kind: 'measure', target: name });
        return { width: el.width };
      },
    };
    return el;
  };

  const materialized = Math.min(logicalRows, capacity + overscan);
  const viewport = makeEl('viewport', viewportWidth);
  const rows = Array.from({ length: materialized }, (_, i) => makeEl(`row-${i}`, viewportWidth));
  for (let i = 0; i < materialized; i++) ops.push({ seq: seq++, kind: 'materialize', target: `row-${i}` });
  void rowHeight;

  // VT host duck-мира: инжект CSS pseudo-tree журналами в общий ops-поток —
  // каждый @keyframes есть один native effect (постоянное число = 5).
  const host = makeSurfaceHost();
  const baseInject = host.injectCss.bind(host);
  host.injectCss = (css: string): void => {
    baseInject(css);
    const keyframes = css.split('@keyframes').length - 1;
    for (let i = 0; i < keyframes; i++) {
      ops.push({ seq: seq++, kind: 'effect', target: 'pseudo-tree' });
    }
  };
  const readPseudoModel = makePseudoModelReader(360);

  return {
    ops,
    logicalRows,
    materializedRows: materialized,
    viewport,
    rows,
    host,
    readPseudoModel,
    writes(target, prop) {
      return ops.filter(
        (o) => o.kind === 'set' && o.target === target && (prop === undefined || o.prop === prop),
      );
    },
    effects() {
      return ops.filter((o) => o.kind === 'effect');
    },
    recalcs() {
      return ops.filter((o) => o.kind === 'recalc');
    },
  };
}
