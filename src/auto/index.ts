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
  /** Владение onfinish exit-анимации — у адаптера (физическое удаление узла). */
  onfinish: (() => void) | null;
  cancel?(): void;
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
type ExitDisposition = 'none' | 'preserve' | 'remove';
type GroupPhase = 'installing' | 'live' | 'retired';

interface ExitOwner {
  phase: OwnerPhase;
  readonly current: Map<AutoChild, ExitTransaction>;
  readonly echo: Map<AutoChild, object>;
  readonly settling: WeakMap<AutoChild, object>;
}

interface StyleFieldLease {
  readonly previous: string;
  readonly owned: string;
}

interface ExitStyleLease {
  readonly target: Record<string, string>;
  readonly position: StyleFieldLease;
  readonly left: StyleFieldLease;
  readonly top: StyleFieldLease;
}

interface ExitTransaction {
  readonly generation: object;
  phase: ExitPhase;
  disposition: ExitDisposition;
  inFlight: number;
  owner: ExitOwner | undefined;
  node: AutoChild | undefined;
  parent: AutoParent | undefined;
  style: ExitStyleLease | undefined;
  group: ExitGroup | undefined;
}

interface HandleOwner {
  generation: object;
  group: ExitGroup | undefined;
  cancelling: object | undefined;
}

interface ExitGroup {
  readonly generation: object;
  phase: GroupPhase;
  animation: AnimationLike | undefined;
  readonly owner: HandleOwner;
  readonly tickets: Set<ExitTransaction>;
  readonly finish: () => void;
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
  cancel: CancelToken | undefined;
}

/** Один host-handle хранит монотонную identity поколений во всех адаптерах. */
const exitHandles = new WeakMap<AnimationLike, HandleOwner>();

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
    current.generation === transaction.generation &&
    (phase === undefined || transaction.phase === phase)
  );
}

function reserveExit(owner: ExitOwner, node: AutoChild, parent: AutoParent): ExitTransaction | undefined {
  if (
    owner.phase !== 'connected' ||
    owner.current.has(node) ||
    owner.settling.has(node)
  ) return undefined;
  const transaction: ExitTransaction = {
    generation: {},
    phase: 'reserved',
    disposition: 'none',
    inFlight: 0,
    owner,
    node,
    parent,
    style: undefined,
    group: undefined,
  };
  owner.current.set(node, transaction);
  return transaction;
}

function restoreStyleField(
  target: Record<string, string>,
  key: 'position' | 'left' | 'top',
  lease: StyleFieldLease,
): void {
  try {
    if (target[key] === lease.owned) target[key] = lease.previous;
  } catch { /* каждое поле имеет независимую compare-and-restore lease */ }
}

function restoreExitStyle(style: ExitStyleLease): void {
  restoreStyleField(style.target, 'position', style.position);
  restoreStyleField(style.target, 'left', style.left);
  restoreStyleField(style.target, 'top', style.top);
}

function getHandleOwner(animation: AnimationLike): HandleOwner {
  let owner = exitHandles.get(animation);
  if (owner === undefined) {
    owner = { generation: {}, group: undefined, cancelling: undefined };
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
  if (
    group.phase === 'retired' ||
    animation === undefined ||
    group.owner.group !== group ||
    group.owner.generation !== group.generation
  ) return undefined;
  group.owner.group = undefined;
  group.phase = 'retired';
  group.animation = undefined;
  return { animation, owner: group.owner, generation: group.generation };
}

function settleExit(
  transaction: ExitTransaction,
  disposition: Exclude<ExitDisposition, 'none'>,
): ExitCleanup | undefined {
  const owner = transaction.owner;
  const node = transaction.node;
  const parent = transaction.parent;
  if (owner === undefined || node === undefined || parent === undefined) return undefined;

  if (
    owner.current.get(node) === transaction &&
    transaction.generation === owner.current.get(node)?.generation
  ) {
    owner.current.delete(node);
    if (owner.echo.get(node) === transaction.generation) owner.echo.delete(node);
    owner.settling.set(node, transaction.generation);
  }

  const group = transaction.group;
  group?.tickets.delete(transaction);
  const style = transaction.style;
  transaction.phase = 'settling';
  transaction.disposition = disposition;
  transaction.owner = undefined;
  transaction.node = undefined;
  transaction.parent = undefined;
  transaction.style = undefined;
  transaction.group = undefined;

  const cancel = group !== undefined && group.tickets.size === 0
    ? deactivateGroup(group)
    : undefined;
  return {
    transaction,
    owner,
    node,
    parent,
    generation: transaction.generation,
    style,
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

function removeExitNode(parent: AutoParent, node: AutoChild): void {
  try {
    if (!Array.from(parent.children).includes(node)) return;
  } catch { /* hostile children getter: removeChild остаётся oracle среды */ }
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

function applyCleanup(cleanup: ExitCleanup, remove: boolean): void {
  if (cleanup.style !== undefined) restoreExitStyle(cleanup.style);
  if (remove) removeExitNode(cleanup.parent, cleanup.node);
  if (cleanup.cancel !== undefined) cancelIfUnclaimed(cleanup.cancel);
  finalizeSettlement(cleanup);
}

function finishGroup(group: ExitGroup, cancel: boolean): void {
  const token = deactivateGroup(group);
  if (token === undefined) return;
  const cleanups: ExitCleanup[] = [];
  for (const transaction of Array.from(group.tickets)) {
    const cleanup = settleExit(transaction, 'remove');
    if (cleanup !== undefined) cleanups.push(cleanup);
  }
  group.tickets.clear();
  for (const cleanup of cleanups) applyCleanup(cleanup, true);
  if (cancel) cancelIfUnclaimed(token);
}

function reconcileAdded(owner: ExitOwner, records: readonly unknown[]): void {
  for (const record of records) {
    const added = (record as { addedNodes?: ArrayLike<AutoChild> }).addedNodes;
    if (added === undefined) continue;
    for (const node of Array.from(added)) {
      const echoGeneration = owner.echo.get(node);
      if (echoGeneration !== undefined) {
        owner.echo.delete(node);
        continue;
      }
      const transaction = owner.current.get(node);
      if (transaction === undefined) continue;
      const cleanup = settleExit(transaction, 'preserve');
      if (cleanup !== undefined) applyCleanup(cleanup, false);
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
      finish: () => finishGroup(created, false),
    };
    group = created;
    owner.group = group;
  }

  transaction.group = group;
  group.tickets.add(transaction);
  if (!install) {
    transaction.phase = group.phase === 'live' ? 'active' : 'binding';
    return isCurrent(transaction, transaction.phase) ? 'bound' : 'settled';
  }

  const installed = callHost(transaction, 'binding', () => {
    animation.onfinish = group.finish;
  });
  const stillOwner = owner.group === group && owner.generation === group.generation;
  if (!installed.ok) {
    if (stillOwner) finishGroup(group, true);
    return 'settled';
  }
  if (!stillOwner) return 'settled';

  group.phase = 'live';
  for (const ticket of group.tickets) {
    if (isCurrent(ticket)) ticket.phase = 'active';
  }
  return isCurrent(transaction, 'active') ? 'bound' : 'settled';
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
  const current = owner.current.get(node) === transaction;
  if (current) {
    const cleanup = settleExit(transaction, 'remove');
    if (cleanup !== undefined) {
      if (cleanup.cancel === undefined && animation !== undefined) {
        cleanup.cancel = captureCancelToken(animation);
      }
      applyCleanup(cleanup, appended);
      return;
    }
  }

  if (lease !== undefined) restoreExitStyle(lease);
  if (appended && transaction.disposition !== 'preserve') removeExitNode(parent, node);
  if (animation !== undefined) {
    const token = captureCancelToken(animation);
    if (token !== undefined) cancelIfUnclaimed(token);
  }
  finalizeFromContinuation(transaction, owner, node, transaction.generation);
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

  const animateResult = callHost(transaction, 'reading', () => node.animate);
  if (!animateResult.ok || !isCurrent(transaction, 'reading')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  const animate = animateResult.value;
  if (typeof animate !== 'function') {
    const cleanup = settleExit(transaction, 'remove');
    if (cleanup !== undefined) applyCleanup(cleanup, false);
    return;
  }

  const styleResult = callHost(transaction, 'reading', () => node.style);
  if (!styleResult.ok || !isCurrent(transaction, 'reading')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }
  const target = styleResult.value;
  const previousPosition = callHost(transaction, 'reading', () => target['position'] ?? '');
  const previousLeft = callHost(transaction, 'reading', () => target['left'] ?? '');
  const previousTop = callHost(transaction, 'reading', () => target['top'] ?? '');
  const clientLeft = callHost(transaction, 'reading', () => parent.clientLeft ?? 0);
  const clientTop = callHost(transaction, 'reading', () => parent.clientTop ?? 0);
  if (
    !previousPosition.ok ||
    !previousLeft.ok ||
    !previousTop.ok ||
    !clientLeft.ok ||
    !clientTop.ok ||
    !isCurrent(transaction, 'reading')
  ) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
    return;
  }

  lease = {
    target,
    position: { previous: previousPosition.value, owned: 'absolute' },
    left: {
      previous: previousLeft.value,
      owned: `${num(rect.x - parentRect.x - clientLeft.value)}px`,
    },
    top: {
      previous: previousTop.value,
      owned: `${num(rect.y - parentRect.y - clientTop.value)}px`,
    },
  };
  transaction.style = lease;

  for (const [key, field] of [
    ['position', lease.position],
    ['left', lease.left],
    ['top', lease.top],
  ] as const) {
    const written = callHost(transaction, 'styling', () => {
      target[key] = field.owned;
    });
    if (!written.ok || !isCurrent(transaction, 'styling')) {
      rollbackExit(transaction, owner, node, parent, lease, animation, appended);
      return;
    }
  }

  transaction.phase = 'appending';
  owner.echo.set(node, transaction.generation);
  appended = true;
  const appendResult = callHost(transaction, 'appending', () => parent.appendChild(node));
  if (!appendResult.ok || !isCurrent(transaction, 'appending')) {
    rollbackExit(transaction, owner, node, parent, lease, animation, appended);
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
  const cleanups: ExitCleanup[] = [];
  for (const transaction of Array.from(owner.current.values())) {
    const cleanup = settleExit(transaction, 'remove');
    if (cleanup !== undefined) cleanups.push(cleanup);
  }
  owner.current.clear();
  owner.echo.clear();
  for (const cleanup of cleanups) applyCleanup(cleanup, true);
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

  const reduce = resolveReduce(options);

  let disabled = false;
  /** Один owner публикует reservation, echo и settling-tombstone каждого exit. */
  const owner: ExitOwner = {
    phase: 'connected',
    current: new Map(),
    echo: new Map(),
    settling: new WeakMap(),
  };

  const snapshot = (): [AutoChild, FlipRect][] => {
    const entries: [AutoChild, FlipRect][] = [];
    for (const child of Array.from(parent.children)) {
      if (!owner.current.has(child) && !owner.settling.has(child)) {
        entries.push([child, child.getBoundingClientRect()]);
      }
    }
    return entries;
  };

  let cache = snapshot();

  const onRecords = (records: readonly unknown[]): void => {
    if (owner.phase !== 'connected') return;
    // Пре-пасс реинкарнаций: узел в addedNodes, доигрывающий exit, — либо эхо
    // нашего же re-append (потребляется один раз), либо потребитель вернул
    // узел до terminal → transaction завершается как preserve.
    reconcileAdded(owner, records);
    if (owner.phase !== 'connected') return;

    const previous = cache;
    const current = snapshot();
    cache = current; // DOM-факт коммитится до любого host effect.
    if (disabled) {
      return;
    }
    const plan = planAuto(previous, current, epsilon);

    // Все exits резервируются одним чистым pre-pass: host первого узла уже
    // видит identity остальных и не может исполнить их stale-план реентрантно.
    const reservations: Array<readonly [ExitTransaction, FlipRect]> = [];
    for (const [node, rect] of plan.exits) {
      const transaction = reserveExit(owner, node, parent);
      if (transaction !== undefined) reservations.push([transaction, rect]);
    }

    // Уходящие: реинсерт absolute на прежнем месте, exit, удаление на onfinish.
    // left/top отсчитываются от padding-box родителя — border вычитается
    // через clientLeft/clientTop (иначе узел уезжает вглубь на его ширину).
    let parentRect: FlipRect | undefined;
    if (reservations.length > 0) {
      try {
        parentRect = parent.getBoundingClientRect();
      } catch {
        for (const [transaction] of reservations) {
          const cleanup = settleExit(transaction, 'remove');
          if (cleanup !== undefined) applyCleanup(cleanup, false);
        }
      }
    }
    if (parentRect !== undefined) {
      for (const [transaction, rect] of reservations) {
        if (owner.phase !== 'connected') break;
        startExit(transaction, rect, parentRect, timing);
      }
    }

    if (owner.phase !== 'connected') return;

    for (const node of plan.enters) {
      animateIsolated(node, enterKeyframes(), timing);
      if (owner.phase !== 'connected') return;
    }

    // Reduced-motion: движение снапает — позиция уже новая, кадров нет.
    if (!reduce) {
      for (const [node, { first, last }] of plan.moves) {
        animateIsolated(node, moveKeyframes(first, last), timing);
        if (owner.phase !== 'connected') return;
      }
    }
  };

  const observer = new Ctor(onRecords);
  observer.observe(parent, { childList: true });

  return {
    enable(): void {
      if (owner.phase !== 'connected') return;
      disabled = false;
      cache = snapshot();
    },
    disable(): void {
      if (owner.phase !== 'connected') return;
      disabled = true;
    },
    disconnect(): void {
      if (owner.phase !== 'connected') return;
      owner.phase = 'disconnecting';
      let pending: readonly unknown[] = [];
      try {
        pending = observer.takeRecords?.() ?? [];
      } catch { /* custom seam без доступной очереди */ }
      try {
        observer.disconnect();
      } catch { /* cleanup ниже остаётся обязательным */ }
      // После disconnect запускается только revival pre-pass, без нового plan.
      reconcileAdded(owner, pending);
      owner.phase = 'disconnected';
      disconnectExits(owner);
    },
  };
}
