import { MotionError, number } from './model.js';
import { Run, type ControlOperation } from './runtime.js';
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
        const group = track._group, native = group._native;
        const local = native?.currentTime;
        const delta = group._busy || track._paused ? 0 : native
          ? typeof local === 'number' && Number.isFinite(local) ? local - group._nativeTime : 0
          : Math.max(0, now - group._stamp) * track._rate;
        const current = Math.min(track._program.duration, Math.max(0, track._elapsed + delta));
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
      if (run._tracks.size) run._apply(rateCommand(number(value, 'timeScale')));
    },
    reverse(): void { run._apply(reverseRate); },
    pause(): void { run.pause(); }, play(): void { run.play(); },
    seek(time): void { run.seek(time); }, stop(): void { run.stop(); }, finish(): void { run.finish(); },
  };
}

/** Подключается только представлением playhead, не является отдельным исполнителем. */
function configureNative(effect: Animation, rate: number): boolean {
  if (typeof effect.updatePlaybackRate !== 'function') return false;
  effect.updatePlaybackRate(rate);
  return true;
}
const reverseRate: ControlOperation = (group, tracks) => applyRate(group, tracks);
function rateCommand(rate: number): ControlOperation {
  return (group, tracks) => applyRate(group, tracks, rate);
}
function applyRate(group: Parameters<ControlOperation>[0], tracks: Parameters<ControlOperation>[1], rate?: number): void {
  let native = false;
  if (group._native && tracks.length === group._tracks.size) {
    group._lock(true);
    try {
      native = configureNative(group._native, rate ?? -tracks[0]!._rate);
      if (native) {
        for (const track of tracks) {
          track._rate = rate ?? -track._rate; track._configureNative = configureNative;
          group._sample(track);
        }
      }
    } finally { group._lock(false); }
  }
  if (native) return;
  group._detach();
  for (const track of tracks) {
    track._rate = rate ?? -track._rate; track._configureNative = configureNative;
    group._sample(track);
  }
  group._render();
  for (const track of tracks) if (!track._paused && group._ended(track)) group._end(track, true);
}
