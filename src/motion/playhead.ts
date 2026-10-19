import { MotionError, number } from './model.js';
import { Run } from './runtime.js';
import type { MotionPlayback, Playback } from './types.js';

/** Дополнительные контролы того же владельца, без отдельного времени или планировщика. */
export function playhead(playback: Playback): MotionPlayback {
  if (!(playback instanceof Run)) throw new MotionError('playhead ожидает animate, sequence или value.animate этого runtime');
  const run = playback;
  const history = run._history ??= { time: run.state === 'finished' ? run.duration : undefined, rate: 1 };
  return {
    duration: run.duration, finished: run.finished,
    get state() { return run.state; },
    get time(): number | undefined {
      let now: number | undefined, position: number | undefined;
      for (const track of run._tracks) {
        now ??= number(track._group._engine._host.now(), 'clock');
        const current = track._group._position(track, now);
        if (position !== undefined && position !== current) return undefined;
        position = current;
      }
      return position ?? history.time;
    },
    get timeScale(): number | undefined {
      let rate: number | undefined;
      for (const track of run._tracks) {
        if (rate !== undefined && rate !== track._rate) return undefined;
        rate = track._rate;
      }
      return rate ?? history.rate;
    },
    set timeScale(value: number) {
      if (run._tracks.size) run._apply('rate', number(value, 'timeScale'));
    },
    reverse(): void { run._apply('reverse'); },
    pause(): void { run.pause(); }, play(): void { run.play(); },
    seek(time): void { run.seek(time); }, stop(): void { run.stop(); }, finish(): void { run.finish(); },
  };
}
