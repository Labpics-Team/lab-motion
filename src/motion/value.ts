import { MotionError, number } from './model.js';
import { runtime } from './runtime.js';
import type { Disposable, MotionOptions, Playback } from './types.js';

export interface MotionValue extends Disposable {
  get(): number;
  /** Немедленно установить значение; прежнее движение завершается как stopped. */
  set(value: number): void;
  animate(value: number | readonly number[], options?: MotionOptions): Playback;
  /** Уведомления идут после принятия значения. Первое значение читается через get(). */
  subscribe(listener: (value: number) => void): () => void;
}

export function value(initial: number = 0): MotionValue {
  let current = number(initial, 'value');
  let listeners = new Map<(value: number) => void, object>();
  let live = true;
  let animation: Playback | undefined;
  let notifying = false;
  const pending: number[] = [];
  function publish(next: number): void {
    if (!live || Object.is(current, next)) return;
    pending.push(next);
    if (notifying) return;
    notifying = true;
    const errors: unknown[] = [];
    try {
      while (pending.length && live) {
        current = pending.shift()!;
        for (const [listener, registration] of [...listeners]) {
          if (!live) break;
          if (listeners.get(listener) !== registration) continue;
          try { listener(current); } catch (error) { errors.push(error); }
        }
      }
    } finally { notifying = false; pending.length = 0; }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Ошибка подписки на движение');
  }
  const target = { style: {
    getPropertyValue() { return String(current); },
    setProperty(_property: string, next: string) {
      const parsed = number(Number(next), 'value');
      runtime.after(() => publish(parsed));
    },
  } } as unknown as Element;
  return {
    get: () => current,
    set(next): void {
      if (!live) return;
      next = number(next, 'value');
      animation?.stop(); animation = undefined;
      runtime.animate(target, { '--lab-motion-value': next }, { duration: 0 });
    },
    animate(next, options): Playback {
      if (!live) throw new MotionError('Значение уже освобождено');
      const started = runtime.animate(target, { '--lab-motion-value': next }, options);
      animation = started;
      void started.finished.then(() => { if (animation === started) animation = undefined; }, () => { if (animation === started) animation = undefined; });
      return started;
    },
    subscribe(listener): () => void {
      if (!live) return () => {};
      if (typeof listener !== 'function') throw new MotionError('subscribe ожидает функцию');
      const token = {};
      listeners.set(listener, token);
      // Сохранённый off не удерживает callback и не снимает новую регистрацию.
      const reference = new WeakRef(listener);
      return () => {
        const current = reference.deref();
        if (current && listeners.get(current) === token) listeners.delete(current);
      };
    },
    dispose(): void {
      if (!live) return;
      live = false; listeners.clear(); listeners = new Map(); pending.length = 0;
      try { animation?.stop(); } finally { animation = undefined; }
    },
  };
}
