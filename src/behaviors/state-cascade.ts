type StateRecord = Record<string, unknown>;
type StateKey<T extends object> = Extract<keyof T, string>;

/** Только реально изменившаяся эффективная поверхность. */
export interface StateCascadePatch<T extends object> {
  readonly changed: Readonly<Partial<T>>;
  readonly removed: readonly StateKey<T>[];
}

export interface StateCascadeLayer<T extends object> {
  /** Активен ли слой; пустой объект остаётся активным, но ничем не владеет. */
  readonly active: boolean;
  /** Shallow-snapshot новой цели слоя. Позднее созданный слой приоритетнее. */
  set(target: Readonly<Partial<T>>): StateCascadePatch<T>;
  /** Снять весь слой и раскрыть актуальные значения нижних владельцев. */
  clear(): StateCascadePatch<T>;
  /** Навсегда снять слой, освободить ссылки и сделать handle инертным. */
  destroy(): StateCascadePatch<T>;
}

export interface StateCascade<T extends object> {
  /**
   * Создать слой поверх всех ранее созданных. Имена/глобальная таблица
   * приоритетов не нужны: семантическое имя остаётся у handle потребителя.
   */
  createLayer(initial?: Readonly<Partial<T>>): StateCascadeLayer<T>;
  /** Эффективное значение одного свойства после каскада. */
  get<K extends StateKey<T>>(key: K): T[K] | undefined;
  /** Копия всей эффективной цели; own `undefined` сохраняется. */
  snapshot(): Readonly<Partial<T>>;
  /**
   * Синхронные effective deltas в порядке коммитов. Реентрантный commit сразу
   * виден get/snapshot; его уведомление ждёт окончания текущего уведомления.
   * Набор получателей фиксируется при commit. destroy пресекает всю доставку.
   * Синхронные ошибки listeners выбрасываются после доставки (несколько — AggregateError).
   */
  subscribe(listener: (patch: StateCascadePatch<T>) => void): () => void;
  /** Идемпотентно очистить состояние и сделать ранее выданные handles инертными. */
  destroy(): void;
}

function nullObject<T extends object>(): T {
  return Object.create(null) as T;
}

function cloneTarget<T extends object>(target: Readonly<Partial<T>>): Readonly<Partial<T>> {
  const copy = nullObject<Partial<T>>();
  for (const key of Object.keys(target) as StateKey<T>[]) copy[key] = target[key];
  return copy;
}

function freezePatch<T extends object>(
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
  T extends object = StateRecord,
>(): StateCascade<T> {
  interface Slot {
    _target: Readonly<Partial<T>> | undefined;
    /** undefined — терминально отозванное право менять слой. */
    _revision: number | undefined;
  }
  type Listener = (patch: StateCascadePatch<T>) => void;
  const layers: Slot[] = [];
  let resolved = nullObject<Partial<T>>();
  const listeners = new Set<Listener>();
  const empty = freezePatch<T>(nullObject<Partial<T>>(), []);
  let destroyed = false;
  let notifying = false;
  const notices = new Map<StateCascadePatch<T>, Listener[]>();

  // FIFO не позволяет вложенному set доставить новое значение раньше старого.
  // Уже доставленные сообщения не удерживаются до конца длинной цепочки.
  const publish = (patch: StateCascadePatch<T>): StateCascadePatch<T> => {
    if (listeners.size === 0) return patch;
    notices.set(patch, [...listeners]);
    if (notifying) return patch;

    notifying = true;
    let errors: unknown[] | undefined;
    // Map сохраняет порядок добавления, включая записи из вложенных callbacks.
    for (const [current, recipients] of notices) {
      notices.delete(current);
      for (const listener of recipients) {
        if (destroyed) break;
        try { listener(current); } catch (error) { (errors ??= []).push(error); }
      }
    }
    notifying = false;
    if (errors?.length === 1) throw errors[0];
    if (errors && errors.length > 1) throw new AggregateError(errors);
    return patch;
  };

  const recompute = (affected: Partial<T>): StateCascadePatch<T> => {
    const changed = nullObject<Partial<T>>();
    const removed: StateKey<T>[] = [];
    let count = 0;

    for (const key in affected) {
      let winner: Readonly<Partial<T>> | undefined;
      for (let i = layers.length - 1; i >= 0; i--) {
        const target = layers[i]!._target;
        if (target !== undefined && Object.hasOwn(target, key)) {
          winner = target;
          break;
        }
      }

      const had = Object.hasOwn(resolved, key);
      if (!winner) {
        if (had) {
          delete resolved[key];
          removed.push(key);
          count++;
        }
        continue;
      }

      const next = winner[key];
      if (!had || !Object.is(resolved[key], next)) {
        resolved[key] = next;
        changed[key] = next;
        count++;
      }
    }

    if (count === 0) return empty;
    return publish(freezePatch(changed, removed));
  };

  return {
    createLayer(initial) {
      // Сначала snapshot: исключение getter не создаёт недоступный caller слой.
      const snapshot = destroyed || initial === undefined ? undefined : cloneTarget(initial);
      const slot: Slot = { _target: undefined, _revision: destroyed ? undefined : 0 };
      if (!destroyed) layers.push(slot);
      const replace = (next: Readonly<Partial<T>> | undefined): StateCascadePatch<T> => {
        const previous = slot._target;
        slot._target = next;
        // Own-key union без трёх промежуточных массивов и Set; значения уже сняты.
        return recompute(Object.assign(nullObject<Partial<T>>(), previous, next));
      };
      const layer: StateCascadeLayer<T> = {
        get active() { return slot._target !== undefined; },
        set(target) {
          if (slot._revision === undefined) return empty;
          const revision = slot._revision;
          const next = cloneTarget(target);
          // Getter может синхронно изменить или уничтожить тот же слой.
          if (slot._revision !== revision) return empty;
          slot._revision++; // Неудачное чтение входа не отзывает внешний valid commit.
          return replace(next);
        },
        clear() {
          if (slot._revision === undefined) return empty;
          slot._revision++;
          return replace(undefined);
        },
        destroy() {
          if (slot._revision === undefined) return empty;
          slot._revision = undefined;
          layers.splice(layers.indexOf(slot), 1);
          return replace(undefined);
        },
      };
      if (!destroyed && snapshot !== undefined) {
        try { replace(snapshot); } catch (error) {
          // При отказе конструктора caller не получит handle: слой не осиротеет.
          try { layer.destroy(); } catch (cleanupError) {
            throw new AggregateError([error, cleanupError]);
          }
          throw error;
        }
      }
      return layer;
    },
    get(key) {
      return resolved[key];
    },
    snapshot() {
      return Object.freeze(cloneTarget(resolved));
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
      notices.clear();
      for (const layer of layers) { layer._target = undefined; layer._revision = undefined; }
      layers.length = 0;
      resolved = nullObject<Partial<T>>();
    },
  };
}
