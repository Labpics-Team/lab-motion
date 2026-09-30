import { advanceSlidingWindow } from './sliding-window.js';

/** Координаты и timestamp из входного потока, в секундах. */
export interface GesturePoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

export function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

export function finiteSub(a: number, b: number): number {
  return finite(finite(a) - finite(b));
}

/** Оценщик скорости по первой и последней точкам скользящего окна. */
export interface VelocityTracker {
  push(p: GesturePoint): void;
  velocity(): { vx: number; vy: number };
  reset(): void;
}

export const DEFAULT_VELOCITY_WINDOW_S = 0.1;

/** Coalescing применяется только к новому input-протоколу; legacy хранит прежние точки. */
export function createInputVelocityTracker(windowSec?: number, coalesce = false): VelocityTracker {
  const win = typeof windowSec === 'number' && Number.isFinite(windowSec) && windowSec > 0
    ? windowSec : DEFAULT_VELOCITY_WINDOW_S;
  const samples: GesturePoint[] = [];
  let start = 0;
  return {
    push(p): void {
      const s = { x: finite(p.x), y: finite(p.y), t: finite(p.t) };
      if (coalesce && samples.length && samples[samples.length - 1]!.t === s.t) {
        samples[samples.length - 1] = s;
      } else samples.push(s);
      start = advanceSlidingWindow(samples, start, win);
    },
    velocity() {
      if (samples.length - start < 2) return { vx: 0, vy: 0 };
      const a = samples[start]!;
      const b = samples[samples.length - 1]!;
      const dt = b.t - a.t;
      if (!(dt > 0)) return { vx: 0, vy: 0 };
      return { vx: finite(finiteSub(b.x, a.x) / dt), vy: finite(finiteSub(b.y, a.y) / dt) };
    },
    reset(): void { samples.length = start = 0; },
  };
}
