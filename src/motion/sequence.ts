import { MAX_CHANNELS, failMotion, number, properties, snapshot, timing } from './model.js';
import { runtime, type Runtime, type Draft } from './runtime.js';
import type { MotionOptions, Playback, SequenceOptions, SequenceStep } from './types.js';

// До _execute план принадлежит только сборщику sequence. Мутируемые поля
// ограничены оболочкой Draft и общими конечными параметрами Program.
type SequenceDraft = Omit<Draft, '_program' | '_reduced'> & {
  _program: Draft['_program'];
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
      count += draft._program._segments.length;
      if (count > MAX_CHANNELS) failMotion('Слишком много сегментов');
      let channels = merged.get(draft._element);
      if (!channels) { channels = new Map(); merged.set(draft._element, channels); }
      const before = channels.get(draft._key);
      const next: SequenceDraft = draft;
      if (before) {
        const at = draft._program._segments[0]!._at;
        if (at < before._program._duration) failMotion('Пересечение шагов');
        next._program = { ...draft._program, _segments: [...before._program._segments, ...draft._program._segments] };
      }
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
