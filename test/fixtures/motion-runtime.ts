import { Runtime, type RuntimeHost } from '../../src/motion/runtime.js';
import { runSequence } from '../../src/motion/sequence.js';
import type { Playback, SequenceOptions, SequenceStep } from '../../src/motion/types.js';
import type { FrameLoop } from '../../src/frame/index.js';

export function harness(native = false) {
  let time = 0;
  const updates = new Set<() => void>(), renders = new Set<() => void>();
  const loop: FrameLoop = {
    read: () => () => {},
    update: cb => { updates.add(cb); return () => { updates.delete(cb); }; },
    render: cb => { renders.add(cb); return () => { renders.delete(cb); }; },
    cancelAll() { updates.clear(); renders.clear(); },
  };
  const effects: Array<{ currentTime: number | null; readonly playState: AnimationPlayState; playbackRate: number; updatePlaybackRate(rate: number): void; pause(): void; play(): void; cancelled: boolean; keys: Keyframe[]; timing: KeyframeAnimationOptions; finished: Promise<unknown>; complete(): void; cancel(): void }> = [];
  const host: RuntimeHost = { frame: loop, now: () => time, reduced: () => false,
    styles: element => (element as HTMLElement).style, supports: () => native };
  const engine = new Runtime(host);
  const runtime = Object.assign(engine, {
    sequence(steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
      return runSequence(engine, steps, options);
    },
  });
  const writes: Array<[string, string]> = [];
  const values = new Map<string, string>();
  const element = { style: {
    setProperty(key: string, value: string) { values.set(key, value); writes.push([key, value]); },
    getPropertyValue(key: string) { return values.get(key) ?? ''; },
  }, ...(native ? { animate(keys: Keyframe[], timing: KeyframeAnimationOptions) {
    let finish!: () => void; let completed = false, paused = false;
    let time: number | null = 0;
    const completion = () => new Promise<void>(resolve => { finish = resolve; });
    let finished = completion();
    const effect = { keys, timing, get currentTime() { return time; },
      set currentTime(value: number | null) {
        time = value;
        if (completed && value !== null && value < Number(timing.duration) + (timing.delay ?? 0)) { completed = false; finished = completion(); }
      },
      playbackRate: 1, cancelled: false,
      updatePlaybackRate(rate: number) { effect.playbackRate = rate; },
      pause() { paused = true; }, play() { paused = false; },
      get playState(): AnimationPlayState { return effect.cancelled ? "idle" : paused ? "paused" : completed ? "finished" : "running"; },
      get finished() { return finished; },
      complete() { completed = true; finish(); }, cancel() { effect.cancelled = true; } };
    effects.push(effect); return effect;
  } } : {}) } as unknown as HTMLElement;
  return { host, runtime, element, effects, writes, values, updates, renders,
    step(at: number) { time = at; for (const cb of [...updates]) cb(); for (const cb of [...renders]) cb(); },
    x() { return Number(/translate\(([^p]+)px/.exec(values.get('transform') ?? '')?.[1] ?? 0); },
    y() { return Number(/translate\([^,]+,([^p]+)px/.exec(values.get('transform') ?? '')?.[1] ?? 0); },
  };
}
