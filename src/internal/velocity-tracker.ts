import { advanceSlidingWindow } from './sliding-window.js';

/** Последнее значение каждого timestamp в scalar input-протоколе. */
export interface InputVelocityTracker {
  push(x: number, t: number): void;
  velocity(): number;
}

export const DEFAULT_VELOCITY_WINDOW_S = 0.1;

function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Follow заменяет повторный timestamp; публичный gesture tracker хранит оба. */
export function createInputVelocityTracker(): InputVelocityTracker {
  const samples: { x: number; t: number }[] = [];
  let start = 0;
  return {
    push(x, t): void {
      const sample = { x: finite(x), t: finite(t) };
      if (samples.length && samples[samples.length - 1]!.t === sample.t) {
        samples[samples.length - 1] = sample;
      } else samples.push(sample);
      start = advanceSlidingWindow(samples, start, DEFAULT_VELOCITY_WINDOW_S);
    },
    velocity(): number {
      if (samples.length - start < 2) return 0;
      const a = samples[start]!;
      const b = samples[samples.length - 1]!;
      const dt = b.t - a.t;
      return dt > 0 ? finite(finite(b.x - a.x) / dt) : 0;
    },
  };
}
