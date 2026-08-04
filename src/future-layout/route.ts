/**
 * src/future-layout/route.ts — консервативный маршрутизатор
 * animate(..., { layout: 'project' }) в surface-транзакцию.
 *
 * Режим всегда явный: без layout:'project' прямой width-tween остаётся
 * прежним (спека «FALLBACK-МАТРИЦА»). Любое сомнение (не width-пара,
 * неединственный канал, селектор/список, нечисловые концы) оставляет
 * обычный runtime path — никаких скрытых подмен семантики.
 */

import { prefersReduced } from '../compositor/detect.js';
import { DEFAULT_SPRING } from '../internal/motion-defaults.js';
import type { SpringParams } from '../spring.js';
import { createSurfaceCoordinator } from './coordinator.js';
import {
  startSurfaceTransition,
  type SurfaceControls,
  type SurfaceHostLike,
  type SurfaceInputPolicy,
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
  startViewTransition?(update: () => void | Promise<void>): unknown;
}

// DOM-реализация VT host: style element живёт ровно между inject и terminal
// cleanup; CSS записывается через textContent (CSP без eval/Function).
// startViewTransition прокидывается только при реальной capability.
function documentSurfaceHost(doc: DocumentLike): SurfaceHostLike {
  let style: { textContent: string } | undefined;
  const host: SurfaceHostLike = {
    injectCss(css: string): void {
      if (style !== undefined) return;
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
  const fromWidth = value[0];
  const toWidth = value[1];
  if (typeof fromWidth !== 'number' || typeof toWidth !== 'number') return undefined;

  // V1 slice: одна bounded-цель; селектор/список — обычный runtime path.
  if (typeof target === 'string') return undefined;
  const el = target as SurfaceTargetLike & { length?: unknown };
  if (el.length !== undefined && typeof el.style !== 'object') return undefined;
  if (el.style === undefined || typeof el.style.setProperty !== 'function') return undefined;

  const spring = (options.spring ?? DEFAULT_SPRING) as SpringParams;
  const reduced = prefersReduced(options.matchMedia as never);
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

  // Один document — одна active generation; уникальное bounded имя из
  // монотонной последовательности назначается цели inline (снимается в
  // terminal cleanup транзакции), host — DOM-backed capability experiment.
  const generation = DOCUMENT_SURFACE_COORDINATOR.begin({ target: el, fromWidth, toWidth });
  el.style.setProperty('view-transition-name', generation.viewTransitionName);
  const doc = (globalThis as { document?: DocumentLike }).document;
  const host = doc !== undefined ? documentSurfaceHost(doc) : undefined;

  const controls = startSurfaceTransition(
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
    },
  );
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
