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

type ExitGroup = [
  animation: AnimationLike | undefined,
  tickets: Set<ExitTicket>,
  finish: () => void,
];

type ExitOwner = readonly [
  registry: Map<AutoChild, ExitTicket>,
  echo: Set<AutoChild>,
];

type ExitStyle = readonly [
  target: Record<string, string>,
  position: string,
  left: string,
  top: string,
];

type ExitTicket = [
  group: ExitGroup | undefined,
  node: AutoChild | undefined,
  parent: AutoParent | undefined,
  owner: ExitOwner | undefined,
  style: ExitStyle | undefined,
];

/** Один host-handle имеет ровно одного terminal-владельца во всех адаптерах. */
const exitGroups = new WeakMap<AnimationLike, ExitGroup>();

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

/** Возвращает независимые inline-значения даже при частично hostile style. */
function restoreExitStyle(style: ExitStyle): void {
  try { style[0]['position'] = style[1]; } catch { /* следующий ключ независим */ }
  try { style[0]['left'] = style[2]; } catch { /* следующий ключ независим */ }
  try { style[0]['top'] = style[3]; } catch { /* terminal всё равно продолжится */ }
}

/** Снимает ticket со всех владельцев до любого реентрантного host-вызова. */
function releaseExit(ticket: ExitTicket): AnimationLike | undefined {
  const group = ticket[0];
  const node = ticket[1];
  const owner = ticket[3];
  group?.[1].delete(ticket);
  if (node !== undefined && owner?.[0].get(node) === ticket) {
    owner[0].delete(node);
    owner[1].delete(node);
  }
  ticket[0] = undefined;
  ticket[1] = undefined;
  ticket[2] = undefined;
  ticket[3] = undefined;
  ticket[4] = undefined;
  if (group === undefined || group[1].size > 0) return undefined;

  const animation = group[0];
  if (animation !== undefined && exitGroups.get(animation) === group) {
    exitGroups.delete(animation);
  }
  group[0] = undefined;
  group[1].clear();
  return animation;
}

function finishExit(ticket: ExitTicket): void {
  const node = ticket[1];
  const parent = ticket[2];
  const owner = ticket[3];
  const style = ticket[4];
  if (node === undefined || parent === undefined || owner?.[0].get(node) !== ticket) {
    releaseExit(ticket);
    return;
  }
  releaseExit(ticket);
  if (style !== undefined) restoreExitStyle(style);
  parent.removeChild(node);
}

/** Все tickets одного host-handle завершаются одним terminal-сигналом. */
function finishGroup(group: ExitGroup): AnimationLike | undefined {
  const animation = group[0];
  if (animation === undefined || exitGroups.get(animation) !== group) return undefined;
  exitGroups.delete(animation);
  group[0] = undefined;
  for (const ticket of group[1]) {
    try {
      finishExit(ticket);
    } catch { /* ошибка одного host-remove не блокирует остальных владельцев */ }
  }
  group[1].clear();
  return animation;
}

function cancelExit(ticket: ExitTicket): void {
  const style = ticket[4];
  const animation = releaseExit(ticket);
  if (style !== undefined) restoreExitStyle(style);
  try {
    animation?.cancel?.();
  } catch { /* вызов среды больше не владеет DOM-ссылками */ }
}

function registerExit(
  animation: AnimationLike,
  node: AutoChild,
  parent: AutoParent,
  owner: ExitOwner,
  style: ExitStyle,
): void {
  let group = exitGroups.get(animation);
  const install = group === undefined;
  if (group === undefined) {
    let created!: ExitGroup;
    created = [animation, new Set(), () => { finishGroup(created); }];
    group = created;
    exitGroups.set(animation, group);
  }

  const ticket: ExitTicket = [group, node, parent, owner, style];
  group[1].add(ticket);
  owner[0].set(node, ticket);
  if (!install) return;

  try {
    animation.onfinish = group[2];
  } catch {
    // Setter и все синхронно присоединившиеся tickets — одна транзакция:
    // без принятого terminal callback ни один re-append не остаётся ghost.
    const terminalAnimation = finishGroup(group);
    try {
      terminalAnimation?.cancel?.();
    } catch { /* group уже не владеет host/DOM-ссылками */ }
  }
}

/** Disconnect освобождает все tickets до восстановления DOM через host. */
function disconnectExits(owner: ExitOwner): void {
  const cleanups: Array<readonly [AutoChild, AutoParent, ExitStyle | undefined]> = [];
  const animations = new Set<AnimationLike>();
  for (const ticket of Array.from(owner[0].values())) {
    const node = ticket[1];
    const parent = ticket[2];
    const style = ticket[4];
    const animation = releaseExit(ticket);
    if (node !== undefined && parent !== undefined) cleanups.push([node, parent, style]);
    if (animation !== undefined) animations.add(animation);
  }
  owner[0].clear();
  owner[1].clear();

  for (const [node, parent, style] of cleanups) {
    if (style !== undefined) restoreExitStyle(style);
    try {
      parent.removeChild(node);
    } catch { /* host уже мог удалить ghost */ }
  }
  for (const animation of animations) {
    try {
      animation.cancel?.();
    } catch { /* terminal ownership уже освобождено */ }
  }
}

interface MutationObserverLike {
  observe(target: unknown, options: object): void;
  disconnect(): void;
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
  let disconnected = false;
  /** Реестр живых exit и эхо их re-append имеют одного явного владельца. */
  const owner: ExitOwner = [new Map(), new Set()];
  const [exiting, selfEcho] = owner;

  const snapshot = (): [AutoChild, FlipRect][] => {
    const entries: [AutoChild, FlipRect][] = [];
    for (const child of Array.from(parent.children)) {
      if (!exiting.has(child)) entries.push([child, child.getBoundingClientRect()]);
    }
    return entries;
  };

  let cache = snapshot();

  const onRecords = (records: readonly unknown[]): void => {
    if (disconnected) return;
    // Пре-пасс реинкарнаций: узел в addedNodes, доигрывающий exit, — либо эхо
    // нашего же re-append (потребляется один раз), либо потребитель вернул
    // узел до onfinish → exit отменяется (onfinish отменённого не сработает),
    // наши инлайны снимаются, дальше узел планируется как обычный enter.
    for (const record of records) {
      const added = (record as { addedNodes?: ArrayLike<AutoChild> }).addedNodes;
      if (added === undefined) continue;
      for (const node of Array.from(added)) {
        if (selfEcho.delete(node)) continue;
        const exit = exiting.get(node);
        if (exit === undefined) continue;
        cancelExit(exit);
      }
    }

    const current = snapshot();
    if (disabled) {
      cache = current;
      return;
    }
    const plan = planAuto(cache, current, epsilon);

    // Уходящие: реинсерт absolute на прежнем месте, exit, удаление на onfinish.
    // left/top отсчитываются от padding-box родителя — border вычитается
    // через clientLeft/clientTop (иначе узел уезжает вглубь на его ширину).
    const parentRect = parent.getBoundingClientRect();
    for (const [node, rect] of plan.exits) {
      let style: ExitStyle | undefined;
      try {
        const animate = node.animate;
        if (typeof animate !== 'function') continue;
        const target = node.style;
        style = [
          target,
          target['position'] ?? '',
          target['left'] ?? '',
          target['top'] ?? '',
        ];
        target['position'] = 'absolute';
        target['left'] = `${num(rect.x - parentRect.x - (parent.clientLeft ?? 0))}px`;
        target['top'] = `${num(rect.y - parentRect.y - (parent.clientTop ?? 0))}px`;
        selfEcho.add(node);
        parent.appendChild(node);
        const animation = Reflect.apply(animate, node, [exitKeyframes(), timing]) as AnimationLike;
        registerExit(animation, node, parent, owner, style);
      } catch {
        // Частично успешная подготовка откатывается локально: соседние exits
        // той же observer-транзакции продолжают устанавливаться независимо.
        selfEcho.delete(node);
        if (style !== undefined) restoreExitStyle(style);
        try {
          parent.removeChild(node);
        } catch { /* среда уже могла удалить узел или не принять re-append */ }
      }
    }

    for (const node of plan.enters) {
      if (typeof node.animate === 'function') node.animate(enterKeyframes(), timing);
    }

    // Reduced-motion: движение снапает — позиция уже новая, кадров нет.
    if (!reduce) {
      for (const [node, { first, last }] of plan.moves) {
        if (typeof node.animate === 'function') node.animate(moveKeyframes(first, last), timing);
      }
    }

    cache = current;
  };

  const observer = new Ctor(onRecords);
  observer.observe(parent, { childList: true });

  return {
    enable(): void {
      if (disconnected) return;
      disabled = false;
      cache = snapshot();
    },
    disable(): void {
      if (disconnected) return;
      disabled = true;
    },
    disconnect(): void {
      if (disconnected) return;
      disconnected = true;
      try {
        observer.disconnect();
      } catch { /* cleanup ниже остаётся обязательным */ }
      disconnectExits(owner);
    },
  };
}
