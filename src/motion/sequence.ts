import { MAX_CHANNELS, failMotion, number, properties, snapshot, timing } from './model.js';
import { runtime, type Runtime, type Draft } from './runtime.js';
import type { MotionOptions, Playback, SequenceOptions, SequenceStep } from './types.js';
import type { Segment } from './program.js';

// До _execute сборщик владеет отдельным массивом сегментов каждого канала.
// Входные программы остаются неизменными; готовый план читает только runtime.
type SequenceDraft = Omit<Draft, '_program' | '_reduced'> & {
  _program: { -readonly [Key in keyof Draft['_program']]: Draft['_program'][Key] } & { _tail: Segment[] | undefined };
  _reduced: boolean;
};
type SequenceEnd = {
  -readonly [Key in '_duration' | '_nativeEase' | '_identity']: Draft['_program'][Key];
};

/** Планирование шкалы отделено от исполнения: одиночный animate не удерживает его код. */
export function runSequence(engine: Runtime, steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
  const list = snapshot(steps, 'sequence');
  const sequenceClock = timing(options as MotionOptions | undefined);
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
      return prior && { _coordinates: prior._final, _unit: prior._unit };
    });
    for (const draft of drafts) {
      count += 1 + (draft._program._tail?.length ?? 0);
      if (count > MAX_CHANNELS) failMotion('Слишком много сегментов');
      let channels = merged.get(draft._element);
      if (!channels) { channels = new Map(); merged.set(draft._element, channels); }
      const before = channels.get(draft._key);
      if (before && draft._program._at < before._program._duration) failMotion('Пересечение шагов');
      const trajectory = before?._program ?? { ...draft._program, _tail: draft._program._tail?.slice() };
      if (before) {
        const incoming = draft._program;
        (trajectory._tail ??= []).push({ _at: incoming._at, _end: incoming._end, _from: incoming._from,
          _to: incoming._to, _velocity: incoming._velocity, _timing: incoming._timing, _artifact: incoming._artifact });
        if (draft._program._tail) for (const segment of draft._program._tail) trajectory._tail.push(segment);
        trajectory._unit = draft._program._unit; trajectory._duration = draft._program._duration;
        trajectory._final = draft._program._final; trajectory._nativeEase = draft._program._nativeEase;
        trajectory._identity = draft._program._identity;
      }
      const next: SequenceDraft = { ...draft, _program: trajectory };
      channels.set(draft._key, next);
      end = Math.max(end, next._program._duration);
    }
    previousStart = offset; cursor = Math.max(0, end - sequenceClock._delay);
  }
  const drafts: Draft[] = [];
  for (const channels of merged.values()) for (const draft of channels.values()) {
    draft._reduced ||= sequenceClock._reduced;
    // Общая программа нескольких целей получает одинаковый конец. Сегменты
    // разных историй по-прежнему объединяются в отдельной оболочке выше.
    const program: SequenceEnd = draft._program;
    program._duration = end; program._nativeEase = undefined; program._identity = undefined;
    drafts.push(draft);
  }
  return engine._execute(drafts, drafts.every(draft => draft._reduced) ? 0 : end);
}

export function sequence(steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
  return runSequence(runtime, steps, options);
}
