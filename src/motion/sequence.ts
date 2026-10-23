import { MAX_CHANNELS, MotionError, number, properties, snapshot, timing } from './model.js';
import { runtime, type Runtime, type Draft } from './runtime.js';
import type { MotionOptions, Playback, SequenceOptions, SequenceStep } from './types.js';

/** Планирование шкалы отделено от исполнения: одиночный animate не удерживает его код. */
export function runSequence(engine: Runtime, steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
  const list = snapshot(steps, 'sequence');
  const sequenceClock = timing(options as MotionOptions | undefined);
  const merged = new Map<Element, Map<string, Draft>>();
  let cursor = 0, previousStart = 0, end = 0, count = 0;
  for (const tuple of list) {
    const [target, props, option] = snapshot(tuple, 'sequence step', 2) as unknown as SequenceStep;
    if (tuple.length > 3) throw new MotionError('Шаг: [target, properties, options]');
    const { at, ...rest } = option ?? {};
    const offset = at === '<' ? previousStart : at === undefined || at === '>' ? cursor : number(at, 'at', 0);
    const input = properties(props), clock = timing(rest);
    const drafts = engine._draft(target, input, clock, offset + sequenceClock.delay, (element, key) => {
      const prior = merged.get(element)?.get(key)?._program;
      return prior && { _coordinates: prior._final, _unit: prior._unit };
    });
    for (const draft of drafts) {
      count += draft._program._segments.length;
      if (count > MAX_CHANNELS) throw new MotionError('Слишком много сегментов');
      let channels = merged.get(draft.element);
      if (!channels) { channels = new Map(); merged.set(draft.element, channels); }
      const before = channels.get(draft.key);
      let next = draft;
      if (before) {
        const at = draft._program._segments[0]!._at;
        if (at < before._program._duration) throw new MotionError('Пересечение шагов');
        next = { ...draft, _program: { ...draft._program, _segments: [...before._program._segments, ...draft._program._segments], _nativeEase: undefined, _identity: undefined } };
      }
      channels.set(draft.key, next);
      end = Math.max(end, next._program._duration);
    }
    previousStart = offset; cursor = Math.max(0, end - sequenceClock.delay);
  }
  const drafts = [...merged.values()].flatMap(map => [...map.values()]).map(d => ({ ...d, reduced: d.reduced || sequenceClock.reduced, _program: { ...d._program, _duration: end, _nativeEase: undefined, _identity: undefined } }));
  return engine._execute(drafts, drafts.every(draft => draft.reduced) ? 0 : end);
}

export function sequence(steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
  return runSequence(runtime, steps, options);
}
