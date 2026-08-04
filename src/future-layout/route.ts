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
import {
  startSurfaceTransition,
  type SurfaceControls,
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
}

function defaultRequestFrame(cb: (ts?: number) => void): number {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  return raf !== undefined ? raf(cb) : (setTimeout(cb, 16) as unknown as number);
}

const NOOP = (): void => {};

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

  const controls = startSurfaceTransition(
    el,
    fromWidth,
    toWidth,
    { spring, onFrame, reducedMotion: reduced },
    { requestFrame },
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
