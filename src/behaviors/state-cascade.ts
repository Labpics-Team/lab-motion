type StateRecord = Record<string, unknown>;
type StateKey<T extends StateRecord> = Extract<keyof T, string>;

/** Только реально изменившаяся эффективная поверхность. */
export interface StateCascadePatch<T extends StateRecord> {
  readonly changed: Readonly<Partial<T>>;
  readonly removed: readonly StateKey<T>[];
}

export interface StateCascadeLayer<T extends StateRecord> {
  /** Активен ли слой; пустой объект остаётся активным, но ничем не владеет. */
  readonly active: boolean;
  /** Shallow-snapshot новой цели слоя. Позднее созданный слой приоритетнее. */
  set(target: Readonly<Partial<T>>): StateCascadePatch<T>;
  /** Снять весь слой и раскрыть актуальные значения нижних владельцев. */
  clear(): StateCascadePatch<T>;
}

export interface StateCascade<T extends StateRecord> {
  /**
   * Создать слой поверх всех ранее созданных. Имена/глобальная таблица
   * приоритетов не нужны: семантическое имя остаётся у handle потребителя.
   */
  createLayer(initial?: Readonly<Partial<T>>): StateCascadeLayer<T>;
  /** Эффективное значение одного свойства после каскада. */
  get<K extends StateKey<T>>(key: K): T[K] | undefined;
  /** Копия всей эффективной цели; own `undefined` сохраняется. */
  snapshot(): Readonly<Partial<T>>;
  /** События только при изменении эффективного результата, не скрытых слоёв. */
  subscribe(listener: (patch: StateCascadePatch<T>) => void): () => void;
  /** Идемпотентно очистить состояние и сделать ранее выданные handles инертными. */
  destroy(): void;
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function nullObject<T extends object>(): T {
  return Object.create(null) as T;
}

function cloneTarget<T extends StateRecord>(target: Readonly<Partial<T>>): Readonly<Partial<T>> {
  const copy = nullObject<Partial<T>>();
  for (const key of Object.keys(target) as StateKey<T>[]) copy[key] = target[key];
  return copy;
}

function freezePatch<T extends StateRecord>(
  changed: Partial<T>,
  removed: StateKey<T>[],
): StateCascadePatch<T> {
  return Object.freeze({
    changed: Object.freeze(changed),
    removed: Object.freeze(removed),
  });
}

/**
 * Headless property cascade для одновременно активных визуальных намерений.
 * Позднее созданный слой имеет больший приоритет, но только для собственных
 * ключей. Поэтому press может владеть scale, selected — background, а снятие
 * одного намерения раскрывает свежее значение следующего владельца.
 */
export function createStateCascade<
  T extends StateRecord = StateRecord,
>(): StateCascade<T> {
  interface Slot { target: Readonly<Partial<T>> | undefined }
  const layers: Slot[] = [];
  const resolved = nullObject<Partial<T>>();
  const listeners = new Set<(patch: StateCascadePatch<T>) => void>();
  const empty = freezePatch<T>(nullObject<Partial<T>>(), []);
  let destroyed = false;

  const recompute = (inputKeys: readonly StateKey<T>[]): StateCascadePatch<T> => {
    if (destroyed || inputKeys.length === 0) return empty;
    const keys = new Set(inputKeys);
    const changed = nullObject<Partial<T>>();
    const removed: StateKey<T>[] = [];
    let count = 0;

    for (const key of keys) {
      let found = false;
      let next: T[typeof key] | undefined;
      for (let i = layers.length - 1; i >= 0; i--) {
        const target = layers[i]!.target;
        if (target !== undefined && hasOwn(target, key)) {
          next = target[key];
          found = true;
          break;
        }
      }

      const had = hasOwn(resolved, key);
      if (!found) {
        if (had) {
          delete resolved[key];
          removed.push(key);
          count++;
        }
        continue;
      }

      if (!had || !Object.is(resolved[key], next)) {
        resolved[key] = next;
        changed[key] = next;
        count++;
      }
    }

    if (count === 0) return empty;
    const patch = freezePatch(changed, removed);
    // Snapshot listeners: reentrant subscribe/unsubscribe относится к следующему emit.
    for (const listener of [...listeners]) listener(patch);
    return patch;
  };

  const inertLayer = (): StateCascadeLayer<T> => ({
    get active() { return false; },
    set: () => empty,
    clear: () => empty,
  });

  return {
    createLayer(initial) {
      if (destroyed) return inertLayer();
      const slot: Slot = { target: undefined };
      layers.push(slot);
      const layer: StateCascadeLayer<T> = {
        get active() { return !destroyed && slot.target !== undefined; },
        set(target) {
          if (destroyed) return empty;
          const previous = slot.target;
          const next = cloneTarget(target);
          slot.target = next;
          return recompute([
            ...(previous ? Object.keys(previous) as StateKey<T>[] : []),
            ...Object.keys(next) as StateKey<T>[],
          ]);
        },
        clear() {
          if (destroyed || slot.target === undefined) return empty;
          const previous = slot.target;
          slot.target = undefined;
          return recompute(Object.keys(previous) as StateKey<T>[]);
        },
      };
      if (initial !== undefined) layer.set(initial);
      return layer;
    },
    get(key) {
      return hasOwn(resolved, key) ? resolved[key] : undefined;
    },
    snapshot() {
      const copy = nullObject<Partial<T>>();
      for (const key of Object.keys(resolved) as StateKey<T>[]) copy[key] = resolved[key];
      return Object.freeze(copy);
    },
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      for (const layer of layers) layer.target = undefined;
      layers.length = 0;
      for (const key of Object.keys(resolved)) delete (resolved as Record<string, unknown>)[key];
    },
  };
}
