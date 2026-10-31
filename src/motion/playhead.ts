import { stoppedMotion } from './stopped.js';
import { failMotion, number } from './model.js';
import { Run, type ControlOperation } from './runtime.js';
import type { MotionPlayback, Playback } from './types.js';

let stoppedView: MotionPlayback | undefined;

/** Дополняет тот же Playback; новые часы, wrapper и registry не создаются. */
export function playhead(playback: Playback): MotionPlayback {
  if (playback === stoppedMotion) return stoppedView ??= {
    ...stoppedMotion, time: 0,
    get timeScale(): number | undefined { return undefined; }, set timeScale(_value: number) {},
    reverse() {},
  };
  if (stoppedView && playback === stoppedView) return stoppedView;
  if (!(playback instanceof Run)) failMotion('playhead: неподдерживаемый Playback');
  const run = playback;
  if (run._capture) return run as Run & MotionPlayback;
  if (!Object.isExtensible(run) || ['time', 'timeScale', 'reverse'].some(key => key in run))
    failMotion('playhead: свойства контролов недоступны');
  let lastTime: number | undefined = run.duration === 0 ? 0 : undefined;
  let lastRate: number | undefined = run._tracks.size ? 1 : undefined;
  Object.defineProperties(run, {
    time: { get(): number | undefined {
      let now: number | undefined, position: number | undefined;
      for (const track of run._tracks) {
        now ??= number(track._group._engine._host.now(), 'clock');
        const group = track._group, native = group._native, local = native?.currentTime;
        const delta = group._busy || track._paused ? 0 : native
          ? typeof local === 'number' && Number.isFinite(local) ? local - group._nativeTime : 0
          : Math.max(0, now - group._stamp) * track._rate;
        const current = Math.min(track._program._duration, Math.max(0, track._elapsed + delta));
        if (native && current === track._program._duration && current < group._nativeEnd) continue;
        if (position !== undefined && position !== current) return undefined;
        position = current;
      }
      return position ?? lastTime;
    } },
    timeScale: {
      get(): number | undefined {
        let rate: number | undefined;
        for (const track of run._tracks) {
          if (rate !== undefined && rate !== track._rate) return undefined;
          rate = track._rate;
        }
        return rate ?? lastRate;
      },
      set(value: number) { if (run._tracks.size) run._apply(rateCommand(number(value, 'timeScale'))); },
    },
    reverse: { value(): void { run._apply(reverseRate); } },
  });
  run._capture = track => { lastTime = Math.min(run.duration, track._elapsed); lastRate = track._rate; };
  return run as Run & MotionPlayback;
}

/** Подключается только представлением playhead, не является отдельным исполнителем. */
const reverseRate: ControlOperation = applyRate;
function rateCommand(rate: number): ControlOperation {
  return (group, tracks) => applyRate(group, tracks, rate);
}
function applyRate(group: Parameters<ControlOperation>[0], tracks: Parameters<ControlOperation>[1], rate?: number): void {
  const requested = rate ?? -tracks[0]!._rate, effect = group._native;
  if (requested >= 0 && effect && tracks.length === group._tracks.size &&
      typeof effect.updatePlaybackRate === 'function') {
    group._lock(true);
    try {
      effect.updatePlaybackRate(requested);
      for (const track of tracks) {
        track._rate = rate ?? -track._rate;
        group._sample(track);
      }
    } finally { group._lock(false); }
    return;
  }
  group._detach();
  for (const track of tracks) {
    track._rate = rate ?? -track._rate;
    group._sample(track);
  }
  group._render();
  for (const track of tracks) if (!track._paused && group._ended(track)) group._end(track, true);
}
