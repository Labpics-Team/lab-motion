/**
 * Узкоспециализированная DOM-пружина: явные значения → независимые WAAPI-lane.
 *
 * Граница намеренно узкая: только transform/opacity и WAAPI. Chromium/Firefox
 * требуют CSS linear(); WebKit получает явные адаптивные ключевые кадры.
 * Если возможностей среды нет, функция падает синхронно — скрытого запасного
 * rAF-пути здесь нет; универсальный путь остаётся в `../index`.
 */

import { compileRestingSpringRuntimeTimingIntoUnchecked } from '../../compositor/execution.js';
import { MotionParamError, type MotionParamErrorCode } from '../../errors.js';
import { type SpringParams, validateSpringParams } from '../../spring.js';
import {
  MAX_ANIMATE_TARGETS,
  requireAnimateOptions,
  requireAnimateProps,
} from '../targets.js';

type Pair = readonly [number, number];
type Prop = 'x' | 'y' | 'scale' | 'rotate' | 'opacity';

export interface NativeSpringProps {
  readonly x?: Pair;
  readonly y?: Pair;
  readonly scale?: Pair;
  readonly rotate?: Pair;
  readonly opacity?: Pair;
}

export interface NativeSpringOptions {
  /** Физика пружины. По умолчанию — канонические параметры 1/170/26. */
  readonly spring?: SpringParams;
  /** Явное переопределение; иначе prefers-reduced-motion читается при вызове. */
  readonly reducedMotion?: boolean;
}

export interface NativeSpringControls {
  readonly finished: Promise<void>;
  cancel(): void;
}

export interface NativeSpringElement {
  readonly style: { setProperty(name: string, value: string): void };
  animate(
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ): unknown;
}

export type NativeSpringTarget =
  | NativeSpringElement
  | string
  | ArrayLike<NativeSpringElement>
  | readonly NativeSpringElement[];

interface NativeAnimation {
  readonly finished: PromiseLike<unknown>;
  cancel(): void;
}

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const DONE_FINISHED: Promise<void> = Object.freeze(Promise.resolve());
const DONE: NativeSpringControls = Object.freeze({
  finished: DONE_FINISHED,
  cancel: Object.freeze(() => {}),
});
type Owner = (() => void) & {
  _generation: number;
  _slot: number;
  _frame: Record<string, string | number>;
};
type Channel = 'transform' | 'opacity';
type Run = [owner: Owner, element: NativeSpringElement, channel: Channel];
type RunSlot = Run | null;
type Repair = [element: NativeSpringElement, channel: Channel, parent: Repair | undefined];
type TerminalCell = [
  state: 0 | 1 | 2,
  action: (() => void) | null,
  fulfill: () => void,
  reject: () => void,
];

// Владелец гасит вытесненный эффект; фиксированный реестр WeakMap закрывает
// Object.prototype и не удерживает DOM-цели.
const ownerMaps: Record<Channel, WeakMap<NativeSpringElement, Owner>> = {
  transform: new WeakMap(),
  opacity: new WeakMap(),
};
// Связная цепочка замыкает цикл по той же паре element×channel,
// но сохраняет независимые вложенные каналы без числового предела.
let repairing: Repair | undefined;
let generation = 0;
let lastCss: unknown;
let lastLinear = false;

function claimOwnership(
  runs: readonly RunSlot[],
): void {
  const displaced: Owner[] = [];
  for (const run of runs) {
    if (run === null) continue;
    const [owner, element, channel] = run;
    const map = ownerMaps[channel];
    const previous = map.get(element);
    if (previous?._generation! > owner._generation) {
      displaced.push(owner);
      continue;
    }
    if (previous) displaced.push(previous);
    map.set(element, owner);
  }
  // Весь новый граф владения опубликован до реентрантной отмены хоста.
  for (const owner of displaced) owner();
}

function writeOwned(
  owner: Owner,
  element: NativeSpringElement,
  channel: Channel,
  value: string | number,
): void {
  const map = ownerMaps[channel];
  if (map.get(element) !== owner) return;
  try {
    element.style.setProperty(channel, String(value));
  } catch (error) {
    // Ошибка текущего владельца сохраняет его effect; вытесненная запись всё
    // равно обязана перейти к единственной компенсации победителя.
    if (map.get(element) === owner) throw error;
  }
  const winner = map.get(element);
  if (winner === owner) return;

  const previous = repairing;
  repairing = [element, channel, previous];
  try {
    element.style.setProperty(channel, String((winner ?? owner)._frame[channel]));
  } catch {
    // Бросок из компенсации не доказывает commit; это та же non-quiescent
    // транзакция независимо от причины host-ошибки.
    failNative('LM157');
  } finally {
    repairing = previous;
  }
}

function publishTerminal(cell: TerminalCell, state: 1 | 2): void {
  if (cell[0]) return;
  cell[0] = state;
  const action = cell[1];
  cell[1] = null;
  // Разрыв выполняется до возврата в host thenable; DOM-действие доставляется
  // отдельно и потому сохраняет Promise-подобную асинхронность terminal.
  if (action) void DONE_FINISHED.then(action);
}

function createTerminalCell(): TerminalCell {
  const cell = [0] as unknown as TerminalCell;
  // Эти callbacks создаются в top-level factory без DOM lexical scope.
  cell[2] = () => publishTerminal(cell, 1);
  cell[3] = () => publishTerminal(cell, 2);
  return cell;
}

/** @motionErrorFactory */
function failNative(code: MotionParamErrorCode): never {
  throw new MotionParamError(code);
}

function isElement(value: unknown): value is NativeSpringElement {
  return typeof (value as {
    style?: { setProperty?: unknown };
  } | null)?.style?.setProperty === 'function';
}

function resolveTargets(target: NativeSpringTarget): NativeSpringElement[] {
  let source: unknown = target;
  if (typeof target === 'string') {
    source = (globalThis as {
      document?: { querySelectorAll?: (selector: string) => ArrayLike<unknown> };
    }).document?.querySelectorAll?.(target) ?? failNative('LM149');
  }
  if (isElement(source)) return [source];
  let length = (source as { length?: number } | null)?.length as number;
  // Высокий предел сохраняет реальные DOM-списки, но отсекает OOM из hostile arraylike.
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ANIMATE_TARGETS) {
    failNative('LM146');
  }
  const result: NativeSpringElement[] = [];
  while (length--) {
    const item = (source as ArrayLike<unknown>)[result.length];
    if (!isElement(item)) failNative('LM147');
    result.push(item);
  }
  return result;
}

function parseProps(input: NativeSpringProps): Partial<Record<Prop, Pair>> {
  const parsed: Partial<Record<Prop, Pair>> = {};
  const keys = Object.keys(input);
  if (keys.length === 0) failNative('LM152');
  for (const key of keys) {
    if (key !== 'x' && key !== 'y' && key !== 'scale' && key !== 'rotate' && key !== 'opacity') {
      failNative('LM145');
    }
    const pair = (input as unknown as Record<string, unknown>)[key];
    if (!Array.isArray(pair) || pair.length !== 2) failNative('LM141');
    const from: unknown = pair[0];
    const to: unknown = pair[1];
    if (!Number.isFinite(from) || !Number.isFinite(to)) failNative('LM142');
    parsed[key as Prop] = [from as number, to as number];
  }
  return parsed;
}

function valueAt(pair: Pair, progress: number): number {
  if (progress === 0 || progress === 1) return pair[progress];
  const value = (1 - progress) * pair[0] + progress * pair[1];
  // На экстремальных конечных входах overshoot может быть непредставим в IEEE-754.
  return Number.isFinite(value) ? value : pair[1];
}

function frameAt(
  props: Partial<Record<Prop, Pair>>,
  progress: number,
): Record<string, string | number> {
  let transform = '';
  let pair = props.x;
  if (pair) transform = `translateX(${valueAt(pair, progress)}px)`;
  pair = props.y;
  if (pair) transform += (transform && ' ') + `translateY(${valueAt(pair, progress)}px)`;
  pair = props.scale;
  if (pair) transform += (transform && ' ') + `scale(${valueAt(pair, progress)})`;
  pair = props.rotate;
  if (pair) transform += (transform && ' ') + `rotate(${valueAt(pair, progress)}deg)`;
  pair = props.opacity;
  // Литералы создают собственные поля данных, не вызывая установщик прототипа.
  if (transform) {
    return pair ? { transform, opacity: valueAt(pair, progress) } : { transform };
  }
  return { opacity: valueAt(pair!, progress) };
}

function prefersReduced(explicit: boolean | undefined): boolean {
  try {
    // Вызов через globalThis сохраняет обязательный receiver Safari host-метода.
    return explicit ?? ((globalThis as {
      matchMedia?: (query: string) => { matches: boolean };
    }).matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
  } catch {
    return false;
  }
}

function supportsLinear(): boolean {
  const css = (globalThis as {
    CSS?: { supports?: (property: string, value: string) => boolean };
  }).CSS;
  if (css === lastCss) return lastLinear;
  lastCss = css;
  try {
    return lastLinear = css?.supports?.(
      'animation-timing-function',
      'linear(0, 1)',
    ) === true;
  } catch {
    return lastLinear = false;
  }
}

/**
 * Компилирует одну пружинную кривую и запускает отдельный эффект на каждый
 * независимый CSS-канал цели. Это позволяет вытеснять transform и opacity
 * раздельно, сохраняя общий физический тайминг.
 */
export function springTo(
  target: NativeSpringTarget,
  props: NativeSpringProps,
  options: NativeSpringOptions = {},
): NativeSpringControls {
  const token = ++generation;
  // Options — первая граница до чтения потенциально hostile target/props.
  options = requireAnimateOptions(options);
  // Snapshot закрывает caller-mutation после однократной валидирующей границы.
  const spring = { ...(options.spring ?? DEFAULT_SPRING) };
  validateSpringParams(spring);
  const values = parseProps(requireAnimateProps(props));
  const targets = resolveTargets(target);
  const finalFrame = frameAt(values, 1);
  const names = Object.keys(finalFrame);
  for (const element of targets) {
    for (const name of names) {
      for (let repair = repairing; repair; repair = repair[2]) {
        if (repair[0] === element && repair[1] === name) failNative('LM157');
      }
    }
  }

  if (prefersReduced(options.reducedMotion)) {
    const owner = (() => {}) as Owner;
    owner._generation = token;
    owner._frame = finalFrame;
    const runs: Run[] = [];
    for (const element of targets) {
      for (const name of names) {
        const channel = name as Channel;
        runs.push([owner, element, channel]);
      }
    }
    claimOwnership(runs);
    // Repair закрывает hostile reentry как между, так и внутри host-записей.
    for (const [, element, channel] of runs) {
      writeOwned(owner, element, channel, finalFrame[channel]!);
    }
    return DONE;
  }

  if (targets.length === 0) return DONE;
  for (const element of targets) {
    if (typeof element.animate !== 'function') failNative('LM153');
  }

  // Runtime-план — единый SSOT выбора custom linear() либо явных WebKit-кадров.
  // Runtime-plan уже имеет ровно WAAPI timing-shape; только
  // внутренние samples не должны утечь в hostile/polyfill host.
  const timing: Record<string, unknown> = {
    iterations: 1,
    fill: 'both',
    composite: 'replace',
  };
  const samples = compileRestingSpringRuntimeTimingIntoUnchecked(spring, timing);
  if (samples === undefined && !supportsLinear()) failNative('LM154');
  // Baseline не передаётся host: mutable single-effect keyframes не могут
  // отравить authoritative repair отменённого/вытесненного владельца.
  const initialFrame = frameAt(values, 0);
  let keyframes: Record<string, string | number>[];
  if (samples === undefined) {
    keyframes = [frameAt(values, 0), frameAt(values, 1)];
  } else {
    keyframes = new Array(samples.length / 2);
    for (let i = 0; i < keyframes.length; i++) {
      keyframes[i] = frameAt(values, samples[i * 2 + 1]!);
      keyframes[i]!['offset'] = samples[i * 2]! / 100;
    }
  }
  const plans = [keyframes];
  if (names.length > 1) {
    plans.push(keyframes.map((frame) => {
      const { transform: _transform, ...opacity } = frame;
      delete frame['opacity'];
      return opacity;
    }));
  }
  let pending = targets.length * plans.length;
  if (pending > 1) {
    // Один immutable-план не даёт hostile/polyfill первой цели изменить
    // семантику следующих без O(K × targets) копий и давления на GC.
    for (const plan of plans) {
      for (const frame of plan) Object.freeze(frame);
      Object.freeze(plan);
    }
    Object.freeze(timing);
  }
  const runs: RunSlot[] = [];
  let resolveFinished!: () => void;
  let rejectFinished!: (reason: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  let active = false;
  const settle = (owner: Owner): void => {
    // Знак кодирует library terminal; ноль уже снят и не воскресает.
    const live = owner._generation > 0;
    if (live) {
      owner._generation *= -1;
      pending--;
    }
    if (!pending) {
      let count = 0;
      for (const run of runs) {
        if (run) {
          run[0]._slot = count;
          runs[count++] = run;
        }
      }
      runs.length = count;
    }
    if (!pending && !active) resolveFinished();
  };
  try {
    for (const element of targets) {
      for (let i = 0; i < plans.length; i++) {
        const channel = names[i]! as Channel;
        const map = ownerMaps[channel];
        // Узкая WebIDL-граница не отдаёт подменной реализации доступ к узлам кэша.
        const animation = element.animate(plans[i]!, timing) as Partial<NativeAnimation> | null;
        const cancel = animation?.cancel;
        if (typeof cancel !== 'function') failNative('LM155');
        // Cancel регистрируется до чтения finished: бросающий host-getter не
        // оставит уже запущенную lane вне rollback-транзакции.
        const cell = createTerminalCell();
        let owner!: Owner;
        const stop = (): void => {
          cell[1] = null;
          if (!owner._generation) return;
          if (runs[owner._slot]?.[0] === owner) runs[owner._slot] = null;
          settle(owner);
          owner._generation = 0;
          if (map.get(element) === owner) map.delete(element);
          try { Reflect.apply(cancel, animation, []); } catch { /* эффект уже логически снят */ }
        };
        owner = stop as Owner;
        owner._generation = token;
        owner._slot = runs.length;
        owner._frame = initialFrame;
        runs.push([owner, element, channel]);
        const completion = animation!.finished;
        const then = completion?.then;
        if (typeof then !== 'function') failNative('LM155');
        cell[1] = (): void => {
          if (cell[0] === 2) {
            if (owner._generation) cancelAll(runs);
            return;
          }
          if (!owner._generation) return;
          active = true;
          try {
            writeOwned(owner, element, channel, finalFrame[channel]!);
            owner();
          } catch (error) {
            if ((error as { code?: unknown }).code === 'LM157') {
              // Reject занимает terminal до sibling-cancel, который может
              // синхронно довести pending до нуля.
              rejectFinished(error);
              cancelAll(runs);
            } else {
              settle(owner);
            }
          } finally {
            active = false;
            if (!pending) resolveFinished();
          }
        };
        try {
          Reflect.apply(then, completion, [cell[2], cell[3]]);
        } catch {
          cell[3]();
        }
      }
    }
  } catch (error) {
    cancelAll(runs);
    throw error;
  }
  claimOwnership(runs);

  return {
    finished,
    cancel(): void { cancelAll(runs); },
  };
}

function cancelAll(runs: RunSlot[]): void {
  // Pop до host-вызова закрывает реентрантный cancel без отдельного latch.
  while (runs.length) runs.pop()?.[0]();
}
