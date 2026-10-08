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
  const listeners = new Map<(value: number) => void, object>();
  let live = true;
  let generation: object | undefined;
  let animation: Playback | undefined;
  const target = { style: {
    getPropertyValue() { return String(current); },
    setProperty(_property: string, text: string) {
      const next = number(Number(text), 'value');
      if (!live || Object.is(current, next)) return;
      current = next;
      // Значение принято синхронно; уведомление принадлежит записавшему его прогону.
      runtime._notify(target, '--lab-motion-value', () => {
        const errors: unknown[] = [];
        for (const [listener, registration] of [...listeners]) {
          if (!live) break;
          if (listeners.get(listener) !== registration) continue;
          try { listener(next); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Ошибка подписки на движение');
      });
    },
  } } as unknown as Element;
  function start(next: number | readonly number[], options?: MotionOptions): Playback {
    const token = {}; generation = token;
    const started = runtime.animate(target, { '--lab-motion-value': next }, options);
    if (!live || generation !== token) { started.stop(); return started; }
    animation = started;
    const release = (): void => { if (animation === started) animation = undefined; };
    void started.finished.then(release, release);
    return started;
  }
  return {
    get: () => current,
    set(next): void {
      if (live) start(number(next, 'value'), { duration: 0 });
    },
    animate(next, options): Playback {
      if (!live) throw new MotionError('Значение уже освобождено');
      return start(next, options);
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
      live = false; generation = undefined; listeners.clear();
      const previous = animation; animation = undefined; previous?.stop();
    },
  };
}
