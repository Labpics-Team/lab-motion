import { MAX_CHANNELS, failMotion, number, properties, snapshot, timing } from './model.js';
import { runtime, endOf, type Runtime, type Draft } from './runtime.js';
import type { MotionOptions, Playback, SequenceOptions, SequenceStep } from './types.js';
import type { Program, Segment } from './program.js';

// Immutable histories are shared when the same channel takes the same step.
interface History {
  readonly _previous: History | undefined;
  readonly _part: Program;
  readonly _offset: number;
  _composed?: Program;
}
type SequenceDraft = Draft & { readonly _history: History };

function compose(history: History, duration: number): Program {
  if (history._composed) return history._composed;
  const segments: Segment[] = [];
  for (let node: History | undefined = history; node; node = node._previous) {
    const offset = node._offset, part = node._part._segments;
    for (let i = part.length; i--;) {
      const segment = part[i]!;
      segments.push(offset ? { ...segment, _at: offset + segment._at, _end: offset + segment._end } : segment);
    }
  }
  segments.reverse();
  return history._composed = { ...history._part, _segments: segments, _duration: duration,
    _span: 0, _identity: undefined };
}

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
    const histories = new Map<Program, History>();
    for (const draft of drafts) {
      count += draft._program._segments.length;
      if (count > MAX_CHANNELS) failMotion('Слишком много сегментов');
      let channels = merged.get(draft._group._element);
      if (!channels) { channels = new Map(); merged.set(draft._group._element, channels); }
      const before = channels.get(draft._program._key);
      if (before && draft._offset + draft._program._segments[0]!._at < endOf(before)) failMotion('Пересечение шагов');
      const previous = before?._history, part = draft._program, cached = histories.get(part);
      const history = cached && cached._previous === previous && cached._offset === draft._offset
        ? cached : { _previous: previous, _part: part, _offset: draft._offset };
      histories.set(part, history);
      channels.set(part._key, { ...draft, _history: history });
      end = Math.max(end, endOf(draft));
    }
    previousStart = offset; cursor = Math.max(0, end - sequenceClock._delay);
  }
  const drafts: Draft[] = [];
  for (const channels of merged.values()) for (const draft of channels.values()) {
    drafts.push({ _group: draft._group, _program: compose(draft._history, end), _offset: 0, _reduced: draft._reduced });
  }
  return engine._execute(drafts, drafts.every(draft => draft._reduced) ? 0 : end);
}

export function sequence(steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
  return runSequence(runtime, steps, options);
}
