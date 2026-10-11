import { MotionError } from './model.js';

/** Регистрация имеет собственную идентичность и очищается также после once/abort. */
export function listen(elements: readonly EventTarget[], type: string, callback: EventListener,
  options: AddEventListenerOptions | undefined, owner: Set<() => void>, active: () => boolean): () => void {
  if (typeof callback !== 'function') throw new MotionError('on ожидает функцию');
  const capture = Boolean(options?.capture), once = Boolean(options?.once);
  const passive = options?.passive, inputSignal = options?.signal;
  const registration: AddEventListenerOptions = { capture, once,
    ...(passive === undefined ? {} : { passive: Boolean(passive) }),
    ...(inputSignal === undefined ? {} : { signal: inputSignal }) };
  if (!active() || inputSignal?.aborted || elements.length === 0) return () => {};
  let listener: EventListener | undefined = callback;
  let signal: AbortSignal | undefined = inputSignal;
  const retained = new Set(elements);
  const parent = new WeakRef(owner);
  let released = false;
  function release(): void {
    if (released) return;
    released = true; listener = undefined;
    const targets = [...retained]; retained.clear();
    const abort = signal; signal = undefined;
    parent.deref()?.delete(release);
    const errors: unknown[] = [];
    if (abort) { try { abort.removeEventListener('abort', release); } catch (error) { errors.push(error); } }
    for (const target of targets) {
      try { target.removeEventListener(type, invoke, capture); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Не удалось снять подписки');
  }
  function invoke(this: EventTarget, event: Event): void {
    if (released || !retained.has(this)) return;
    const current = listener;
    // Нативный once уже снят к моменту callback. Освобождаем собственную регистрацию.
    if (once) { retained.delete(this); if (retained.size === 0) release(); }
    current?.call(this, event);
  }
  owner.add(release);
  try {
    signal?.addEventListener('abort', release, { once: true });
    if (signal?.aborted) release();
    for (const target of elements) {
      if (released || !active()) break;
      target.addEventListener(type, invoke, registration);
      // Host может синхронно отозвать область до физического добавления listener.
      if (released) target.removeEventListener(type, invoke, capture);
    }
  } catch (error) {
    try { release(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Ошибки подписки и очистки'); }
    throw error;
  }
  if (!active()) release();
  return release;
}
