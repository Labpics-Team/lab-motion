import { MotionParamError } from '../errors.js';
export { MotionParamError } from '../errors.js';
export type { MotionParamErrorCode } from '../errors.js';

/** Абсолютные цели одной визуальной роли, не команды повторного проигрывания. */
export type MotionBindingGoal = Readonly<Record<string, number | string>>;
export type MotionBindingGoals = Readonly<Record<string, MotionBindingGoal>>;

/** Ресурс остаётся безопасно отменяемым и после естественного завершения. */
export interface MotionBindingHandle { cancel(): void }

/** Порты связывают рецепт с существующим animate, MotionValue или renderer. */
export type MotionBindingTargets<G extends MotionBindingGoals> = {
  readonly [K in keyof G]: (goal: Readonly<G[K]>) => MotionBindingHandle | void;
};

export interface MotionBindingControls<Model> {
  /**
   * Проверить весь снимок, затем применить только изменённые роли.
   * Вложенные вызовы из портов ставятся в FIFO; проекция должна быть чистой.
   * Ошибки проекции/порта/отмены пробрасываются синхронно.
   */
  update(model: Model): void;
  /** Отменить принятые ресурсы, освободить рецепт. После вызова updates инертны. */
  destroy(): void;
  readonly state: 'active' | 'failed' | 'destroyed';
}

interface Effect { readonly identity: object; readonly cancel: () => void }
const MAX_ITEMS = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function combine(errors: readonly unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, 'Не удалось обновить привязку движения');
}

/**
 * Семантическая модель → неизменяемые цели → существующие исполнители.
 * Не хранит модель приложения, не заводит часы и не импортирует animate:
 * переданный порт сохраняет единственный registry/solver потребителя.
 */
export function createMotionBinding<Model, Goals extends MotionBindingGoals>(
  project: (model: Model) => Goals,
  targets: MotionBindingTargets<NoInfer<Goals>>,
): MotionBindingControls<Model> {
  if (typeof project !== 'function' || !record(targets)) throw new MotionParamError('LM173');
  let roles = Object.keys(targets);
  if (!roles.length || roles.length > MAX_ITEMS) throw new MotionParamError('LM173');
  let ports = roles.map(role => targets[role]!);
  if (ports.some(port => typeof port !== 'function')) throw new MotionParamError('LM173');
  let projectModel: typeof project | undefined = project;
  // Сохранённый terminal controller не удерживает исходные аргументы.
  project = undefined as unknown as typeof project;
  targets = undefined as unknown as typeof targets;
  let state: MotionBindingControls<Model>['state'] = 'active';
  let projecting = false, draining = false;
  let propertyKeys: string[][] | undefined;
  let previousGoals: readonly MotionBindingGoal[] | undefined;
  let active: Array<Effect | undefined> = [];
  const pending: Array<readonly MotionBindingGoal[] | undefined> = [];
  // Общий cancellation-scope для nested destroy и поздно вернувшихся handles.
  const released = new Set<object>();

  function release(effects: readonly (Effect | undefined)[], keep: readonly (Effect | undefined)[] = []): unknown[] {
    const protectedHandles = new Set(keep.map(effect => effect?.identity));
    const errors: unknown[] = [];
    for (const effect of effects) {
      if (!effect || protectedHandles.has(effect.identity) || released.has(effect.identity)) continue;
      released.add(effect.identity);
      try { effect.cancel(); } catch (error) { errors.push(error); }
    }
    return errors;
  }

  function terminate(outcome: 'failed' | 'destroyed', retired: readonly (Effect | undefined)[] = []): unknown[] {
    // Ошибка после реентрантного destroy не меняет его терминальный исход.
    if (state === 'active') state = outcome;
    const owned = active;
    active = [];
    previousGoals = propertyKeys = undefined;
    projectModel = undefined;
    roles = []; ports = [];
    pending.length = 0;
    return release([...owned, ...retired]);
  }

  function hasKeys(value: object, keys: readonly string[]): boolean {
    for (const key of keys) {
      const own = Object.hasOwn(value, key);
      // Proxy descriptor — такая же пользовательская граница, как getter.
      if (state !== 'active') return true;
      if (!own) return false;
    }
    return true;
  }

  function snapshot(value: unknown): readonly MotionBindingGoal[] | undefined {
    if (!record(value)) throw new MotionParamError('LM174');
    const names = Object.keys(value);
    if (state !== 'active') return;
    if (names.length !== roles.length || !hasKeys(value, roles)) {
      throw new MotionParamError('LM174');
    }
    if (state !== 'active') return;
    let count = roles.length;
    const keys: string[][] = [];
    const goals: MotionBindingGoal[] = [];
    for (let i = 0; i < roles.length; i++) {
      const input = value[roles[i]!];
      if (state !== 'active') return;
      if (!record(input)) throw new MotionParamError('LM174');
      const names = Object.keys(input);
      if (state !== 'active') return;
      count += names.length;
      if (!names.length || count > MAX_ITEMS) throw new MotionParamError('LM174');
      const expected = propertyKeys?.[i];
      if (expected && (names.length !== expected.length || !hasKeys(input, expected))) {
        throw new MotionParamError('LM174');
      }
      if (state !== 'active') return;
      const goal: Record<string, number | string> = Object.create(null);
      for (const key of names) {
        const value = input[key];
        if (state !== 'active') return;
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
          throw new MotionParamError('LM174');
        }
        goal[key] = value;
      }
      keys.push(names); goals.push(Object.freeze(goal));
    }
    propertyKeys ??= keys;
    return goals;
  }

  function capture(value: MotionBindingHandle | void): Effect | undefined {
    if (value === undefined) return;
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      throw new MotionParamError('LM173');
    }
    const stop = value.cancel;
    if (typeof stop !== 'function') throw new MotionParamError('LM173');
    return { identity: value, cancel: () => stop.call(value) };
  }

  return {
    update(model): void {
      if (state !== 'active') return;
      if (projecting) throw new MotionParamError('LM175');
      projecting = true;
      let goals: readonly MotionBindingGoal[] | undefined;
      try {
        const value = projectModel!(model);
        if (state !== 'active') return;
        goals = snapshot(value);
      } finally { projecting = false; }
      if (state !== 'active' || !goals) return;
      pending.push(goals);
      if (draining) return;
      draining = true;
      try {
        for (let cursor = 0; cursor < pending.length && state === 'active'; cursor++) {
          const next = pending[cursor]!;
          pending[cursor] = undefined;
          const retired: Array<Effect | undefined> = [];
          try {
            for (let i = 0; i < roles.length && state === 'active'; i++) {
              const goal = next[i]!;
              if (previousGoals && propertyKeys![i]!.every(key => Object.is(goal[key], previousGoals![i]![key]))) continue;
              const before = active[i];
              const apply = ports[i]!;
              const effect = capture(apply(goal as Goals[string]));
              if (state !== 'active') {
                const errors = release([effect]);
                if (errors.length) throw combine(errors);
                break;
              }
              if (effect) released.delete(effect.identity);
              active[i] = effect;
              retired.push(before);
            }
            previousGoals = state === 'active' ? next : undefined;
            // Все преемники уже созданы: обычный animate успел снять C¹-состояние.
            const errors = release(retired, active);
            if (errors.length) throw combine(errors);
          } catch (error) {
            const errors = terminate('failed', retired);
            throw errors.length ? combine([error, ...errors]) : error;
          }
        }
      } finally {
        pending.length = 0;
        released.clear();
        draining = false;
      }
    },
    destroy(): void {
      if (state !== 'active') return;
      const errors = terminate('destroyed');
      if (!draining) released.clear();
      if (errors.length) throw combine(errors);
    },
    get state() { return state; },
  };
}
