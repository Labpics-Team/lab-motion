/**
 * Нативный DOM in-view adapter (subpath ./in-view).
 *
 * Только imperative shell: геометрию и планирование делает браузерный
 * IntersectionObserver. Модуль ничего не читает из DOM при импорте, а вызов
 * снимает target/options ровно один раз и владеет одним observer до stop().
 */

import { LAST_MOTION_PARAM_ERROR_CODE } from '../errors.js';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** Стабильный машинный код ошибки из физического ./in-view entry. */
export type MotionParamErrorCode = `LM${Digit}${Digit}${Digit}`;

const MOTION_PARAM_ERROR_CODE = /^LM\d{3}$/;

/** Constructor экспортируется рядом с inView для корректного instanceof. */
export class MotionParamError extends Error {
  override readonly name = 'MotionParamError';
  readonly code: MotionParamErrorCode;

  constructor(messageOrCode: string) {
    super(messageOrCode);
    this.code = messageOrCode <= LAST_MOTION_PARAM_ERROR_CODE &&
      MOTION_PARAM_ERROR_CODE.test(messageOrCode)
      ? messageOrCode as MotionParamErrorCode
      : 'LM000';
  }
}

/** 'some' и числовой ноль означают настоящее native intersection. */
export type InViewAmount = 'some' | 'all' | number;

/** Element, CSS-селектор или конечный array-like (включая NodeList). */
export type InViewTarget = Element | string | ArrayLike<Element>;

/** На natural leave приходит запись; terminal stop вызывает cleanup с undefined. */
export type InViewLeaveHandler = (entry?: IntersectionObserverEntry) => void;

/** Отсутствие cleanup выбирает one-shot семантику для конкретного target. */
export type InViewEnterHandler = (
  target: Element,
  entry: IntersectionObserverEntry,
) => void | InViewLeaveHandler;

export interface InViewOptions {
  /** Корень IntersectionObserver; null/undefined = viewport. */
  readonly root?: Element | Document | null | undefined;
  /** Нативный rootMargin, например '0px 0px -20%'. */
  readonly margin?: string | undefined;
  /** 'some' (default), 'all' или доля [0, 1]. */
  readonly amount?: InViewAmount | undefined;
}

export type InViewStop = () => void;

type Phase = 0 | 1 | 2; // installing | active | terminal

interface ObserverLease {
  readonly host: object;
  readonly observe: (this: object, target: Element) => void;
  readonly unobserve: (this: object, target: Element) => void;
  readonly disconnect: (this: object) => void;
}

interface Owner {
  phase: Phase;
  hostViolation: boolean;
  delivering: boolean;
  lease: ObserverLease | undefined;
  readonly targets: Set<Element>;
  readonly observed: Set<Element>;
  readonly done: Set<Element>;
  readonly leaves: Map<Element, InViewLeaveHandler>;
}

type Failure = readonly [unknown];

// Тот же доказанный верхний предел, что у других публичных DOM target-входов
// пакета. Меняется только общим решением о target-budget, не локально в adapter.
const MAX_IN_VIEW_TARGETS = 100_000;
const NOOP_STOP: InViewStop = () => undefined;

function containerError(): never {
  throw new MotionParamError('LM146');
}

function targetError(): never {
  throw new MotionParamError('LM147');
}

function optionsError(): never {
  throw new MotionParamError('LM156');
}

function hostError(): MotionParamError {
  return new MotionParamError('LM149');
}

function callbackError(): MotionParamError {
  return new MotionParamError('LM156');
}

function hasNativeNodeBrand(value: object, nodeType: 1 | 9): boolean | undefined {
  let NodeConstructor: typeof Node | undefined;
  try {
    NodeConstructor = globalThis.Node;
  } catch {
    return false;
  }
  if (NodeConstructor === undefined) return undefined;
  try {
    const getNodeType = Object.getOwnPropertyDescriptor(
      NodeConstructor.prototype,
      'nodeType',
    )?.get;
    return typeof getNodeType === 'function' &&
      Reflect.apply(getNodeType, value, []) === nodeType;
  } catch {
    return false;
  }
}

function isDomInstance(value: unknown, name: 'Element' | 'Document'): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const nativeBrand = hasNativeNodeBrand(value, name === 'Element' ? 1 : 9);
  if (nativeBrand !== undefined) return nativeBrand;
  try {
    const Constructor = Reflect.get(globalThis, name);
    return typeof Constructor === 'function' && Reflect.apply(
      Function.prototype[Symbol.hasInstance],
      Constructor,
      [value],
    );
  } catch {
    return false;
  }
}

function isElement(value: unknown): value is Element {
  return isDomInstance(value, 'Element');
}

function resolveSelector(selector: string): unknown {
  try {
    const document = Reflect.get(globalThis, 'document') as object | undefined;
    if (document === undefined || document === null) throw hostError();
    const query = Reflect.get(document, 'querySelectorAll');
    if (typeof query !== 'function') throw hostError();
    return Reflect.apply(query, document, [selector]);
  } catch {
    throw hostError();
  }
}

/** Снимает bounded array-like один раз и дедуплицирует в исходном порядке. */
function snapshotTargets(input: unknown): Element[] {
  const source = typeof input === 'string' ? resolveSelector(input) : input;
  if (isElement(source)) return [source];
  if ((typeof source !== 'object' && typeof source !== 'function') || source === null) {
    containerError();
  }

  let length: unknown;
  try {
    length = Reflect.get(source, 'length');
  } catch {
    containerError();
  }
  if (length === undefined) {
    try {
      if (Reflect.get(source, 'nodeType') !== undefined) targetError();
    } catch {
      targetError();
    }
  }
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_IN_VIEW_TARGETS
  ) containerError();

  const snapshot: Element[] = [];
  const seen = new Set<Element>();
  for (let i = 0; i < length; i++) {
    let target: unknown;
    try {
      target = Reflect.get(source, i);
    } catch {
      targetError();
    }
    if (!isElement(target)) targetError();
    if (!seen.has(target)) {
      seen.add(target);
      snapshot.push(target);
    }
  }
  return snapshot;
}

function snapshotOptions(
  input: InViewOptions,
): readonly [IntersectionObserverInit & { threshold: number }, boolean] {
  if (input === null || typeof input !== 'object') optionsError();
  let root: unknown;
  let margin: unknown;
  let amount: unknown;
  try {
    root = Reflect.get(input, 'root');
    margin = Reflect.get(input, 'margin');
    amount = Reflect.get(input, 'amount');
  } catch {
    optionsError();
  }
  if (
    root !== undefined &&
    root !== null &&
    !isElement(root) &&
    !isDomInstance(root, 'Document')
  ) optionsError();
  if (margin !== undefined) {
    if (typeof margin !== 'string') optionsError();
  }
  if (
    amount !== undefined &&
    amount !== 'some' &&
    amount !== 'all' &&
    (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      amount > 1
    )
  ) optionsError();
  return [
    {
      root: root === undefined ? null : root as Element | Document | null,
      rootMargin: margin ?? '0px',
      threshold: amount === 'all' ? 1 : typeof amount === 'number' ? amount : 0,
    },
    margin !== undefined,
  ];
}

function isDomSyntaxError(error: unknown): boolean {
  try {
    const Constructor = Reflect.get(globalThis, 'DOMException');
    return typeof Constructor === 'function' && Reflect.apply(
      Function.prototype[Symbol.hasInstance],
      Constructor,
      [error],
    ) && Reflect.get(error as object, 'name') === 'SyntaxError';
  } catch {
    return false;
  }
}

function captureLease(host: unknown): ObserverLease | undefined {
  if ((typeof host !== 'object' && typeof host !== 'function') || host === null) return undefined;
  try {
    const observe = Reflect.get(host, 'observe');
    const unobserve = Reflect.get(host, 'unobserve');
    const disconnect = Reflect.get(host, 'disconnect');
    if (
      typeof observe !== 'function' ||
      typeof unobserve !== 'function' ||
      typeof disconnect !== 'function'
    ) return undefined;
    return { host, observe, unobserve, disconnect };
  } catch {
    return undefined;
  }
}

/** Terminal transition публикуется до host/user cleanup: reentry видит no-op. */
function closeOwner(owner: Owner): Failure | undefined {
  if (owner.phase === 2) return undefined;
  owner.phase = 2;
  const lease = owner.lease;
  owner.lease = undefined;
  const cleanups = [...owner.leaves.values()];
  owner.leaves.clear();
  owner.targets.clear();
  owner.observed.clear();
  owner.done.clear();

  let failure: Failure | undefined;
  if (lease !== undefined) {
    try {
      Reflect.apply(lease.disconnect, lease.host, []);
    } catch {
      failure = [hostError()];
    }
  }
  for (const cleanup of cleanups) {
    try {
      cleanup(undefined);
    } catch (error) {
      failure ??= [error];
    }
  }
  return failure;
}

function failHost(owner: Owner): never {
  closeOwner(owner);
  throw hostError();
}

function recordFailure(current: Failure | undefined, error: unknown): Failure {
  return current ?? [error];
}

/** Ownership release никогда не бросает и сохраняет первую batch-ошибку. */
function releaseOneShot(
  owner: Owner,
  target: Element,
  current: Failure | undefined,
): Failure | undefined {
  if (owner.phase !== 1 || owner.done.has(target)) return current;
  owner.done.add(target);
  owner.observed.delete(target);
  const lease = owner.lease;
  if (lease === undefined) {
    closeOwner(owner);
    return current ?? [hostError()];
  }
  try {
    Reflect.apply(lease.unobserve, lease.host, [target]);
  } catch {
    closeOwner(owner);
    return current ?? [hostError()];
  }
  if (owner.observed.size === 0) {
    const closeFailure = closeOwner(owner);
    return current ?? closeFailure;
  }
  return current;
}

function recordHostFailure(owner: Owner, current: Failure | undefined): Failure {
  closeOwner(owner);
  return recordFailure(current, hostError());
}

function deliverEntries(
  owner: Owner,
  onEnter: InViewEnterHandler,
  threshold: number,
  entries: IntersectionObserverEntry[],
): void {
  let length: unknown;
  try {
    length = Reflect.get(entries, 'length');
  } catch {
    failHost(owner);
  }
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_IN_VIEW_TARGETS
  ) failHost(owner);

  let failure: Failure | undefined;
  for (let i = 0; i < length && owner.phase === 1; i++) {
    let entry: IntersectionObserverEntry;
    let target: Element;
    try {
      entry = Reflect.get(entries, i) as IntersectionObserverEntry;
      target = Reflect.get(entry, 'target') as Element;
    } catch {
      failure = recordHostFailure(owner, failure);
      break;
    }
    if (!owner.targets.has(target) || owner.done.has(target)) continue;

    let isIntersecting: unknown;
    let ratio: unknown;
    try {
      isIntersecting = Reflect.get(entry, 'isIntersecting');
      ratio = Reflect.get(entry, 'intersectionRatio');
    } catch {
      failure = recordHostFailure(owner, failure);
      break;
    }
    // Getter мог реентрантно вызвать stop(): terminal запрещает любой поздний user callback.
    if (owner.phase !== 1) break;
    if (!owner.targets.has(target) || owner.done.has(target)) continue;
    if (
      typeof isIntersecting !== 'boolean' ||
      typeof ratio !== 'number' ||
      !Number.isFinite(ratio) ||
      ratio < 0 ||
      ratio > 1
    ) {
      failure = recordHostFailure(owner, failure);
      break;
    }

    const inside = isIntersecting && (threshold === 0 || ratio >= threshold);
    const activeLeave = owner.leaves.get(target);
    if (!inside) {
      if (activeLeave !== undefined) {
        owner.leaves.delete(target);
        try {
          activeLeave(entry);
        } catch (error) {
          failure = recordFailure(failure, error);
        }
      }
      continue;
    }
    if (activeLeave !== undefined) continue;

    let leave: void | InViewLeaveHandler;
    try {
      leave = onEnter(target, entry);
    } catch (error) {
      failure = recordFailure(failure, error);
      if (owner.phase === 1) {
        failure = releaseOneShot(owner, target, failure);
      }
      continue;
    }

    if (owner.phase !== 1) {
      if (typeof leave === 'function') {
        try {
          leave(undefined);
        } catch (error) {
          failure = recordFailure(failure, error);
        }
      } else if (leave !== undefined) {
        failure = recordFailure(failure, callbackError());
      }
      break;
    }
    if (leave === undefined) {
      failure = releaseOneShot(owner, target, failure);
    } else if (typeof leave === 'function') {
      owner.leaves.set(target, leave);
    } else {
      failure = recordFailure(failure, callbackError());
      failure = releaseOneShot(owner, target, failure);
    }
  }
  if (failure !== undefined) throw failure[0];
}

function callbackFor(
  owner: Owner,
  onEnter: InViewEnterHandler,
  threshold: number,
): IntersectionObserverCallback {
  return (entries): void => {
    // Нативный IO доставляет записи задачей после observe(). Синхронная
    // доставка означает hostile/polyfill host: consumer callback ещё нельзя звать.
    if (owner.phase === 0) {
      owner.hostViolation = true;
      return;
    }
    if (owner.phase !== 1) return;
    // Нативный callback не реентрантен. Reservation до user code не даёт
    // повторному host-входу создать второго owner/cleanup того же target.
    if (owner.delivering) failHost(owner);
    owner.delivering = true;
    try {
      deliverEntries(owner, onEnter, threshold, entries);
    } finally {
      owner.delivering = false;
    }
  };
}

/**
 * Наблюдает snapshot целей через один нативный IntersectionObserver.
 *
 * Без возвращённого cleanup target становится one-shot. stop() идемпотентен,
 * отключает observer и выполняет все ещё активные leave-cleanup ровно один раз.
 */
export function inView(
  target: InViewTarget,
  onEnter: InViewEnterHandler,
  options: InViewOptions = {},
): InViewStop {
  if (typeof onEnter !== 'function') throw callbackError();
  const [init, hasExplicitMargin] = snapshotOptions(options);
  const targets = snapshotTargets(target);
  if (targets.length === 0) return NOOP_STOP;

  let Constructor: unknown;
  try {
    Constructor = Reflect.get(globalThis, 'IntersectionObserver');
  } catch {
    throw hostError();
  }
  if (typeof Constructor !== 'function') throw hostError();

  const owner: Owner = {
    phase: 0,
    hostViolation: false,
    delivering: false,
    lease: undefined,
    targets: new Set(targets),
    observed: new Set(),
    done: new Set(),
    leaves: new Map(),
  };
  const stop: InViewStop = () => {
    const failure = closeOwner(owner);
    if (failure !== undefined) throw failure[0];
  };

  let constructing = true;
  try {
    const host = Reflect.construct(
      Constructor,
      [callbackFor(owner, onEnter, init.threshold), init],
    );
    constructing = false;
    owner.lease = captureLease(host);
    if (owner.lease === undefined || owner.hostViolation) failHost(owner);
    for (const current of targets) {
      owner.observed.add(current);
      Reflect.apply(owner.lease.observe, owner.lease.host, [current]);
      if (owner.hostViolation) failHost(owner);
    }
    owner.phase = 1;
  } catch (error) {
    closeOwner(owner);
    // rootMargin grammar belongs to the native parser. Its DOM SyntaxError for
    // an explicitly supplied margin is caller input, not a host failure.
    if (constructing && hasExplicitMargin && isDomSyntaxError(error)) {
      throw new MotionParamError('LM156');
    }
    throw hostError();
  }
  return stop;
}
