import { MotionError, STOPPED, record, snapshot, timing } from './model.js';
import { animate, sequence, targets } from './runtime.js';
import { layout, type LayoutOptions } from './layout.js';
import { value, type MotionValue } from './value.js';
import { listen } from './listener.js';
import type { Disposable, MotionOptions, MotionProperties, MotionTarget, Playback, SequenceOptions, SequenceStep } from './types.js';

const stopped: Playback = Object.freeze({ state: 'stopped', duration: 0, finished: Promise.resolve(STOPPED),
  pause() {}, play() {}, seek() {}, stop() {}, finish() {} });

export function snapshotOptions(input: MotionOptions | undefined): MotionOptions {
  const result = input === undefined ? {} : { ...record(input, 'options') };
  if (result.spring !== undefined) result.spring = { ...record(result.spring, 'spring') };
  if (result.times !== undefined) result.times = snapshot(result.times as readonly number[], 'times');
  if (Array.isArray(result.ease)) result.ease = snapshot(result.ease, 'ease');
  timing(result as MotionOptions);
  return result as MotionOptions;
}
export function mergeOptions(defaults: MotionOptions, local: MotionOptions | undefined): MotionOptions {
  if (!local) return defaults;
  const own = snapshotOptions(local);
  const combined = { ...defaults, ...own } as Record<string, unknown>;
  if (own.spring !== undefined) { delete combined.duration; delete combined.ease; }
  else if (own.duration !== undefined || own.ease !== undefined) delete combined.spring;
  return combined as MotionOptions;
}

export interface MotionScope extends Disposable {
  animate(target: MotionTarget, properties: MotionProperties, options?: MotionOptions): Playback;
  sequence(steps: readonly SequenceStep[], options?: SequenceOptions): Playback;
  layout(mutate: () => void | Promise<void>, options?: LayoutOptions): Playback;
  value(initial?: number): MotionValue;
  scope(root: ParentNode, defaults?: MotionOptions): MotionScope;
  /** Подписка снимается вручную либо при dispose области. */
  on<K extends keyof GlobalEventHandlersEventMap>(target: EventTarget | string, event: K,
    listener: (event: GlobalEventHandlersEventMap[K]) => void, options?: AddEventListenerOptions): () => void;
  readonly disposed: boolean;
}

function own<T extends Disposable>(resources: Set<Disposable>, resource: T): T {
  const owner = new WeakRef(resources);
  const dispose = resource.dispose.bind(resource);
  resource.dispose = (): void => {
    owner.deref()?.delete(resource);
    dispose();
  };
  resources.add(resource);
  return resource;
}

export function scope(root: ParentNode, defaults?: MotionOptions): MotionScope {
  if (!root || typeof root.querySelectorAll !== 'function') throw new MotionError('scope ожидает Element, Document или ShadowRoot');
  let owner: ParentNode | undefined = root;
  let settings: MotionOptions = snapshotOptions(defaults);
  const playbacks = new Set<Playback>(), resources = new Set<Disposable>();
  const listeners = new Set<() => void>();
  function adopt(run: Playback): Playback {
    playbacks.add(run);
    const release = (): void => { playbacks.delete(run); };
    void run.finished.then(release, release);
    if (!owner) run.stop();
    return run;
  }
  function drain(): unknown[] {
    const errors: unknown[] = [];
    for (const run of playbacks) { try { run.stop(); } catch (error) { errors.push(error); } }
    for (const resource of resources) { try { resource.dispose(); } catch (error) { errors.push(error); } }
    for (const release of listeners) { try { release(); } catch (error) { errors.push(error); } }
    resources.clear(); listeners.clear();
    return errors;
  }
  return {
    get disposed(): boolean { return owner === undefined; },
    animate(target, properties, options): Playback {
      if (!owner) return stopped;
      const combined = mergeOptions(settings, options);
      const selected = targets(target, owner);
      if (!owner) return stopped;
      return adopt(animate(selected, properties, combined));
    },
    sequence(steps, options): Playback {
      if (!owner) return stopped;
      const input = snapshot(steps, 'sequence').map(step => {
        const [target, properties, opt] = snapshot(step, 'sequence step', 2) as unknown as SequenceStep;
        const { at, ...motion } = opt ?? {};
        return [targets(target, owner), properties, { ...mergeOptions(settings, motion), ...(at === undefined ? {} : { at }) }] as SequenceStep;
      });
      if (!owner) return stopped;
      return adopt(sequence(input, options));
    },
    layout(mutate, options): Playback {
      if (!owner) return stopped;
      const root = owner as Element;
      if (typeof root.getBoundingClientRect !== 'function') throw new MotionError('layout требует Element-контейнер');
      const { times: _times, stagger: _stagger, ...defaults } = settings;
      return adopt(layout(root, mutate, mergeOptions(defaults as MotionOptions, options) as LayoutOptions));
    },
    value(initial): MotionValue {
      if (!owner) throw new MotionError('Область уже освобождена');
      return own(resources, value(initial));
    },
    scope(root, defaults): MotionScope {
      if (!owner) throw new MotionError('Область уже освобождена');
      return own(resources, scope(root, mergeOptions(settings, defaults)));
    },
    on(target, event, listener, options): () => void {
      if (!owner) return () => {};
      const elements: EventTarget[] = typeof target === 'string' ? [...owner.querySelectorAll(target)] : [target];
      if (!owner) return () => {};
      return listen(elements, event, listener as EventListener, options, listeners, () => owner !== undefined);
    },
    dispose(): void {
      if (!owner) return;
      owner = undefined; settings = {};
      const errors = drain();
      // Запуск, ещё находящийся в пользовательском callback, увидит отзыв до следующего кадра.
      queueMicrotask(() => {
        const late = drain(); playbacks.clear();
        for (const error of late) globalThis.reportError?.(error);
      });
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Не удалось освободить область движения');
    },
  };
}
