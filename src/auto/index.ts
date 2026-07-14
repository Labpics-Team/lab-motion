/**
 * auto/index.ts — zero-config FLIP (subpath ./auto).
 *
 * Закрывает S14 суперсета (класс AutoAnimate, D9): drop-in анимация
 * add/remove/move детей одного родителя. Канон (auto-animate.formkit.com):
 * autoAnimate(parent, options) → контроллер enable/disable; parent получает
 * position:relative, если статичен; дефолты 250ms / ease-in-out;
 * prefers-reduced-motion уважается по умолчанию.
 *
 * Архитектура: чистое ядро (planAuto — дифф по ключам с epsilon против
 * суб-пиксельной дрожи; строители кейфреймов поверх computeFlip) отделено от
 * DOM-адаптера. Адаптер минимален: MutationObserver — только триггер
 * переплана, весь дифф считается по кэшу rect'ов против текущих детей;
 * эмит — нативный element.animate (обвязка ./waapi: easing → linear()).
 * Все швы инжектируемы (MutationObserverCtor/matchMedia/getComputedPosition)
 * → тестируется duck-typed фейками без DOM; среда без MutationObserver
 * (SSR/legacy) получает инертный контроллер, не исключение.
 *
 * Reduced-motion — смена ХАРАКТЕРА, не выключение (ров суперсета):
 * move снапает (позиция меняется мгновенно, вестибулярное движение убрано),
 * enter/exit остаются opacity-фейдом (не вестибулярны). Канонический
 * AutoAnimate в этом режиме просто отключается — мы сохраняем обратную связь.
 *
 * Удаление: канон — узел реинсертится absolute на прежнем месте, играет
 * exit и физически удаляется на onfinish; до того исключён из планирования.
 *
 * Инварианты: zero-DOM на импорте, zero-deps, детерминизм чистого ядра,
 * CSS-safe (transform-числа через стражи computeFlip), MotionParamError рано.
 */

import { computeFlip, type FlipRect } from '../flip/index.js';
import { easingToLinear, type WaapiEasingFn } from '../waapi/index.js';
import { MotionParamError } from '../errors.js';

export type { FlipRect } from '../flip/index.js';

// ─── Чистое ядро: план ───────────────────────────────────────────────────────

/** Разложение childList-дельты на действия. */
export interface AutoPlan<K> {
  readonly enters: readonly K[];
  readonly exits: readonly (readonly [K, FlipRect])[];
  readonly moves: readonly (readonly [K, { readonly first: FlipRect; readonly last: FlipRect }])[];
}

const DEFAULT_EPSILON = 0.5;

function checkEpsilon(epsilon: number): void {
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new MotionParamError('LM001');
  }
}

/**
 * Чистый дифф двух снапшотов детей (ключ → rect). Move — только при сдвиге
 * или изменении размера сверх epsilon (суб-пиксельная дрожь layout не должна
 * плодить анимации). NaN-разницы не считаются движением (страж: сравнение
 * с epsilon у NaN ложно) — план всегда строится без исключений.
 */
export function planAuto<K>(
  prev: readonly (readonly [K, FlipRect])[],
  next: readonly (readonly [K, FlipRect])[],
  epsilon: number = DEFAULT_EPSILON,
): AutoPlan<K> {
  checkEpsilon(epsilon);
  const prevMap = new Map(prev);
  const nextMap = new Map(next);

  const enters: K[] = [];
  const moves: [K, { first: FlipRect; last: FlipRect }][] = [];
  for (const [key, last] of nextMap) {
    const first = prevMap.get(key);
    if (first === undefined) {
      enters.push(key);
      continue;
    }
    const movedBy =
      Math.abs(first.x - last.x) > epsilon ||
      Math.abs(first.y - last.y) > epsilon ||
      Math.abs(first.width - last.width) > epsilon ||
      Math.abs(first.height - last.height) > epsilon;
    if (movedBy) moves.push([key, { first, last }]);
  }

  const exits: [K, FlipRect][] = [];
  for (const [key, rect] of prevMap) {
    if (!nextMap.has(key)) exits.push([key, rect]);
  }

  return { enters, exits, moves };
}

// ─── Чистое ядро: кейфреймы ──────────────────────────────────────────────────

/** Схлопывает -0 → 0, чтобы не эмитить «-0px». */
function num(n: number): number {
  return n + 0 === 0 ? 0 : n;
}

/**
 * FLIP-кейфреймы движения: старт — инверсия first→last (числа через стражи
 * computeFlip, всегда конечны), конец — none. transform-origin '0 0' —
 * требование формул ./flip.
 */
export function moveKeyframes(first: FlipRect, last: FlipRect): Record<string, string | number>[] {
  const inv = computeFlip(first, last);
  return [
    {
      transform: `translate(${num(inv.dx)}px, ${num(inv.dy)}px) scale(${num(inv.sx)}, ${num(inv.sy)})`,
      transformOrigin: '0 0',
    },
    { transform: 'none' },
  ];
}

/** Появление: opacity-фейд (не вестибулярный — переживает reduced-motion). */
export function enterKeyframes(): Record<string, string | number>[] {
  return [{ opacity: 0 }, { opacity: 1 }];
}

/** Уход: обратный фейд. */
export function exitKeyframes(): Record<string, string | number>[] {
  return [{ opacity: 1 }, { opacity: 0 }];
}

// ─── DOM-адаптер ─────────────────────────────────────────────────────────────

/** Хендл нативной Animation в объёме, нужном адаптеру. */
interface AnimationLike {
  onfinish?: (() => void) | null;
  oncancel?: (() => void) | null;
  cancel?(): void;
  addEventListener?(type: 'finish' | 'cancel', listener: () => void): void;
  removeEventListener?(type: 'finish' | 'cancel', listener: () => void): void;
}

/** connected / disconnecting / disconnected. */
type OwnerPhase = 0 | 1 | 2;
/** reserved / reading / styling / appending / animating / binding / active / settling / released. */
type ExitPhase = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** revival / transfer / finish / cancel / disconnect / failure. */
type ExitOutcome = 0 | 1 | 2 | 3 | 4 | 5;
/** installing / live / retired. */
type GroupPhase = 0 | 1 | 2;
type StyleName = 'position' | 'left' | 'top';
/** unknown / parent / detached / foreign. */
type DomOwnership = 0 | 1 | 2 | 3;

interface ExitOwner {
  readonly identity: object;
  phase: OwnerPhase;
  snapshotGeneration: number;
  parent: AutoParent | undefined;
  observer: MutationObserverLike | undefined;
  cache: [AutoChild, FlipRect][] | undefined;
  disabled: boolean;
  epsilon: number;
  reduce: boolean;
  timing: object;
  readonly current: Map<AutoChild, ExitTransaction>;
  readonly settling: WeakMap<AutoChild, object>;
}

type StyleState = readonly [present: boolean, value: string, priority: string];

/** target, name, previous, owned. */
type StyleFieldLease = [Record<string, string>, StyleName, StyleState, StyleState | undefined];

type ExitStyleLease = StyleFieldLease[];

interface ExitTransaction {
  phase: ExitPhase;
  outcome: ExitOutcome | undefined;
  inFlight: number;
  ghost: boolean;
  echo: boolean;
  owner: ExitOwner | undefined;
  node: AutoChild | undefined;
  parent: AutoParent | undefined;
  style: ExitStyleLease | undefined;
  group: ExitGroup | undefined;
}

interface HandleOwner {
  generation: object;
  group: ExitGroup | undefined;
  installing: ExitGroup | undefined;
  cancelling: object | undefined;
}

/** kind=0, finish, cancel, finishAdded, cancelAdded. */
type EventHandlerLease = [0, () => void, () => void, boolean, boolean];
/** kind=1, finish, cancel, previous/owned finish, previous/owned cancel. */
type PropertyHandlerLease = [
  1, () => void, () => void, [unknown, boolean],
  [unknown, boolean] | undefined, [unknown, boolean] | undefined,
  [unknown, boolean] | undefined,
];

type HandlerLease = EventHandlerLease | PropertyHandlerLease;

interface ExitGroup {
  readonly generation: object;
  phase: GroupPhase;
  animation: AnimationLike | undefined;
  readonly owner: HandleOwner;
  readonly tickets: Set<ExitTransaction>;
  readonly finish: () => void;
  readonly cancel: () => void;
  handlers: HandlerLease | undefined;
}

type CancelToken = readonly [AnimationLike, HandleOwner, object];

/** transaction, owner, node, parent, generation, style, outcome, ghost, retired, cancel. */
type ExitCleanup = readonly [
  ExitTransaction, ExitOwner, AutoChild, AutoParent, object,
  ExitStyleLease | undefined, ExitOutcome, boolean,
  ExitGroup | undefined, CancelToken | undefined,
];

/** SSOT identity: один node-ticket и одно поколение host-handle во всех сессиях. */
const exitNodes = new WeakMap<AutoChild, ExitTransaction>();
const exitHandles = new WeakMap<AnimationLike, HandleOwner>();
const styleOwners = new WeakMap<object, Map<StyleName, StyleFieldLease>>();
const parentOwners = new WeakMap<AutoParent, ExitOwner>();
/** Последний наблюдённый owner-token не удерживает ни parent, ни его сессию. */
const observedParents = new WeakMap<AutoChild, object>();

/** Duck-typed минимум ребёнка: замер + WAAPI + инлайн-стили. */
interface AutoChild {
  /** Отсутствие parentNode означает unknown: transfer в незарегистрированный parent неотличим от detach. */
  readonly parentNode?: unknown | null;
  getBoundingClientRect(): FlipRect;
  animate?(keyframes: Record<string, string | number>[], timing: object): AnimationLike;
  style: Record<string, string>;
}

/** Duck-typed минимум родителя (реальный Element соответствует). */
export interface AutoParent {
  readonly children: ArrayLike<AutoChild> & Iterable<AutoChild>;
  /** Ширина бордера (absolute-дети позиционируются от padding-box). */
  readonly clientLeft?: number;
  readonly clientTop?: number;
  getBoundingClientRect(): FlipRect;
  appendChild(child: AutoChild): unknown;
  removeChild(child: AutoChild): unknown;
  style: Record<string, string>;
}

function isCurrent(transaction: ExitTransaction, phase?: ExitPhase): boolean {
  const owner = transaction.owner;
  const node = transaction.node;
  if (owner === undefined || node === undefined || owner.phase) return false;
  const current = owner.current.get(node);
  return (
    current === transaction &&
    exitNodes.get(node) === transaction &&
    (phase === undefined || transaction.phase === phase)
  );
}

function reserveExit(owner: ExitOwner, node: AutoChild, parent: AutoParent): ExitTransaction | undefined {
  if (
    owner.phase ||
    exitNodes.has(node) ||
    owner.settling.has(node)
  ) return undefined;
  const transaction: ExitTransaction = {
    phase: 0,
    outcome: undefined,
    inFlight: 0,
    ghost: false,
    echo: false,
    owner,
    node,
    parent,
    style: undefined,
    group: undefined,
  };
  owner.current.set(node, transaction);
  exitNodes.set(node, transaction);
  return transaction;
}

function readStyle(target: Record<string, string>, name: StyleName): StyleState {
  const getValue = Reflect.get(target, 'getPropertyValue');
  const getPriority = Reflect.get(target, 'getPropertyPriority');
  if (typeof getValue === 'function' && typeof getPriority === 'function') {
    const value = String(Reflect.apply(getValue, target, [name]));
    const priority = String(Reflect.apply(getPriority, target, [name]));
    return [value !== '' || priority !== '', value, priority];
  }
  const raw = Reflect.get(target, name);
  const value = raw === undefined || raw === null ? '' : String(raw);
  return [Object.hasOwn(target, name) || value !== '', value, ''];
}

function writeStyle(target: Record<string, string>, name: StyleName, state: StyleState): void {
  const set = Reflect.get(target, 'setProperty');
  const remove = Reflect.get(target, 'removeProperty');
  if (typeof set === 'function' && typeof remove === 'function') {
    if (state[0]) Reflect.apply(set, target, [name, state[1], state[2]]);
    else Reflect.apply(remove, target, [name]);
    return;
  }
  if (state[0]) {
    if (!Reflect.set(target, name, state[1])) throw new TypeError('style write rejected');
  } else {
    Reflect.deleteProperty(target, name);
  }
}

function styleOwnerMap(target: Record<string, string>): Map<StyleName, StyleFieldLease> {
  let map = styleOwners.get(target);
  if (map === undefined) {
    map = new Map();
    styleOwners.set(target, map);
  }
  return map;
}

function sameStyle(left: StyleState, right: StyleState): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function restoreStyleField(lease: StyleFieldLease): void {
  let map: Map<StyleName, StyleFieldLease> | undefined;
  try {
    map = styleOwners.get(lease[0]);
    if (map?.get(lease[1]) !== lease) return;
    // Terminal внутри setter видит ещё не подтверждённую запись. С этого
    // момента post-write значение может принадлежать реентрантному consumer;
    // reservation надо отпустить до возврата host-вызова, не присваивая его себе.
    if (lease[3] === undefined) {
      map.delete(lease[1]);
      return;
    }
    if (sameStyle(readStyle(lease[0], lease[1]), lease[3])) {
      writeStyle(lease[0], lease[1], lease[2]);
    }
  } catch { /* terminal остальных ресурсов не зависит от одного CSSOM-поля */ }
  finally {
    if (map?.get(lease[1]) === lease) map.delete(lease[1]);
  }
}

function restoreExitStyle(style: ExitStyleLease): void {
  for (const field of style) restoreStyleField(field);
}

function getHandleOwner(animation: AnimationLike): HandleOwner {
  let owner = exitHandles.get(animation);
  if (owner === undefined) {
    owner = { generation: {}, group: undefined, installing: undefined, cancelling: undefined };
    exitHandles.set(animation, owner);
  }
  return owner;
}

function captureCancelToken(animation: AnimationLike): CancelToken | undefined {
  try {
    const owner = getHandleOwner(animation);
    if (owner.group !== undefined || owner.cancelling !== undefined) return undefined;
    return [animation, owner, owner.generation];
  } catch {
    return undefined;
  }
}

function deactivateGroup(group: ExitGroup): CancelToken | undefined {
  const animation = group.animation;
  if (group.phase === 2) return undefined;
  const owns = group.owner.group === group && group.owner.generation === group.generation;
  if (owns) group.owner.group = undefined;
  group.phase = 2;
  return owns && animation !== undefined
    ? [animation, group.owner, group.generation]
    : undefined;
}

function detachExit(
  transaction: ExitTransaction,
  outcome: ExitOutcome,
  groupManaged = false,
): ExitCleanup | undefined {
  const owner = transaction.owner;
  const node = transaction.node;
  const parent = transaction.parent;
  if (owner === undefined || node === undefined || parent === undefined) return undefined;

  if (
    owner.current.get(node) === transaction && exitNodes.get(node) === transaction
  ) {
    owner.current.delete(node);
    exitNodes.delete(node);
    transaction.echo = false;
    owner.settling.set(node, transaction);
  }

  const group = transaction.group;
  group?.tickets.delete(transaction);
  const style = transaction.style;
  const ghost = transaction.ghost;
  transaction.phase = 7;
  transaction.outcome = outcome;
  transaction.owner = undefined;
  transaction.node = undefined;
  transaction.parent = undefined;
  transaction.style = undefined;
  transaction.group = undefined;

  const retired = !groupManaged && group !== undefined && group.tickets.size === 0
    ? group
    : undefined;
  const cancel = retired === undefined ? undefined : deactivateGroup(retired);
  return [transaction, owner, node, parent, transaction, style,
    outcome, ghost, retired, cancel];
}

function finalizeSettlement(cleanup: ExitCleanup): void {
  if (cleanup[0].inFlight !== 0) return;
  if (cleanup[1].settling.get(cleanup[2]) === cleanup[4]) {
    cleanup[1].settling.delete(cleanup[2]);
  }
  cleanup[0].phase = 8;
}

function finalizeFromContinuation(
  transaction: ExitTransaction,
  owner: ExitOwner,
  node: AutoChild,
  generation: object,
): void {
  if (transaction.inFlight !== 0) return;
  if (owner.settling.get(node) === generation) owner.settling.delete(node);
  if (transaction.phase === 7) transaction.phase = 8;
}

function hasChild(parent: AutoParent, node: AutoChild): boolean {
  for (const child of parent.children) if (child === node) return true;
  return false;
}

function inspectOwnership(node: AutoChild, parent: AutoParent, added = false): DomOwnership {
  let direct: unknown;
  try { direct = Reflect.get(node, 'parentNode'); } catch { return 0; }
  // Явный foreign — более сильный факт, чем потенциально stale children старого owner.
  if (direct !== undefined) return direct === parent ? 1 : direct === null ? 2 : 3;
  // add-record — временной oracle нового owner; его children сильнее stale old-parent list.
  if (added) try { return hasChild(parent, node) ? 1 : 2; } catch { return 0; }
  const identity = parentOwners.get(parent)?.identity;
  const observed = observedParents.get(node);
  if (observed !== undefined && observed !== identity) return 3;
  // Старый children-snapshot не доказывает ни владение, ни detach: новый
  // незарегистрированный parent принципиально невидим. Без direct/add oracle
  // безопасно оставить узел внешнему владельцу.
  return 0;
}

function removeExitNode(parent: AutoParent, node: AutoChild): void {
  if (inspectOwnership(node, parent) !== 1) return;
  try {
    parent.removeChild(node);
  } catch { /* узел уже удалён или больше не принадлежит parent */ }
}

function cancelIfUnclaimed(token: CancelToken): void {
  let current: HandleOwner | undefined;
  try {
    current = exitHandles.get(token[0]);
  } catch {
    return;
  }
  if (
    current !== token[1] ||
    current.generation !== token[2] ||
    current.group !== undefined ||
    current.cancelling !== undefined
  ) return;
  current.cancelling = token[2];
  try {
    token[0].cancel?.();
  } catch { /* поколение уже закрыто до reentrant host-вызова */ }
  finally {
    if (current.cancelling === token[2]) current.cancelling = undefined;
  }
}

function restoreHandler(
  animation: AnimationLike,
  name: 'onfinish' | 'oncancel',
  owned: [unknown, boolean] | undefined,
  previous: [unknown, boolean] | undefined,
): void {
  if (owned === undefined || previous === undefined) return;
  const value = Reflect.get(animation, name);
  if (value !== owned[0] || Object.hasOwn(animation, name) !== owned[1] ||
    Reflect.get(animation, name) !== value) return;
  // Если библиотека создала own-slot поверх inherited значения, delete и есть
  // точный restore. Иначе setter владеет формой: после его вызова внешний own
  // handler уже не наш и удалять его нельзя.
  if (!previous[1] && owned[1]) Reflect.deleteProperty(animation, name);
  else Reflect.set(animation, name, previous[0]);
}

function releaseHandlers(group: ExitGroup, final: boolean): void {
  const animation = group.animation;
  const lease = group.handlers;
  if (animation === undefined || lease === undefined) return;
  if (lease[0] === 0) {
    // Getter и сам host-вызов недоверен; каждый listener освобождается
    // независимо, чтобы первый бросок не удержал второй и весь ghost cleanup.
    if (lease[3]) try {
      const remove = animation.removeEventListener;
      if (typeof remove === 'function') Reflect.apply(remove, animation, ['finish', lease[1]]);
    } catch { /* cancel-listener освобождается независимо */ }
    if (lease[4]) try {
      const remove = animation.removeEventListener;
      if (typeof remove === 'function') Reflect.apply(remove, animation, ['cancel', lease[2]]);
    } catch { /* terminal ticket уже не зависит от host listener */ }
  } else {
    try { restoreHandler(animation, 'onfinish', lease[4], lease[3]); }
    catch { /* oncancel освобождается независимо */ }
    try { restoreHandler(animation, 'oncancel', lease[6], lease[5]); }
    catch { /* terminal ticket уже не зависит от host property */ }
  }
  if (final) group.handlers = undefined;
}

function completeRetiredGroup(group: ExitGroup): void {
  const owner = group.owner;
  if (owner.installing === group) {
    releaseHandlers(group, false);
    return;
  }
  if (owner.installing !== undefined) {
    releaseHandlers(group, false);
    return;
  }
  // Restore handler тоже host-вызов: lock не даёт старому setter записаться
  // после реентрантной установки следующего поколения.
  owner.installing = group;
  releaseHandlers(group, true);
  group.animation = undefined;
  owner.installing = undefined;
  pumpHandlers(owner);
}

function applyCleanup(cleanup: ExitCleanup): void {
  if (cleanup[8] !== undefined) completeRetiredGroup(cleanup[8]);
  if (cleanup[5] !== undefined) restoreExitStyle(cleanup[5]);
  if (cleanup[7] && cleanup[6] !== 0 && cleanup[6] !== 1) {
    removeExitNode(cleanup[3], cleanup[2]);
  }
  if (cleanup[9] !== undefined) cancelIfUnclaimed(cleanup[9]);
  finalizeSettlement(cleanup);
}

function terminalExit(transaction: ExitTransaction, outcome: ExitOutcome): void {
  const cleanup = detachExit(transaction, outcome);
  if (cleanup !== undefined) applyCleanup(cleanup);
}

function finishGroup(group: ExitGroup, outcome: 2 | 3 | 5): void {
  if (group.phase === 2) return;
  const token = deactivateGroup(group);
  const cleanups: ExitCleanup[] = [];
  for (const transaction of Array.from(group.tickets)) {
    const cleanup = detachExit(transaction, outcome, true);
    if (cleanup !== undefined) cleanups.push(cleanup);
  }
  group.tickets.clear();
  completeRetiredGroup(group);
  for (const cleanup of cleanups) applyCleanup(cleanup);
  if (outcome !== 3 && token !== undefined) cancelIfUnclaimed(token);
}

function recordNodes(record: unknown, key: 'addedNodes' | 'removedNodes'): AutoChild[] {
  try {
    const nodes = Reflect.get(record as object, key) as ArrayLike<AutoChild> | undefined;
    return nodes === undefined ? [] : Array.from(nodes);
  } catch {
    return [];
  }
}

function reconcileRecords(owner: ExitOwner, records: readonly unknown[]): void {
  let list: readonly unknown[];
  try { list = Array.from(records); } catch { return; }
  for (const record of list) {
    for (const node of recordNodes(record, 'addedNodes')) {
      const transaction = exitNodes.get(node);
      const parent = owner.parent;
      if (!owner.phase && parent !== undefined && inspectOwnership(node, parent, true) === 1) {
        observedParents.set(node, owner.identity);
      }
      if (transaction === undefined) continue;
      if (transaction.owner !== owner) {
        if (!owner.phase && parent !== undefined && observedParents.get(node) === owner.identity) {
          terminalExit(transaction, 1);
        }
        continue;
      }
      if (transaction.echo) {
        transaction.echo = false;
      } else {
        terminalExit(transaction, 0);
      }
    }
    for (const node of recordNodes(record, 'removedNodes')) {
      const transaction = exitNodes.get(node);
      if (transaction?.owner === owner) terminalExit(transaction, 1);
    }
  }
}

type HostResult<T> = readonly [T] | undefined;

function callHost<T>(
  transaction: ExitTransaction,
  phase: ExitPhase,
  call: () => T,
): HostResult<T> {
  if (!isCurrent(transaction)) return undefined;
  transaction.phase = phase;
  transaction.inFlight++;
  try {
    return [call()];
  } catch {
    return undefined;
  } finally {
    transaction.inFlight--;
  }
}

function installing(
  group: ExitGroup,
  animation?: AnimationLike,
  finish?: () => void,
): boolean {
  return (finish === undefined || Reflect.get(animation!, 'onfinish') === finish) &&
    group.owner.group === group && group.phase === 0;
}

function handlerSnapshot(
  group: ExitGroup,
  animation: AnimationLike,
  name: 'onfinish' | 'oncancel',
  finish?: () => void,
): [unknown, boolean] | undefined {
  const value = Reflect.get(animation, name);
  if (!installing(group, animation, finish)) return undefined;
  const own = Object.hasOwn(animation, name);
  if (!installing(group, animation, finish)) return undefined;
  if (Reflect.get(animation, name) !== value ||
    !installing(group, animation, finish)) return undefined;
  return [value, own];
}

function installedHandler(
  animation: AnimationLike,
  name: 'onfinish' | 'oncancel',
  value: () => void,
): [unknown, boolean] | undefined {
  const state = Reflect.get(animation, name);
  const own = Object.hasOwn(animation, name);
  return state === value && Reflect.get(animation, name) === state ? [state, own] : undefined;
}

function installHandlers(group: ExitGroup): boolean {
  const animation = group.animation;
  if (animation === undefined) return false;
  try {
    const add = animation.addEventListener;
    const remove = animation.removeEventListener;
    if (typeof add === 'function' && typeof remove === 'function') {
      const lease: EventHandlerLease = [0, group.finish, group.cancel, true, false];
      group.handlers = lease;
      Reflect.apply(add, animation, ['finish', lease[1]]);
      if (!installing(group)) return false;
      lease[4] = true;
      Reflect.apply(add, animation, ['cancel', lease[2]]);
      return installing(group);
    }

    const previousFinish = handlerSnapshot(group, animation, 'onfinish');
    if (previousFinish === undefined) return false;

    const lease: PropertyHandlerLease = [
      1, group.finish, group.cancel, previousFinish, undefined, undefined, undefined,
    ];
    group.handlers = lease;
    if (!Reflect.set(animation, 'onfinish', lease[1])) return false;
    lease[4] = installedHandler(animation, 'onfinish', lease[1]);
    if (lease[4] === undefined || !installing(group, animation, lease[1])) return false;

    const previousCancel = handlerSnapshot(group, animation, 'oncancel', lease[1]);
    if (previousCancel === undefined) return false;
    lease[5] = previousCancel;
    if (!Reflect.set(animation, 'oncancel', lease[2])) return false;
    lease[6] = installedHandler(animation, 'oncancel', lease[2]);
    return lease[6] !== undefined && installing(group, animation, lease[1]);
  } catch {
    return false;
  }
}

function pumpHandlers(owner: HandleOwner): void {
  if (owner.installing !== undefined) return;
  while (owner.group !== undefined && owner.group.phase === 0) {
    const group = owner.group;
    owner.installing = group;
    const installed = installHandlers(group);
    if (installed && owner.group === group && group.phase === 0) {
      group.phase = 1;
      for (const ticket of group.tickets) {
        if (isCurrent(ticket)) ticket.phase = 6;
      }
      owner.installing = undefined;
      return;
    }
    if (owner.group === group && group.phase === 0) {
      finishGroup(group, 5);
    }
    releaseHandlers(group, true);
    group.animation = undefined;
    owner.installing = undefined;
  }
}

/** settled / rejected / bound. */
type BindResult = 0 | 1 | 2;

function bindExit(transaction: ExitTransaction, animation: AnimationLike): BindResult {
  if (!isCurrent(transaction, 5)) return 0;
  const owner = getHandleOwner(animation);
  if (owner.cancelling !== undefined) return 1;

  let group = owner.group;
  const install = group === undefined;
  if (group === undefined) {
    const generation = {};
    owner.generation = generation;
    let created!: ExitGroup;
    created = {
      generation,
      phase: 0,
      animation,
      owner,
      tickets: new Set(),
      finish: () => finishGroup(created, 2),
      cancel: () => finishGroup(created, 3),
      handlers: undefined,
    };
    group = created;
    owner.group = group;
  }

  transaction.group = group;
  group.tickets.add(transaction);
  transaction.phase = group.phase === 1 ? 6 : 5;
  if (install) pumpHandlers(owner);
  if (!isCurrent(transaction)) return 0;
  return transaction.group === owner.group &&
    (transaction.phase === 6 || transaction.phase === 5)
    ? 2
    : 1;
}

function rollbackExit(
  transaction: ExitTransaction,
  owner: ExitOwner,
  node: AutoChild,
  parent: AutoParent,
  lease: ExitStyleLease | undefined,
  animation: AnimationLike | undefined,
  appended: boolean,
): void {
  const bound = transaction.group !== undefined;
  const current = isCurrent(transaction);
  if (current) {
    terminalExit(transaction, 5);
  }

  if (lease !== undefined) restoreExitStyle(lease);
  if (
    appended && transaction.outcome !== 0 && transaction.outcome !== 1
  ) removeExitNode(parent, node);
  if (animation !== undefined && !bound) {
    const token = captureCancelToken(animation);
    if (token !== undefined) cancelIfUnclaimed(token);
  }
  finalizeFromContinuation(transaction, owner, node, transaction);
}

function observeOwnership(
  transaction: ExitTransaction,
  node: AutoChild,
  parent: AutoParent,
): HostResult<DomOwnership> {
  return callHost(transaction, 1, () => inspectOwnership(node, parent));
}

function writeStyleField(
  transaction: ExitTransaction,
  target: Record<string, string>,
  name: StyleName,
  value: string,
): boolean {
  const previous = callHost(transaction, 1, () => readStyle(target, name));
  if (previous === undefined || !isCurrent(transaction, 1)) return false;
  const field: StyleFieldLease = [target, name, previous[0], undefined];
  let map: Map<StyleName, StyleFieldLease>;
  try {
    map = styleOwnerMap(target);
    if (map.has(name)) return false;
    map.set(name, field);
  } catch {
    return false;
  }
  transaction.style?.push(field);

  const requested: StyleState = [true, value, ''];
  const written = callHost(transaction, 2, () => writeStyle(target, name, requested));
  // CSSOM сериализует дроби по-разному в каждом движке; owned — только
  // фактический post-write snapshot, а не отправленная строка.
  const captured = isCurrent(transaction)
    ? callHost(transaction, 2, () => readStyle(target, name))
    : (() => {
        try { return [readStyle(target, name)] as const; }
        catch { return undefined; }
      })();
  if (captured !== undefined) field[3] = captured[0];
  else if (map.get(name) === field) map.delete(name);
  if (written !== undefined && captured !== undefined && isCurrent(transaction, 2)) return true;
  restoreStyleField(field);
  return false;
}

function startExit(
  transaction: ExitTransaction,
  rect: FlipRect,
  parentRect: FlipRect,
  timing: object,
): void {
  const owner = transaction.owner;
  const node = transaction.node;
  const parent = transaction.parent;
  if (owner === undefined || node === undefined || parent === undefined) return;

  let lease: ExitStyleLease | undefined;
  let animation: AnimationLike | undefined;
  let appended = false;

  // Актуальный parent oracle проверяется до любых style/DOM effects: старый
  // план не вправе отобрать узел, уже перенесённый потребителем в другой parent.
  const initialOwnership = observeOwnership(transaction, node, parent);
  if (initialOwnership === undefined || !isCurrent(transaction, 1)) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  if (initialOwnership[0] !== 2) {
    terminalExit(
      transaction,
      initialOwnership[0] === 1 ? 0 : 1,
    );
    return;
  }

  const animateResult = callHost(transaction, 1, () => node.animate);
  if (animateResult === undefined || !isCurrent(transaction, 1)) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  const animate = animateResult[0];
  if (typeof animate !== 'function') {
    terminalExit(transaction, 5);
    return;
  }

  const styleResult = callHost(transaction, 1, () => node.style);
  if (styleResult === undefined || !isCurrent(transaction, 1)) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  const target = styleResult[0];
  const clientLeft = callHost(transaction, 1, () => parent.clientLeft ?? 0);
  const clientTop = callHost(transaction, 1, () => parent.clientTop ?? 0);
  if (
    clientLeft === undefined ||
    clientTop === undefined ||
    !isCurrent(transaction, 1)
  ) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }

  lease = [];
  transaction.style = lease;
  for (const [name, value] of [
    ['position', 'absolute'],
    ['left', `${num(rect.x - parentRect.x - clientLeft[0])}px`],
    ['top', `${num(rect.y - parentRect.y - clientTop[0])}px`],
  ] as const) {
    if (!writeStyleField(transaction, target, name, value)) {
      rollbackExit(transaction, owner, node, parent, lease, animation, appended);
      return;
    }
  }

  const beforeAppend = observeOwnership(transaction, node, parent);
  if (beforeAppend === undefined || !isCurrent(transaction, 1)) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  if (beforeAppend[0] !== 2) {
    terminalExit(transaction, beforeAppend[0] === 1 ? 0 : 1);
    return;
  }

  transaction.phase = 3;
  transaction.echo = true;
  transaction.ghost = true;
  appended = true;
  const appendResult = callHost(transaction, 3, () => parent.appendChild(node));
  if (appendResult === undefined || !isCurrent(transaction, 3)) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }

  const afterAppend = observeOwnership(transaction, node, parent);
  if (afterAppend === undefined || !isCurrent(transaction, 1)) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  if (afterAppend[0] !== 1) {
    terminalExit(transaction, afterAppend[0] === 3 ? 1 : 5);
    return;
  }

  const animationResult = callHost(transaction, 4, () =>
    Reflect.apply(animate, node, [exitKeyframes(), timing]) as AnimationLike,
  );
  if (animationResult === undefined) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  animation = animationResult[0];
  if (!isCurrent(transaction, 4)) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }

  transaction.phase = 5;
  let bound: BindResult;
  try {
    bound = bindExit(transaction, animation);
  } catch {
    bound = 1;
  }
  if (bound === 2) return;
  if (bound === 1) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  finalizeFromContinuation(transaction, owner, node, transaction);
}

function animateIsolated(
  node: AutoChild,
  keyframes: Record<string, string | number>[],
  timing: object,
): void {
  try {
    const animate = node.animate;
    if (typeof animate === 'function') Reflect.apply(animate, node, [keyframes, timing]);
  } catch { /* ошибка одного host-узла не отравляет cache и соседей */ }
}

function disconnectExits(owner: ExitOwner): void {
  for (const transaction of Array.from(owner.current.values())) {
    terminalExit(transaction, 4);
  }
  owner.current.clear();
}

interface MutationObserverLike {
  observe(target: unknown, options: object): void;
  disconnect(): void;
  /** Browser SSOT очереди перед disconnect; optional сохраняет custom seams. */
  takeRecords?(): readonly unknown[];
}

export interface AutoAnimateOptions {
  /** Длительность (секунды движка). > 0. По умолчанию 0.25 (канон 250ms). */
  readonly duration?: number;
  /** Easing движка → эмитится CSS linear(). Нет → нативный 'ease-in-out'. */
  readonly easing?: WaapiEasingFn;
  /** Порог движения (px) против суб-пиксельной дрожи. По умолчанию 0.5. */
  readonly epsilon?: number;
  /** Уважать prefers-reduced-motion (смена характера). По умолчанию true. */
  readonly respectReducedMotion?: boolean;
  /** Инжектируемые швы (тесты / нестандартные среды). */
  readonly MutationObserverCtor?: new (cb: (records: unknown[]) => void) => MutationObserverLike;
  readonly matchMedia?: (query: string) => { matches: boolean };
  readonly getComputedPosition?: (el: AutoParent) => string;
}

export interface AutoAnimateControls {
  /** Вернуть анимации после disable(). Пересобирает снапшот (без прыжков). */
  enable(): void;
  /** Заглушить анимации: мутации применяются мгновенно (снап). */
  disable(): void;
  /** Отписать observer навсегда. */
  disconnect(): void;
}

function resolveReduce(options: AutoAnimateOptions): boolean {
  if (options.respectReducedMotion === false) return false;
  const mm =
    options.matchMedia ??
    (typeof matchMedia !== 'undefined' ? matchMedia.bind(globalThis) : undefined);
  if (mm === undefined) return false;
  try {
    return mm('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function currentSnapshot(owner: ExitOwner, parent: AutoParent, generation: number): boolean {
  return !owner.phase && owner.parent === parent &&
    owner.snapshotGeneration === generation;
}

function invalidateSnapshot(owner: ExitOwner, parent: AutoParent, generation: number): undefined {
  if (currentSnapshot(owner, parent, generation)) owner.cache = undefined;
}

function snapshot(owner: ExitOwner): [AutoChild, FlipRect][] | undefined {
  if (owner.phase) return undefined;
  const generation = ++owner.snapshotGeneration;
  const parent = owner.parent;
  if (parent === undefined) return undefined;
  let children: AutoChild[];
  try { children = Array.from(parent.children); }
  catch { return invalidateSnapshot(owner, parent, generation); }
  if (!currentSnapshot(owner, parent, generation)) return undefined;
  const entries: [AutoChild, FlipRect][] = [];
  for (const child of children) {
    if (!currentSnapshot(owner, parent, generation)) return undefined;
    if (!exitNodes.has(child) && !owner.settling.has(child)) {
      let rect: FlipRect;
      try { rect = child.getBoundingClientRect(); }
      catch { return invalidateSnapshot(owner, parent, generation); }
      if (!currentSnapshot(owner, parent, generation)) return undefined;
      entries.push([child, rect]);
    }
  }
  if (!currentSnapshot(owner, parent, generation)) return undefined;
  for (const [child] of entries) observedParents.set(child, owner.identity);
  return entries;
}

function processRecords(owner: ExitOwner, records: readonly unknown[]): void {
  if (owner.phase) return;
  reconcileRecords(owner, records);
  const parent = owner.parent;
  const previous = owner.cache;
  if (owner.phase || parent === undefined) return;
  const current = snapshot(owner);
  if (previous === undefined) {
    owner.cache = current;
    return;
  }
  if (current === undefined) return;
  owner.cache = current; // DOM-факт коммитится до любого host effect.
  if (owner.disabled) return;
  const plan = planAuto(previous, current, owner.epsilon);

  const reservations: Array<readonly [ExitTransaction, FlipRect]> = [];
  for (const [node, rect] of plan.exits) {
    const transaction = reserveExit(owner, node, parent);
    if (transaction !== undefined) reservations.push([transaction, rect]);
  }

  let parentRect: FlipRect | undefined;
  if (reservations.length > 0) {
    try {
      parentRect = parent.getBoundingClientRect();
    } catch {
      for (const [transaction] of reservations) terminalExit(transaction, 5);
    }
  }
  if (parentRect !== undefined) {
    for (const [transaction, rect] of reservations) {
      if (owner.phase) break;
      startExit(transaction, rect, parentRect, owner.timing);
    }
  }

  if (owner.phase) return;
  for (const node of plan.enters) {
    animateIsolated(node, enterKeyframes(), owner.timing);
    if (owner.phase) return;
  }
  if (!owner.reduce) {
    for (const [node, { first, last }] of plan.moves) {
      animateIsolated(node, moveKeyframes(first, last), owner.timing);
      if (owner.phase) return;
    }
  }
}

function observerCallback(owner: ExitOwner): (records: unknown[]) => void {
  return (records) => processRecords(owner, records);
}

function closeOwner(owner: ExitOwner): void {
  if (owner.phase) return;
  owner.phase = 1;
  owner.snapshotGeneration++;
  const parent = owner.parent;
  const observer = owner.observer;
  let pending: readonly unknown[] = [];
  try {
    // takeRecords — browser SSOT revival до того, как disconnect потеряет очередь.
    try { pending = observer?.takeRecords?.() ?? []; } catch { /* очередь недоступна */ }
    try { observer?.disconnect(); } catch { /* terminal выполняется в finally */ }
    reconcileRecords(owner, pending);
  } finally {
    try {
      disconnectExits(owner);
    } finally {
      if (parent !== undefined && parentOwners.get(parent) === owner) {
        parentOwners.delete(parent);
      }
      owner.cache = undefined;
      owner.parent = undefined;
      owner.observer = undefined;
      owner.phase = 2;
    }
  }
}

function controlsFor(owner: ExitOwner): AutoAnimateControls {
  return {
    enable(): void {
      if (owner.phase) return;
      owner.disabled = false;
      const current = snapshot(owner);
      if (current !== undefined) owner.cache = current;
    },
    disable(): void {
      if (!owner.phase) owner.disabled = true;
    },
    disconnect(): void {
      closeOwner(owner);
    },
  };
}

/**
 * Zero-config аниматор childList-мутаций родителя. Возвращает контроллер;
 * среда без MutationObserver → инертный контроллер (SSR/legacy), не бросок.
 */
export function autoAnimate(
  parent: AutoParent,
  options: AutoAnimateOptions = {},
): AutoAnimateControls {
  const existing = parentOwners.get(parent);
  if (existing !== undefined) return controlsFor(existing);
  // Reservation публикуется до любого host-вызова. Повторный вход получает
  // тот же single-writer owner, а disconnect инвалидирует все поздние effects.
  const owner: ExitOwner = {
    identity: {},
    phase: 0,
    snapshotGeneration: 0,
    parent,
    observer: undefined,
    cache: undefined,
    disabled: false,
    epsilon: DEFAULT_EPSILON,
    reduce: false,
    timing: {},
    current: new Map(),
    settling: new WeakMap(),
  };
  parentOwners.set(parent, owner);
  const controls = controlsFor(owner);
  try {
    const duration = options.duration ?? 0.25;
    if (owner.phase) return controls;
    if (!Number.isFinite(duration) || duration <= 0) throw new MotionParamError('LM002');
    const epsilon = options.epsilon ?? DEFAULT_EPSILON;
    if (owner.phase) return controls;
    owner.epsilon = epsilon;
    checkEpsilon(owner.epsilon);
    const easing = options.easing;
    if (owner.phase) return controls;
    owner.timing = {
      duration: duration * 1000,
      easing: easing === undefined ? 'ease-in-out' : easingToLinear(easing),
      fill: 'both' as const,
    };
    if (owner.phase) return controls;
    owner.reduce = resolveReduce(options);
    if (owner.phase) return controls;

    const Ctor = options.MutationObserverCtor ??
      (typeof MutationObserver === 'undefined' ? undefined : MutationObserver) as
        AutoAnimateOptions['MutationObserverCtor'];
    if (owner.phase) return controls;
    if (Ctor === undefined) {
      closeOwner(owner);
      return controls;
    }

    // Канон: static parent получает position:relative для absolute exit.
    const getPosition = options.getComputedPosition ?? ((el: AutoParent): string =>
      typeof getComputedStyle === 'undefined' ? '' : getComputedStyle(el as never).position);
    if (owner.phase) return controls;
    const position = getPosition(parent);
    if (owner.phase) return controls;
    if (position === 'static') {
      const style = parent.style;
      if (owner.phase) return controls;
      style['position'] = 'relative';
    }
    if (owner.phase) return controls;

    owner.cache = snapshot(owner);
    if (owner.phase) return controls;
    const observer = new Ctor(observerCallback(owner));
    if (owner.phase) {
      try { observer.disconnect(); } catch { /* ctor уже отдал внешний ресурс */ }
      return controls;
    }
    owner.observer = observer;
    observer.observe(parent, { childList: true });
    if (owner.phase) {
      try { observer.disconnect(); } catch { /* reentrant observe уже закрыл owner */ }
    }
  } catch (error) {
    closeOwner(owner);
    throw error;
  }
  return controls;
}
