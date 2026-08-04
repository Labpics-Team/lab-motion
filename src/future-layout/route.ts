/**
 * src/future-layout/route.ts — консервативный маршрутизатор
 * animate(..., { layout: 'project' }) в surface-транзакцию.
 *
 * Режим всегда явный: без layout:'project' прямой width-tween остаётся
 * прежним (спека «FALLBACK-МАТРИЦА»). Любое сомнение (не width-пара,
 * неединственный канал, селектор/список, нечисловые концы) оставляет
 * обычный runtime path — никаких скрытых подмен семантики. Невалидные
 * концы/пружина бросают ошибки фасада ДО каких-либо побочных эффектов
 * (имя не назначается, generation не создаётся).
 */

import { prefersReduced } from '../compositor/detect.js';
import { validateSpringParams } from '../spring.js';
import { MotionParamError } from '../errors.js';
import { DEFAULT_SPRING } from '../internal/motion-defaults.js';
import type { SpringParams } from '../spring.js';
import { createSurfaceCoordinator } from './coordinator.js';
import {
  startSurfaceTransition,
  type SurfaceControls,
  type SurfaceHostLike,
  type SurfaceInputPolicy,
  type SurfacePseudoModel,
  type SurfaceScrollAnchor,
  type SurfaceTargetLike,
} from './transaction.js';

export interface SurfaceRouteControls extends SurfaceControls {
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  stop(): void;
}

interface LooseOptions {
  readonly layout?: unknown;
  readonly spring?: unknown;
  readonly onFrame?: unknown;
  readonly matchMedia?: unknown;
  readonly requestFrame?: unknown;
  readonly inputPolicy?: unknown;
  readonly scrollAnchor?: unknown;
  readonly commit?: unknown;
  readonly getScroll?: unknown;
  readonly scrollTo?: unknown;
  readonly onInputIntent?: unknown;
  /** Test/host seam: переопределение VT host. */
  readonly host?: unknown;
  /** Test seam: чтение сертифицированной pseudo-модели. */
  readonly readPseudoModel?: unknown;
  /** Test seam: барьер commit. */
  readonly commitBarrier?: unknown;
}

// Один document — одна active generation: module-scoped координатор является
// единственным владельцем supersede/terminal authority (спека «DOCUMENT-SCOPED
// COORDINATOR»). Не второй registry: begin() сам вытесняет старую generation.
const DOCUMENT_SURFACE_COORDINATOR = createSurfaceCoordinator();

function defaultRequestFrame(cb: (ts?: number) => void): number {
  const g = globalThis as { requestAnimationFrame?: (cb: (ts: number) => void) => number };
  // Timestamp обязан пробрасываться: clock транзакции/observer'а сравнивает
  // доставленные ts с t0 — без него finished не резолвится в реальном браузере.
  // Вызов МЕТОДОМ на globalThis: оторванная ссылка бросает Illegal invocation.
  return typeof g.requestAnimationFrame === 'function'
    ? g.requestAnimationFrame((ts) => cb(ts))
    : (setTimeout(() => cb(performanceNow()), 16) as unknown as number);
}

function performanceNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf !== undefined ? perf.now() : 0;
}

const NOOP = (): void => {};

interface DocumentLike {
  createElement(tag: 'style'): { textContent: string };
  head: { appendChild(node: unknown): void; removeChild(node: unknown): void };
  documentElement: unknown;
  startViewTransition?(update: () => void | Promise<void>): unknown;
}

interface GlobalWithComputed {
  getComputedStyle?(el: unknown, pseudo?: string): {
    width: string;
    transform: string;
  };
}

// DOM-реализация VT host: style element живёт ровно между inject и terminal
// cleanup; CSS записывается через textContent (CSP без eval/Function).
// injectCss аддитивен: UA-отключение инжектится до startViewTransition,
// effects CSS — после сертификации pseudo-модели (один stylesheet).
// startViewTransition прокидывается только при реальной capability.
function documentSurfaceHost(doc: DocumentLike): SurfaceHostLike {
  let style: { textContent: string } | undefined;
  const host: SurfaceHostLike = {
    injectCss(css: string): void {
      if (style !== undefined) {
        style.textContent += `\n${css}`;
        return;
      }
      style = doc.createElement('style');
      style.textContent = css;
      doc.head.appendChild(style);
    },
    removeCss(): void {
      if (style === undefined) return;
      doc.head.removeChild(style);
      style = undefined;
    },
  };
  if (typeof doc.startViewTransition === 'function') {
    // Bind обязателен: оторванный метод document бросает Illegal invocation.
    host.startViewTransition = (update) => doc.startViewTransition!.call(doc, update);
  }
  return host;
}

// Capability/model эксперимент (после VT ready): group-бокс псевдодерева и
// placement-transform. Ширина парсится из computed style; отсутствие
// псевдоэлемента/функции — недоказанная модель (undefined → snap).
function documentPseudoModelReader(doc: DocumentLike): (name: string) => SurfacePseudoModel | undefined {
  return (name: string): SurfacePseudoModel | undefined => {
    const gcs = (globalThis as GlobalWithComputed).getComputedStyle;
    if (typeof gcs !== 'function') return undefined;
    try {
      const cs = gcs(doc.documentElement, `::view-transition-group(${name})`);
      const groupWidth = Number.parseFloat(cs.width);
      if (!Number.isFinite(groupWidth) || groupWidth <= 0) return undefined;
      const t = cs.transform;
      return { groupWidth, placement: t === 'none' || t === '' ? 'translate(0px, 0px)' : t };
    } catch {
      return undefined;
    }
  };
}

function requireSurfaceWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MotionParamError('LM167');
  }
  return value;
}

export function tryRouteSurfaceTransition(
  target: unknown,
  props: Record<string, unknown>,
  options: LooseOptions,
): SurfaceRouteControls | undefined {
  // Не-объект options отвергает фасад (LM156) — маршрутизатор не читает их.
  if (options === null || typeof options !== 'object' || options.layout !== 'project') {
    return undefined;
  }

  if (props === null || typeof props !== 'object') return undefined;
  const keys = Object.keys(props);
  if (keys.length !== 1 || keys[0] !== 'width') return undefined;
  const value = props['width'];
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const rawFrom = value[0];
  const rawTo = value[1];
  if (typeof rawFrom !== 'number' || typeof rawTo !== 'number') return undefined;

  // V1 slice: одна bounded-цель; селектор/список — обычный runtime path.
  if (typeof target === 'string') return undefined;
  if (target === null || target === undefined) return undefined;
  const el = target as SurfaceTargetLike & { length?: unknown };
  if (el.length !== undefined && typeof el.style !== 'object') return undefined;
  if (el.style === undefined || typeof el.style.setProperty !== 'function') return undefined;

  // Валидация ДО побочных эффектов: невалидные концы/пружина бросают ошибки
  // фасада, не назначая view-transition-name и не создавая generation.
  const fromWidth = requireSurfaceWidth(rawFrom);
  const toWidth = requireSurfaceWidth(rawTo);
  const springInput = options.spring;
  const spring = (springInput === undefined ? DEFAULT_SPRING : springInput) as SpringParams;
  if (springInput !== undefined) validateSpringParams(spring);

  // Фолбэк среды как в обычном runtime path: без него reduced-motion
  // пользователь без явного шва получал бы движение вместо snap.
  const reduced = prefersReduced((options.matchMedia ??
    (globalThis as { matchMedia?: unknown }).matchMedia) as never);
  const requestFrame = typeof options.requestFrame === 'function'
    ? options.requestFrame as (cb: (ts?: number) => void) => number
    : defaultRequestFrame;
  const onFrame = typeof options.onFrame === 'function'
    ? options.onFrame as SurfaceRouteOnFrame
    : undefined;
  const inputPolicy = options.inputPolicy === 'cancel' || options.inputPolicy === 'block'
    ? options.inputPolicy as SurfaceInputPolicy
    : 'finish';
  const scrollAnchor: SurfaceScrollAnchor = options.scrollAnchor === 'none' ? 'none' : 'preserve-start';
  const commit = typeof options.commit === 'function'
    ? options.commit as () => void | Promise<void>
    : undefined;
  const getScroll = typeof options.getScroll === 'function'
    ? options.getScroll as () => number
    : undefined;
  const scrollTo = typeof options.scrollTo === 'function'
    ? options.scrollTo as (position: number) => void
    : undefined;
  const onInputIntent = typeof options.onInputIntent === 'function'
    ? options.onInputIntent as (handler: () => void) => () => void
    : undefined;

  // Host и pseudo-модель резолвятся из документа ЦЕЛИ (iframe/вторичный
  // document): global document — только fallback, иначе generated CSS попал
  // бы не в тот head, а startViewTransition шёл на чужом документе.
  const ownerDoc = (el as { ownerDocument?: DocumentLike | null }).ownerDocument;
  const doc = ownerDoc ?? (globalThis as { document?: DocumentLike }).document;
  const host = options.host !== undefined
    ? options.host as SurfaceHostLike
    : doc !== undefined ? documentSurfaceHost(doc) : undefined;
  const readPseudoModel = typeof options.readPseudoModel === 'function'
    ? options.readPseudoModel as (name: string) => SurfacePseudoModel | undefined
    : doc !== undefined ? documentPseudoModelReader(doc) : undefined;
  const commitBarrier = typeof options.commitBarrier === 'function'
    ? options.commitBarrier as () => Promise<void>
    : undefined;

  // Один document — одна active generation; уникальное bounded имя из
  // монотонной последовательности назначается цели inline (снимается в
  // terminal cleanup транзакции), host — DOM-backed capability experiment.
  const generation = DOCUMENT_SURFACE_COORDINATOR.begin({ target: el, fromWidth, toWidth });
  el.style.setProperty('view-transition-name', generation.viewTransitionName);

  // Синхронный бросок setup (hostile getScroll/capture) не оставляет
  // активного generation и чужого inline-имени: cleanup ДО rethrow.
  let controls: SurfaceControls;
  try {
    controls = startSurfaceTransition(
      el,
      fromWidth,
      toWidth,
      { spring, onFrame, reducedMotion: reduced, inputPolicy, scrollAnchor, commit },
      {
        requestFrame,
        now: performanceNow(),
        getScroll,
        scrollTo,
        onInputIntent,
        generation,
        host,
        readPseudoModel,
        commitBarrier,
      },
    );
  } catch (error) {
    try { el.style.removeProperty?.('view-transition-name'); } catch { /* цель уничтожена */ }
    generation.skip();
    throw error;
  }
  return {
    committed: controls.committed,
    ready: controls.ready,
    finished: controls.finished,
    cancel: controls.cancel,
    get state() {
      return controls.state;
    },
    get tier() {
      return controls.tier;
    },
    // one-shot проекция: play/pause/seek вне контракта, stop = cancel.
    play: NOOP,
    pause: NOOP,
    seek: NOOP,
    stop(): void {
      controls.cancel();
    },
  };
}

type SurfaceRouteOnFrame = (frame: {
  readonly time: number;
  readonly progress: number;
  readonly width: number;
  readonly velocity: number;
  readonly delta: number;
}) => void;
