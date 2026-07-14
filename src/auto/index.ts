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

type OwnerPhase = 'connected' | 'disconnecting' | 'disconnected';
type ExitPhase =
  | 'reserved'
  | 'reading'
  | 'styling'
  | 'appending'
  | 'animating'
  | 'binding'
  | 'active'
  | 'settling'
  | 'released';
type ExitOutcome = 'revival' | 'transfer' | 'finish' | 'cancel' | 'disconnect' | 'failure';
type GroupPhase = 'installing' | 'live' | 'retired';
type StyleName = 'position' | 'left' | 'top';
type DomOwnership = 'parent' | 'detached' | 'foreign' | 'unknown';

interface ExitOwner {
  phase: OwnerPhase;
  parent: AutoParent | undefined;
  observer: MutationObserverLike | undefined;
  cache: [AutoChild, FlipRect][] | undefined;
  disabled: boolean;
  readonly epsilon: number;
  readonly reduce: boolean;
  readonly timing: object;
  readonly current: Map<AutoChild, ExitTransaction>;
  readonly echo: Map<AutoChild, object>;
  readonly settling: WeakMap<AutoChild, object>;
}

interface StyleState {
  readonly present: boolean;
  readonly value: string;
  readonly priority: string;
}

interface StyleFieldLease {
  readonly generation: object;
  readonly target: Record<string, string>;
  readonly name: StyleName;
  readonly previous: StyleState;
  owned: StyleState | undefined;
}

interface ExitStyleLease {
  readonly fields: StyleFieldLease[];
}

interface ExitTransaction {
  readonly generation: object;
  phase: ExitPhase;
  outcome: ExitOutcome | undefined;
  inFlight: number;
  ghost: boolean;
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

interface EventHandlerLease {
  readonly kind: 'events';
  readonly finish: () => void;
  readonly cancel: () => void;
  finishAdded: boolean;
  cancelAdded: boolean;
}

interface PropertyHandlerLease {
  readonly kind: 'properties';
  readonly finish: () => void;
  readonly cancel: () => void;
  readonly previousFinish: unknown;
  readonly previousCancel: unknown;
  finishWritten: boolean;
  cancelWritten: boolean;
}

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

interface CancelToken {
  readonly animation: AnimationLike;
  readonly owner: HandleOwner;
  readonly generation: object;
}

interface ExitCleanup {
  readonly transaction: ExitTransaction;
  readonly owner: ExitOwner;
  readonly node: AutoChild;
  readonly parent: AutoParent;
  readonly generation: object;
  readonly style: ExitStyleLease | undefined;
  readonly outcome: ExitOutcome;
  readonly ghost: boolean;
  readonly retired: ExitGroup | undefined;
  readonly cancel: CancelToken | undefined;
}

/** SSOT identity: один node-ticket и одно поколение host-handle во всех сессиях. */
const exitNodes = new WeakMap<AutoChild, ExitTransaction>();
const exitHandles = new WeakMap<AnimationLike, HandleOwner>();
const styleOwners = new WeakMap<object, Map<StyleName, StyleFieldLease>>();

/** Duck-typed минимум ребёнка: замер + WAAPI + инлайн-стили. */
interface AutoChild {
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
  if (owner === undefined || node === undefined || owner.phase !== 'connected') return false;
  const current = owner.current.get(node);
  return (
    current === transaction &&
    exitNodes.get(node) === transaction &&
    current.generation === transaction.generation &&
    (phase === undefined || transaction.phase === phase)
  );
}

function reserveExit(owner: ExitOwner, node: AutoChild, parent: AutoParent): ExitTransaction | undefined {
  if (
    owner.phase !== 'connected' ||
    exitNodes.has(node) ||
    owner.settling.has(node)
  ) return undefined;
  const transaction: ExitTransaction = {
    generation: {},
    phase: 'reserved',
    outcome: undefined,
    inFlight: 0,
    ghost: false,
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
    return { present: value !== '' || priority !== '', value, priority };
  }
  const raw = Reflect.get(target, name);
  const value = raw === undefined || raw === null ? '' : String(raw);
  return {
    present: Object.prototype.hasOwnProperty.call(target, name) || value !== '',
    value,
    priority: '',
  };
}

function writeStyle(target: Record<string, string>, name: StyleName, state: StyleState): void {
  const set = Reflect.get(target, 'setProperty');
  const remove = Reflect.get(target, 'removeProperty');
  if (typeof set === 'function' && typeof remove === 'function') {
    if (state.present) Reflect.apply(set, target, [name, state.value, state.priority]);
    else Reflect.apply(remove, target, [name]);
    return;
  }
  if (state.present) {
    if (!Reflect.set(target, name, state.value)) throw new TypeError('style write rejected');
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
  return left.present === right.present && left.value === right.value &&
    left.priority === right.priority;
}

function restoreStyleField(lease: StyleFieldLease): void {
  let map: Map<StyleName, StyleFieldLease> | undefined;
  try {
    map = styleOwners.get(lease.target);
    if (map?.get(lease.name) !== lease || lease.owned === undefined) return;
    if (sameStyle(readStyle(lease.target, lease.name), lease.owned)) {
      writeStyle(lease.target, lease.name, lease.previous);
    }
  } catch { /* terminal остальных ресурсов не зависит от одного CSSOM-поля */ }
  finally {
    if (map?.get(lease.name) === lease && lease.owned !== undefined) map.delete(lease.name);
  }
}

function restoreExitStyle(style: ExitStyleLease): void {
  for (const field of style.fields) restoreStyleField(field);
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
    return { animation, owner, generation: owner.generation };
  } catch {
    return undefined;
  }
}

function deactivateGroup(group: ExitGroup): CancelToken | undefined {
  const animation = group.animation;
  if (group.phase === 'retired') return undefined;
  const owns = group.owner.group === group && group.owner.generation === group.generation;
  if (owns) group.owner.group = undefined;
  group.phase = 'retired';
  return owns && animation !== undefined
    ? { animation, owner: group.owner, generation: group.generation }
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
    if (owner.echo.get(node) === transaction.generation) owner.echo.delete(node);
    owner.settling.set(node, transaction.generation);
  }

  const group = transaction.group;
  group?.tickets.delete(transaction);
  const style = transaction.style;
  const ghost = transaction.ghost;
  transaction.phase = 'settling';
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
  return {
    transaction,
    owner,
    node,
    parent,
    generation: transaction.generation,
    style,
    outcome,
    ghost,
    retired,
    cancel,
  };
}

function finalizeSettlement(cleanup: ExitCleanup): void {
  if (cleanup.transaction.inFlight !== 0) return;
  if (cleanup.owner.settling.get(cleanup.node) === cleanup.generation) {
    cleanup.owner.settling.delete(cleanup.node);
  }
  cleanup.transaction.phase = 'released';
}

function finalizeFromContinuation(
  transaction: ExitTransaction,
  owner: ExitOwner,
  node: AutoChild,
  generation: object,
): void {
  if (transaction.inFlight !== 0) return;
  if (owner.settling.get(node) === generation) owner.settling.delete(node);
  if (transaction.phase === 'settling') transaction.phase = 'released';
}

function inspectOwnership(node: AutoChild, parent: AutoParent): DomOwnership {
  try {
    const direct = Reflect.get(node, 'parentNode');
    if (direct === parent) return 'parent';
    if (Array.from(parent.children).includes(node)) return 'parent';
    if (direct === null) return 'detached';
    if (direct !== undefined) return 'foreign';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function removeExitNode(parent: AutoParent, node: AutoChild): void {
  if (inspectOwnership(node, parent) !== 'parent') return;
  try {
    parent.removeChild(node);
  } catch { /* узел уже удалён или больше не принадлежит parent */ }
}

function cancelIfUnclaimed(token: CancelToken): void {
  let current: HandleOwner | undefined;
  try {
    current = exitHandles.get(token.animation);
  } catch {
    return;
  }
  if (
    current !== token.owner ||
    current.generation !== token.generation ||
    current.group !== undefined ||
    current.cancelling !== undefined
  ) return;
  current.cancelling = token.generation;
  try {
    token.animation.cancel?.();
  } catch { /* поколение уже закрыто до reentrant host-вызова */ }
  finally {
    if (current.cancelling === token.generation) current.cancelling = undefined;
  }
}

function releaseHandlers(group: ExitGroup, final: boolean): void {
  const animation = group.animation;
  const lease = group.handlers;
  if (animation === undefined || lease === undefined) return;
  if (lease.kind === 'events') {
    const remove = animation.removeEventListener;
    if (typeof remove === 'function') {
      try {
        if (lease.finishAdded) Reflect.apply(remove, animation, ['finish', lease.finish]);
      } catch { /* cancel-listener освобождается независимо */ }
      try {
        if (lease.cancelAdded) Reflect.apply(remove, animation, ['cancel', lease.cancel]);
      } catch { /* terminal ticket уже не зависит от host listener */ }
    }
  } else {
    try {
      if (lease.finishWritten && Reflect.get(animation, 'onfinish') === lease.finish) {
        Reflect.set(animation, 'onfinish', lease.previousFinish ?? null);
      }
    } catch { /* oncancel освобождается независимо */ }
    try {
      if (lease.cancelWritten && Reflect.get(animation, 'oncancel') === lease.cancel) {
        Reflect.set(animation, 'oncancel', lease.previousCancel ?? null);
      }
    } catch { /* terminal ticket уже не зависит от host property */ }
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
  if (cleanup.retired !== undefined) completeRetiredGroup(cleanup.retired);
  if (cleanup.style !== undefined) restoreExitStyle(cleanup.style);
  if (cleanup.ghost && cleanup.outcome !== 'revival' && cleanup.outcome !== 'transfer') {
    removeExitNode(cleanup.parent, cleanup.node);
  }
  if (cleanup.cancel !== undefined) cancelIfUnclaimed(cleanup.cancel);
  finalizeSettlement(cleanup);
}

function terminalExit(transaction: ExitTransaction, outcome: ExitOutcome): void {
  const cleanup = detachExit(transaction, outcome);
  if (cleanup !== undefined) applyCleanup(cleanup);
}

function finishGroup(group: ExitGroup, outcome: 'finish' | 'cancel' | 'failure'): void {
  if (group.phase === 'retired') return;
  const token = deactivateGroup(group);
  const cleanups: ExitCleanup[] = [];
  for (const transaction of Array.from(group.tickets)) {
    const cleanup = detachExit(transaction, outcome, true);
    if (cleanup !== undefined) cleanups.push(cleanup);
  }
  group.tickets.clear();
  completeRetiredGroup(group);
  for (const cleanup of cleanups) applyCleanup(cleanup);
  if (outcome !== 'cancel' && token !== undefined) cancelIfUnclaimed(token);
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
      if (transaction === undefined) continue;
      if (
        transaction.owner === owner &&
        owner.echo.get(node) === transaction.generation
      ) {
        owner.echo.delete(node);
      } else {
        terminalExit(transaction, 'revival');
      }
    }
    for (const node of recordNodes(record, 'removedNodes')) {
      const transaction = exitNodes.get(node);
      if (transaction !== undefined) terminalExit(transaction, 'transfer');
    }
  }
}

type HostResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function callHost<T>(
  transaction: ExitTransaction,
  phase: ExitPhase,
  call: () => T,
): HostResult<T> {
  if (!isCurrent(transaction)) return { ok: false };
  transaction.phase = phase;
  transaction.inFlight++;
  try {
    return { ok: true, value: call() };
  } catch {
    return { ok: false };
  } finally {
    transaction.inFlight--;
  }
}

function installHandlers(group: ExitGroup): boolean {
  const animation = group.animation;
  if (animation === undefined) return false;
  try {
    const add = animation.addEventListener;
    const remove = animation.removeEventListener;
    if (typeof add === 'function' && typeof remove === 'function') {
      const lease: EventHandlerLease = {
        kind: 'events',
        finish: group.finish,
        cancel: group.cancel,
        finishAdded: true,
        cancelAdded: false,
      };
      group.handlers = lease;
      Reflect.apply(add, animation, ['finish', lease.finish]);
      if (group.owner.group !== group || group.phase !== 'installing') return false;
      lease.cancelAdded = true;
      Reflect.apply(add, animation, ['cancel', lease.cancel]);
      return group.owner.group === group && group.phase === 'installing';
    }

    const lease: PropertyHandlerLease = {
      kind: 'properties',
      finish: group.finish,
      cancel: group.cancel,
      previousFinish: Reflect.get(animation, 'onfinish'),
      previousCancel: Reflect.get(animation, 'oncancel'),
      finishWritten: true,
      cancelWritten: false,
    };
    group.handlers = lease;
    if (!Reflect.set(animation, 'onfinish', lease.finish)) return false;
    if (
      group.owner.group !== group || group.phase !== 'installing' ||
      Reflect.get(animation, 'onfinish') !== lease.finish
    ) return false;
    lease.cancelWritten = true;
    if (!Reflect.set(animation, 'oncancel', lease.cancel)) return false;
    return group.owner.group === group && group.phase === 'installing' &&
      Reflect.get(animation, 'oncancel') === lease.cancel;
  } catch {
    return false;
  }
}

function pumpHandlers(owner: HandleOwner): void {
  if (owner.installing !== undefined) return;
  while (owner.group !== undefined && owner.group.phase === 'installing') {
    const group = owner.group;
    owner.installing = group;
    const installed = installHandlers(group);
    if (installed && owner.group === group && group.phase === 'installing') {
      group.phase = 'live';
      for (const ticket of group.tickets) {
        if (isCurrent(ticket)) ticket.phase = 'active';
      }
      owner.installing = undefined;
      return;
    }
    if (owner.group === group && group.phase === 'installing') {
      finishGroup(group, 'failure');
    }
    releaseHandlers(group, true);
    group.animation = undefined;
    owner.installing = undefined;
  }
}

type BindResult = 'bound' | 'rejected' | 'settled';

function bindExit(transaction: ExitTransaction, animation: AnimationLike): BindResult {
  if (!isCurrent(transaction, 'binding')) return 'settled';
  const owner = getHandleOwner(animation);
  if (owner.cancelling !== undefined) return 'rejected';

  let group = owner.group;
  const install = group === undefined;
  if (group === undefined) {
    const generation = {};
    owner.generation = generation;
    let created!: ExitGroup;
    created = {
      generation,
      phase: 'installing',
      animation,
      owner,
      tickets: new Set(),
      finish: () => finishGroup(created, 'finish'),
      cancel: () => finishGroup(created, 'cancel'),
      handlers: undefined,
    };
    group = created;
    owner.group = group;
  }

  transaction.group = group;
  group.tickets.add(transaction);
  transaction.phase = group.phase === 'live' ? 'active' : 'binding';
  if (install) pumpHandlers(owner);
  if (!isCurrent(transaction)) return 'settled';
  return transaction.group === owner.group &&
    (transaction.phase === 'active' || transaction.phase === 'binding')
    ? 'bound'
    : 'rejected';
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
    terminalExit(transaction, 'failure');
  }

  if (lease !== undefined) restoreExitStyle(lease);
  if (
    appended && transaction.outcome !== 'revival' && transaction.outcome !== 'transfer'
  ) removeExitNode(parent, node);
  if (animation !== undefined && !bound) {
    const token = captureCancelToken(animation);
    if (token !== undefined) cancelIfUnclaimed(token);
  }
  finalizeFromContinuation(transaction, owner, node, transaction.generation);
}

function observeOwnership(
  transaction: ExitTransaction,
  node: AutoChild,
  parent: AutoParent,
): HostResult<DomOwnership> {
  return callHost(transaction, 'reading', () => inspectOwnership(node, parent));
}

function writeStyleField(
  transaction: ExitTransaction,
  target: Record<string, string>,
  name: StyleName,
  value: string,
): boolean {
  const previous = callHost(transaction, 'reading', () => readStyle(target, name));
  if (!previous.ok || !isCurrent(transaction, 'reading')) return false;
  const field: StyleFieldLease = {
    generation: transaction.generation,
    target,
    name,
    previous: previous.value,
    owned: undefined,
  };
  let map: Map<StyleName, StyleFieldLease>;
  try {
    map = styleOwnerMap(target);
    if (map.has(name)) return false;
    map.set(name, field);
  } catch {
    return false;
  }
  transaction.style?.fields.push(field);

  const requested: StyleState = { present: true, value, priority: '' };
  const written = callHost(transaction, 'styling', () => writeStyle(target, name, requested));
  // CSSOM сериализует дроби по-разному в каждом движке; owned — только
  // фактический post-write snapshot, а не отправленная строка.
  const captured = isCurrent(transaction)
    ? callHost(transaction, 'styling', () => readStyle(target, name))
    : (() => {
        try { return { ok: true, value: readStyle(target, name) } as const; }
        catch { return { ok: false } as const; }
      })();
  if (captured.ok) field.owned = captured.value;
  else if (map.get(name) === field) map.delete(name);
  if (written.ok && captured.ok && isCurrent(transaction, 'styling')) return true;
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
  if (!initialOwnership.ok || !isCurrent(transaction, 'reading')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  if (initialOwnership.value !== 'detached') {
    terminalExit(
      transaction,
      initialOwnership.value === 'parent' ? 'revival' : 'transfer',
    );
    return;
  }

  const animateResult = callHost(transaction, 'reading', () => node.animate);
  if (!animateResult.ok || !isCurrent(transaction, 'reading')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  const animate = animateResult.value;
  if (typeof animate !== 'function') {
    terminalExit(transaction, 'failure');
    return;
  }

  const styleResult = callHost(transaction, 'reading', () => node.style);
  if (!styleResult.ok || !isCurrent(transaction, 'reading')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  const target = styleResult.value;
  const clientLeft = callHost(transaction, 'reading', () => parent.clientLeft ?? 0);
  const clientTop = callHost(transaction, 'reading', () => parent.clientTop ?? 0);
  if (
    !clientLeft.ok ||
    !clientTop.ok ||
    !isCurrent(transaction, 'reading')
  ) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }

  lease = { fields: [] };
  transaction.style = lease;
  for (const [name, value] of [
    ['position', 'absolute'],
    ['left', `${num(rect.x - parentRect.x - clientLeft.value)}px`],
    ['top', `${num(rect.y - parentRect.y - clientTop.value)}px`],
  ] as const) {
    if (!writeStyleField(transaction, target, name, value)) {
      rollbackExit(transaction, owner, node, parent, lease, animation, appended);
      return;
    }
  }

  const beforeAppend = observeOwnership(transaction, node, parent);
  if (!beforeAppend.ok || !isCurrent(transaction, 'reading')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  if (beforeAppend.value !== 'detached') {
    terminalExit(transaction, beforeAppend.value === 'parent' ? 'revival' : 'transfer');
    return;
  }

  transaction.phase = 'appending';
  owner.echo.set(node, transaction.generation);
  transaction.ghost = true;
  appended = true;
  const appendResult = callHost(transaction, 'appending', () => parent.appendChild(node));
  if (!appendResult.ok || !isCurrent(transaction, 'appending')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }

  const afterAppend = observeOwnership(transaction, node, parent);
  if (!afterAppend.ok || !isCurrent(transaction, 'reading')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  if (afterAppend.value !== 'parent') {
    terminalExit(transaction, afterAppend.value === 'foreign' ? 'transfer' : 'failure');
    return;
  }

  const animationResult = callHost(transaction, 'animating', () =>
    Reflect.apply(animate, node, [exitKeyframes(), timing]) as AnimationLike,
  );
  if (!animationResult.ok) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  animation = animationResult.value;
  if (!isCurrent(transaction, 'animating')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }

  transaction.phase = 'binding';
  let bound: BindResult;
  try {
    bound = bindExit(transaction, animation);
  } catch {
    bound = 'rejected';
  }
  if (bound === 'bound') return;
  if (bound === 'rejected') {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  finalizeFromContinuation(transaction, owner, node, transaction.generation);
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
    terminalExit(transaction, 'disconnect');
  }
  owner.current.clear();
  owner.echo.clear();
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

function snapshot(owner: ExitOwner): [AutoChild, FlipRect][] {
  const parent = owner.parent;
  if (parent === undefined) return [];
  const entries: [AutoChild, FlipRect][] = [];
  for (const child of Array.from(parent.children)) {
    if (!exitNodes.has(child) && !owner.settling.has(child)) {
      entries.push([child, child.getBoundingClientRect()]);
    }
  }
  return entries;
}

function processRecords(owner: ExitOwner, records: readonly unknown[]): void {
  if (owner.phase !== 'connected') return;
  reconcileRecords(owner, records);
  const parent = owner.parent;
  const previous = owner.cache;
  if (owner.phase !== 'connected' || parent === undefined || previous === undefined) return;

  const current = snapshot(owner);
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
      for (const [transaction] of reservations) terminalExit(transaction, 'failure');
    }
  }
  if (parentRect !== undefined) {
    for (const [transaction, rect] of reservations) {
      if (owner.phase !== 'connected') break;
      startExit(transaction, rect, parentRect, owner.timing);
    }
  }

  if (owner.phase !== 'connected') return;
  for (const node of plan.enters) {
    animateIsolated(node, enterKeyframes(), owner.timing);
    if (owner.phase !== 'connected') return;
  }
  if (!owner.reduce) {
    for (const [node, { first, last }] of plan.moves) {
      animateIsolated(node, moveKeyframes(first, last), owner.timing);
      if (owner.phase !== 'connected') return;
    }
  }
}

function observerCallback(owner: ExitOwner): (records: unknown[]) => void {
  return (records) => processRecords(owner, records);
}

function closeOwner(owner: ExitOwner): void {
  if (owner.phase !== 'connected') return;
  owner.phase = 'disconnecting';
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
      owner.cache = undefined;
      owner.parent = undefined;
      owner.observer = undefined;
      owner.phase = 'disconnected';
    }
  }
}

function controlsFor(owner: ExitOwner): AutoAnimateControls {
  return {
    enable(): void {
      if (owner.phase !== 'connected') return;
      owner.disabled = false;
      owner.cache = snapshot(owner);
    },
    disable(): void {
      if (owner.phase === 'connected') owner.disabled = true;
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
  const duration = options.duration ?? 0.25;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MotionParamError('LM002');
  }
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  checkEpsilon(epsilon);

  const easing = options.easing === undefined ? 'ease-in-out' : easingToLinear(options.easing);
  const timing = { duration: duration * 1000, easing, fill: 'both' as const };

  const Ctor =
    options.MutationObserverCtor ??
    (typeof MutationObserver !== 'undefined'
      ? (MutationObserver as unknown as NonNullable<AutoAnimateOptions['MutationObserverCtor']>)
      : undefined);
  if (Ctor === undefined) {
    return { enable() {}, disable() {}, disconnect() {} };
  }

  // Канон: статичный родитель получает position:relative — иначе absolute
  // exit-узлы позиционируются мимо него.
  const getPosition =
    options.getComputedPosition ??
    ((el: AutoParent): string =>
      typeof getComputedStyle !== 'undefined'
        ? (getComputedStyle(el as never) as { position: string }).position
        : '');
  if (getPosition(parent) === 'static') {
    parent.style['position'] = 'relative';
  }

  /** Session — единственный strong owner parent/observer/cache до disconnect. */
  const owner: ExitOwner = {
    phase: 'connected',
    parent,
    observer: undefined,
    cache: undefined,
    disabled: false,
    epsilon,
    reduce: resolveReduce(options),
    timing,
    current: new Map(),
    echo: new Map(),
    settling: new WeakMap(),
  };
  owner.cache = snapshot(owner);
  const observer = new Ctor(observerCallback(owner));
  owner.observer = observer;
  observer.observe(parent, { childList: true });
  return controlsFor(owner);
}
