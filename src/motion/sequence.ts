import { MAX_CHANNELS, failMotion, number, properties, snapshot, timing } from './model.js';
import { runtime, endOf, type Runtime, type Draft } from './runtime.js';
import type { MotionOptions, Playback, SequenceOptions, SequenceStep } from './types.js';
import type { Segment } from './program.js';

// До _execute сборщик владеет отдельным массивом сегментов каждого канала.
// Входные программы остаются неизменными; готовый план читает только runtime.
type SequenceDraft = Omit<Draft, '_program'> & {
  _program: Draft['_program'] & { readonly _segments: Segment[] };
};
type SequenceEnd = {
  -readonly [Key in '_duration' | '_identity']: Draft['_program'][Key];
};

/** Планирование шкалы отделено от исполнения: одиночный animate не удерживает его код. */
export function runSequence(engine: Runtime, steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
  const list = snapshot(steps, 'sequence');
  const sequenceClock = timing(options as MotionOptions | undefined);
  const terminal = sequenceClock._reduced || engine._host.reduced();
  const merged = new Map<Element, Map<string, SequenceDraft>>();
  let cursor = 0, previousStart = 0, end = 0, count = 0;
  for (const tuple of list) {
    const [target, props, option] = snapshot(tuple, 'sequence step', 2) as unknown as SequenceStep;
    if (tuple.length > 3) failMotion('Шаг: [target, properties, options]');
    const { at, ...rest } = option ?? {};
    const offset = at === '<' ? previousStart : at === undefined || at === '>' ? cursor : number(at, 'at', 0);
    const input = properties(props), clock = timing(rest);
    const drafts = engine._draft(target, input, clock, offset + sequenceClock._delay, (element, key) => {
      const prior = merged.get(element)?.get(key)?._program;
      return prior && { _coordinates: prior._segments.at(-1)!._to, _unit: prior._unit };
    }, terminal);
    for (const draft of drafts) {
      count += draft._program._segments.length;
      if (count > MAX_CHANNELS) failMotion('Слишком много сегментов');
      let channels = merged.get(draft._group._element);
      if (!channels) { channels = new Map(); merged.set(draft._group._element, channels); }
      const before = channels.get(draft._program._key);
      if (before && draft._offset + draft._program._segments[0]!._at < before._program._duration) failMotion('Пересечение шагов');
      const segments = before?._program._segments ?? [];
      const placement = draft._offset;
      for (const segment of draft._program._segments) segments.push(placement ? { ...segment, _at: placement + segment._at, _end: placement + segment._end } : segment);
      const next: SequenceDraft = { ...draft, _offset: 0, _program: { ...draft._program, _segments: segments, _duration: endOf(draft) } };
      channels.set(draft._program._key, next);
      end = Math.max(end, endOf(draft));
    }
    previousStart = offset; cursor = Math.max(0, end - sequenceClock._delay);
  }
  const drafts: Draft[] = [];
  for (const channels of merged.values()) for (const draft of channels.values()) {
    // Общая программа нескольких целей получает одинаковый конец. Сегменты
    // разных историй по-прежнему объединяются в отдельной оболочке выше.
    const program: SequenceEnd = draft._program;
    program._duration = end; program._identity = undefined;
    drafts.push(draft);
  }
  return engine._execute(drafts, drafts.every(draft => draft._reduced) ? 0 : end);
}

export function sequence(steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
  return runSequence(runtime, steps, options);
}
