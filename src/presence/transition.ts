import { MotionParamError } from '../errors.js';
import { createPresence, type PresenceState } from './machine.js';

/** Структурный контракт существующего исполнителя; подходит также native Animation. */
export interface PresenceAnimation {
  readonly finished: PromiseLike<unknown>;
  cancel(): void;
}

/** Исход именно запрошенного перехода, а не последней фазы компонента. */
export type PresenceTransitionResult = Readonly<
  | { status: 'finished' | 'superseded' | 'destroyed'; present: boolean }
  | { status: 'failed'; present: boolean; error: unknown }
>;

type PhaseFactory = () => PresenceAnimation | readonly PresenceAnimation[] | void;

export interface PresenceTransitionOptions {
  /** Начальное присутствие не запускает анимацию при создании. По умолчанию false. */
  readonly initiallyPresent?: boolean;
  /** Синхронно передать исполнителей во владение перехода. Пустая фаза мгновенна. */
  readonly enter?: PhaseFactory;
  readonly exit?: PhaseFactory;
  /** Безопасные границы после завершения всей соответствующей группы. */
  readonly onPresent?: () => void;
  readonly onGone?: () => void;
}

export interface PresenceTransitionControls {
  /**
   * Одинаковое намерение возвращает прежний Promise, не перезапускает движение.
   * В активном состоянии синхронно бросает при неверном аргументе, ошибке запуска
   * фазы или отмены предшественника. После terminal-состояния возвращает текущий
   * Promise без повторной проверки аргумента.
   */
  setPresent(present: boolean): Promise<PresenceTransitionResult>;
  /**
   * Отменить принятых исполнителей. Не вызывает onGone и не делает revert.
   * Состояние и finished сначала становятся destroyed; ошибка cancel() после
   * этого пробрасывается синхронно. Повторный вызов инертен.
   */
  destroy(): void;
  readonly state: PresenceState | 'destroyed' | 'failed';
  readonly finished: Promise<PresenceTransitionResult>;
}

// Незавершённый Promise после отмены удерживает только обнуляемую ячейку,
// не контроллер, DOM, callbacks приложения или остальные анимации группы.
interface Sink { notify?: (failed: boolean, error?: unknown) => void }
interface Effect { cancel: () => void; sink: Sink }
interface Phase {
  present: boolean;
  ended: boolean;
  ready: boolean;
  destroyed: boolean;
  done?: () => void;
  effects: Map<PresenceAnimation, Effect>;
  resolve: (result: PresenceTransitionResult) => void;
}
type PromiseThen = PromiseLike<unknown>['then'];
function observe(finished: PromiseLike<unknown>, then: PromiseThen, sink: Sink): void {
  // PromiseLike допускает stateful accessor then. Читаем его при admission ровно
  // один раз, но сохраняем стандартную Promise once-semantics и исходный receiver.
  void new Promise<unknown>((resolve, reject) => {
    void then.call(finished, resolve, reject);
  }).then(
    () => sink.notify?.(false),
    error => sink.notify?.(true, error),
  );
}
function combine(errors: unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, 'Не удалось завершить переход присутствия');
}

/**
 * Управляемый переход поверх createPresence, без второго animator или часов.
 * Повторное открытие запускает преемника ДО отмены прежних исполнителей:
 * animate успевает передать ему текущие положение и скорость.
 */
export function createPresenceTransition(options: PresenceTransitionOptions = {}): PresenceTransitionControls {
  let config: PresenceTransitionOptions | undefined = options;
  let terminal: 'failed' | 'destroyed' | undefined;
  let current: Phase | undefined;
  let wanted = options.initiallyPresent === true;
  let finished = Promise.resolve<PresenceTransitionResult>(Object.freeze({ status: 'finished', present: wanted }));
  const machine = createPresence({
    initiallyPresent: wanted,
    onEnterStart: done => start(true, done),
    onExitStart: done => start(false, done),
    onPresent: () => config?.onPresent?.(),
    onGone: () => config?.onGone?.(),
  });
  // После destroy конфигурация не остаётся захваченной исходным аргументом.
  options = {};

  function end(phase: Phase, result: PresenceTransitionResult): void {
    if (phase.ended) return;
    phase.ended = true;
    phase.done = undefined;
    for (const effect of phase.effects.values()) effect.sink.notify = undefined;
    phase.resolve(Object.freeze(result));
  }

  function cancel(phase: Phase): unknown[] {
    const errors: unknown[] = [];
    for (const [animation, effect] of phase.effects) {
      phase.effects.delete(animation);
      effect.sink.notify = undefined;
      // Явная передача одного handle новой фазе сохраняет его нового владельца.
      if (current !== phase && current?.effects.has(animation)) continue;
      try { effect.cancel(); } catch (error) { errors.push(error); }
    }
    return errors;
  }

  function fail(phase: Phase, error: unknown): void {
    if (phase.ended) return;
    if (current === phase) { terminal = 'failed'; config = undefined; }
    // Отзыв до пользовательского cancel исключает реентрантное воскрешение.
    phase.ended = true;
    phase.done = undefined;
    const cleanupErrors = cancel(phase);
    phase.resolve(Object.freeze({ status: 'failed', present: phase.present,
      error: cleanupErrors.length ? combine([error, ...cleanupErrors]) : error }));
  }

  function complete(phase: Phase): void {
    if (!phase.ready || phase.ended || current !== phase || phase.effects.size !== 0) return;
    const done = phase.done;
    // Терминальный callback может тут же открыть встречную фазу: завершённая
    // фаза при этом не становится superseded задним числом.
    phase.ended = true;
    phase.done = undefined;
    try {
      done?.();
      if (phase.destroyed) {
        phase.resolve(Object.freeze({ status: 'destroyed', present: phase.present }));
        return;
      }
      phase.resolve(Object.freeze({ status: 'finished', present: phase.present }));
    } catch (error) {
      // destroy из terminal callback имеет приоритет над последующей ошибкой
      // того же callback: контроллер уже необратимо уничтожен.
      if (phase.destroyed) {
        phase.resolve(Object.freeze({ status: 'destroyed', present: phase.present }));
        return;
      }
      if (current === phase) { terminal = 'failed'; config = undefined; }
      phase.resolve(Object.freeze({ status: 'failed', present: phase.present, error }));
    }
  }

  function start(present: boolean, done: () => void): void {
    const phase = current!;
    phase.done = done;
    try {
      const factory = present ? config?.enter : config?.exit;
      if (phase.ended) return;
      const returned = factory?.();
      const list = returned === undefined ? [] : Array.isArray(returned) ? returned : [returned];
      const length = list.length;
      if (length > 10_000) throw new MotionParamError('LM174');
      const admissionErrors: unknown[] = [];
      for (let i = 0; i < length; i++) {
        try {
          if (!Object.hasOwn(list, i)) throw new MotionParamError('LM175');
          const animation: PresenceAnimation = list[i];
          if (!animation || typeof animation !== 'object') throw new MotionParamError('LM176');
          if (phase.effects.has(animation)) continue;
          const stop = animation.cancel;
          if (typeof stop !== 'function') throw new MotionParamError('LM177');
          const sink: Sink = {};
          phase.effects.set(animation, { cancel: () => stop.call(animation), sink });
          const completion = animation.finished;
          if (!completion) throw new MotionParamError('LM178');
          const then = completion.then;
          if (typeof then !== 'function') throw new MotionParamError('LM178');
          if (!phase.ended) sink.notify = (failed, error) => {
            if (failed) { fail(phase, error); return; }
            phase.effects.delete(animation);
            sink.notify = undefined;
            complete(phase);
          };
          observe(completion, then, sink);
        } catch (error) { admissionErrors.push(error); }
      }
      // Группа уже возвращена фабрикой: сбой одного getter не бросает
      // остальных переданных исполнителей без попытки принять и отменить их.
      if (admissionErrors.length) throw combine(admissionErrors);
      if (phase.ended) {
        const errors = cancel(phase);
        if (errors.length) throw combine(errors);
      }
    } catch (error) {
      fail(phase, error);
      // Даже завершённая реентрантно фаза могла принять ресурс после destroy.
      const leftover = cancel(phase);
      throw leftover.length ? combine([error, ...leftover]) : error;
    }
  }

  return {
    setPresent(present): Promise<PresenceTransitionResult> {
      if (terminal) return finished;
      if (typeof present !== 'boolean') throw new MotionParamError('LM173');
      if (present === wanted) return finished;
      wanted = present;
      const previous = current;
      if (previous) end(previous, { status: 'superseded', present: previous.present });
      let resolve!: Phase['resolve'];
      const promise = new Promise<PresenceTransitionResult>(yes => { resolve = yes; });
      const phase: Phase = { present, ended: false, ready: false, destroyed: false, effects: new Map(), resolve };
      current = phase;
      finished = promise;
      const errors: unknown[] = [];
      try { present ? machine.enter() : machine.exit(); } catch (error) { errors.push(error); }
      if (previous) errors.push(...cancel(previous));
      if (errors.length) { const error = combine(errors); fail(phase, error); throw error; }
      // Даже пустая фаза завершается только после регистрации и отмены предшественника.
      phase.ready = true;
      complete(phase);
      return promise;
    },
    destroy(): void {
      if (terminal) return;
      terminal = 'destroyed';
      config = undefined;
      if (current) {
        current.destroyed = true;
        end(current, { status: 'destroyed', present: current.present });
        const errors = cancel(current);
        if (errors.length) throw combine(errors);
      } else finished = Promise.resolve(Object.freeze({ status: 'destroyed', present: wanted }));
    },
    get state() { return terminal ?? machine.state; },
    get finished() { return finished; },
  };
}
