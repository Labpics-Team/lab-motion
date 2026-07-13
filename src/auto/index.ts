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
  /** Узлы, доигрывающие exit (и их анимации): вне планирования до удаления. */
  const exiting = new Map<AutoChild, AnimationLike>();
  /** Эхо наших собственных re-append'ов: observer увидит их как addedNodes. */
  const selfEcho = new Set<AutoChild>();

  const snapshot = (): [AutoChild, FlipRect][] => {
    const entries: [AutoChild, FlipRect][] = [];
    for (const child of Array.from(parent.children)) {
      if (!exiting.has(child)) entries.push([child, child.getBoundingClientRect()]);
    }
    return entries;
  };

  let cache = snapshot();

  const onRecords = (records: readonly unknown[]): void => {
    // Пре-пасс реинкарнаций: узел в addedNodes, доигрывающий exit, — либо эхо
    // нашего же re-append (потребляется один раз), либо потребитель вернул
    // узел до onfinish → exit отменяется (onfinish отменённого не сработает),
    // наши инлайны снимаются, дальше узел планируется как обычный enter.
    for (const record of records) {
      const added = (record as { addedNodes?: ArrayLike<AutoChild> }).addedNodes;
      if (added === undefined) continue;
      for (const node of Array.from(added)) {
        const exitAnim = exiting.get(node);
        if (exitAnim === undefined) continue;
        if (selfEcho.has(node)) {
          selfEcho.delete(node);
          continue;
        }
        exitAnim.onfinish = null;
        exitAnim.cancel?.();
        exiting.delete(node);
        node.style['position'] = '';
        node.style['left'] = '';
        node.style['top'] = '';
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
      if (typeof node.animate !== 'function') continue;
      node.style['position'] = 'absolute';
      node.style['left'] = `${num(rect.x - parentRect.x - (parent.clientLeft ?? 0))}px`;
      node.style['top'] = `${num(rect.y - parentRect.y - (parent.clientTop ?? 0))}px`;
      selfEcho.add(node);
      parent.appendChild(node);
      const anim = node.animate(exitKeyframes(), timing);
      exiting.set(node, anim);
      anim.onfinish = (): void => {
        exiting.delete(node);
        parent.removeChild(node);
      };
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
      disabled = false;
      cache = snapshot();
    },
    disable(): void {
      disabled = true;
    },
    disconnect(): void {
      observer.disconnect();
    },
  };
}
