/**
 * src/future-layout/observer.ts — observer clock сопряжённой поверхности.
 *
 * Спека «OBSERVER CLOCK»: callback не управляет движением — наблюдает тот же
 * SurfaceExecutionArtifact, что управляет визуальным слоем. Законы:
 *  - максимум один callback на доставленный main-thread frame (планируется
 *    ровно один следующий кадр — нет очереди, нет backlog после freeze);
 *  - ноль frame-аллокаций: borrowed view действителен только внутри callback
 *    и переиспользуется (для хранения пользователь копирует числа);
 *  - velocity — правая производная serialized W(t) (upper-bound сегмент);
 *  - исключение callback не отменяет визуальный transition;
 *  - без observer не планируется ни одного rAF.
 */

import { sampleSerializedSpringIntoUnchecked } from '../compositor/sample.js';
import type { SurfaceExecutionArtifact } from './artifact.js';

export interface SurfaceObserverClock {
  requestFrame(cb: (ts?: number) => void): number;
  readonly now?: number;
}

export interface SurfaceFrameView {
  readonly time: number;
  readonly progress: number;
  readonly width: number;
  readonly velocity: number;
  readonly delta: number;
}

export type SurfaceOnFrame = (frame: SurfaceFrameView) => void;

export interface SurfaceObserver {
  start(clock: SurfaceObserverClock): void;
  stop(): void;
  readonly running: boolean;
}

export function createSurfaceObserver(
  artifact: SurfaceExecutionArtifact,
  onFrame: SurfaceOnFrame,
): SurfaceObserver {
  let stopped = false;
  let started = false;
  let t0 = 0;
  let prevWidth = artifact.fromWidth;
  // Единственные аллокации observer'а — scratch сэмпла и borrowed view.
  const scratch = { value: 0, velocity: 0 };
  const view: { time: number; progress: number; width: number; velocity: number; delta: number } = {
    time: 0,
    progress: 0,
    width: artifact.fromWidth,
    velocity: 0,
    delta: 0,
  };

  const deliver = (ts: number, clock: SurfaceObserverClock): void => {
    if (stopped) return;
    const time = ts - t0;
    sampleSerializedSpringIntoUnchecked(artifact.samples, artifact.durationMs, time, 0, scratch);
    const range = artifact.toWidth - artifact.fromWidth;
    const width = artifact.fromWidth + range * scratch.value;
    view.time = time;
    view.progress = scratch.value;
    view.width = width;
    view.velocity = range * scratch.velocity;
    view.delta = width - prevWidth;
    prevWidth = width;
    try {
      onFrame(view);
    } catch {
      // Исключение пользовательского callback не отменяет визуальный transition.
    }
    if (time < artifact.durationMs) {
      clock.requestFrame((next) => deliver(next ?? 0, clock));
    } else {
      stopped = true;
    }
  };

  return {
    start(clock: SurfaceObserverClock): void {
      if (started || stopped) return;
      started = true;
      t0 = clock.now ?? 0;
      clock.requestFrame((ts) => deliver(ts ?? 0, clock));
    },
    stop(): void {
      stopped = true;
    },
    get running(): boolean {
      return started && !stopped;
    },
  };
}
