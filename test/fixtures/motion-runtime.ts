import { Runtime, type RuntimeHost } from '../../src/motion/runtime.js';
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
  const effects: Array<{ currentTime: number | null; cancelled: boolean; keys: Keyframe[]; timing: KeyframeAnimationOptions; finished: Promise<unknown>; complete(): void; cancel(): void }> = [];
  const host: RuntimeHost = { frame: loop, now: () => time, reduced: () => false,
    styles: element => (element as HTMLElement).style, supports: () => native };
  const runtime = new Runtime(host);
  const writes: Array<[string, string]> = [];
  const values = new Map<string, string>();
  const element = { style: {
    setProperty(key: string, value: string) { values.set(key, value); writes.push([key, value]); },
    getPropertyValue(key: string) { return values.get(key) ?? ''; },
  }, ...(native ? { animate(keys: Keyframe[], timing: KeyframeAnimationOptions) {
    let finish!: () => void;
    const effect = { keys, timing, currentTime: 0 as number | null, cancelled: false,
      finished: new Promise<void>(resolve => { finish = resolve; }),
      complete() { finish(); }, cancel() { effect.cancelled = true; } };
    effects.push(effect); return effect;
  } } : {}) } as unknown as HTMLElement;
  return { host, runtime, element, effects, writes, values, updates, renders,
    step(at: number) { time = at; for (const cb of [...updates]) cb(); for (const cb of [...renders]) cb(); },
    x() { return Number(/translate\(([^p]+)px/.exec(values.get('transform') ?? '')?.[1] ?? 0); },
    y() { return Number(/translate\([^,]+,([^p]+)px/.exec(values.get('transform') ?? '')?.[1] ?? 0); },
  };
}

