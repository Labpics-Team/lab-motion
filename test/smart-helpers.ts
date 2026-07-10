/**
 * test/smart-helpers.ts — общие фикстуры тестов субпутя ./smart.
 *
 * НЕ тест-файл (не собирается vitest'ом как сьют): tree-shaped duck-фейки с
 * keyed-атрибутами/shadowRoot/isConnected — расширение конвенции
 * test/projection-helpers.ts (та же журнальная модель мира: сквозной seq
 * записей и замеров = доказательство границы batch clear→measure→start);
 * шаг-часы и seeded-LCG переиспользуются из projection-helpers (реэкспорт).
 * jsdom НЕ используется, node-env.
 *
 * RED-канон (test/animate-facade-helpers.ts:9-31): типы публичной поверхности —
 * ЛОКАЛЬНЫЕ копии; тесты обращаются к модулю через namespace-import +
 * pick-хелперы — на заглушке src/smart каждый тест падает СВОИМ ассертом
 * («… is not a function»), а не link-ошибкой: RED for the right reason.
 */

import type { RectLike } from './projection-helpers.js';

export { lcg, makeClock, reduceMedia, type RectLike, type StepClock } from './projection-helpers.js';

// ─── Типы публичной поверхности (локальная копия для RED-фазы, спека §3.1) ───

export type SmartTierLike = 'projection' | 'reduced' | 'ssr';

export interface SmartPlanLike {
  readonly matched: readonly string[];
  readonly entered: readonly string[];
  readonly exited: readonly string[];
  readonly skipped: readonly string[];
}

export interface SmartHandleLike {
  readonly finished: Promise<void>;
  cancel(): void;
  readonly playing: boolean;
  readonly progress: number;
  readonly tier: SmartTierLike;
  readonly plan: SmartPlanLike;
}

export interface SmartCaptureLike {
  animate(): SmartHandleLike;
  readonly size: number;
}

export type CaptureSmartFn = (root: unknown, options?: Record<string, unknown>) => SmartCaptureLike;
export type SmartTransitionFn = (
  root: unknown,
  mutate: () => void | Promise<void>,
  options?: Record<string, unknown>,
) => SmartHandleLike;
export type ResolveSmartTierFn = (inputs?: Record<string, unknown>) => SmartTierLike;

// ─── pick-хелперы (namespace-import → undefined на RED-заглушке) ─────────────

export function pickCaptureSmart(mod: Record<string, unknown>): CaptureSmartFn {
  return mod['captureSmart'] as CaptureSmartFn;
}
export function pickSmartTransition(mod: Record<string, unknown>): SmartTransitionFn {
  return mod['smartTransition'] as SmartTransitionFn;
}
export function pickResolveSmartTier(mod: Record<string, unknown>): ResolveSmartTierFn {
  return mod['resolveSmartTier'] as ResolveSmartTierFn;
}
export function pickSmartKeyAttr(mod: Record<string, unknown>): string {
  return mod['SMART_KEY_ATTR'] as string;
}

// ─── Tree-shaped keyed duck-фейки (спека §3.1 SmartElement/SmartRoot) ─────────

/** Одна операция мира: запись стиля, замер или структурная мутация root'а. */
export interface SmartOp {
  readonly seq: number;
  readonly el: SmartFakeElement;
  readonly kind: 'set' | 'remove' | 'measure' | 'append' | 'removeChild';
  readonly prop?: string;
  readonly value?: string;
  /** kind='measure': inline transform элемента В МОМЕНТ замера (граница §4.0). */
  readonly inlineTransform?: string;
}

export interface SmartFakeElement {
  readonly name: string;
  /** Rect-модель: page-space layout-бокс (мутируется тестом = «мутация DOM»). */
  rect: RectLike;
  /** Атрибуты (data-motion-key и произвольные). */
  readonly attrs: Map<string, string>;
  children: SmartFakeElement[];
  shadowRoot: { children: SmartFakeElement[] } | null;
  isConnected: boolean;
  /** computed-style данные (радиусы, position) для getComputedStyle-шва. */
  readonly computed: Record<string, string>;
  readonly style: {
    setProperty(n: string, v: string): void;
    removeProperty(n: string): void;
    getPropertyValue(n: string): string;
  };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): RectLike;
  /** Текущие инлайн-стили (для проверок restore). */
  readonly inline: Map<string, string>;
}

export interface SmartFakeRoot extends SmartFakeElement {
  clientLeft: number;
  clientTop: number;
  appendChild(n: unknown): unknown;
  removeChild(n: unknown): unknown;
}

export interface SmartWorld {
  /** Сквозной журнал операций всех элементов (порядок = доказательство границы). */
  readonly ops: SmartOp[];
  scroll: { x: number; y: number };
  getScroll(): { x: number; y: number };
  getComputedStyle(el: unknown): { getPropertyValue(n: string): string };
  el(
    name: string,
    rect: RectLike,
    init?: {
      key?: string;
      children?: SmartFakeElement[];
      shadowChildren?: SmartFakeElement[];
      inline?: Record<string, string>;
      computed?: Record<string, string>;
      connected?: boolean;
    },
  ): SmartFakeElement;
  root(
    name: string,
    rect: RectLike,
    init?: {
      children?: SmartFakeElement[];
      clientLeft?: number;
      clientTop?: number;
      computed?: Record<string, string>;
    },
  ): SmartFakeRoot;
  /** Все записи (set/remove) элемента, опционально по одному свойству. */
  writes(el: SmartFakeElement, prop?: string): SmartOp[];
  /** Все замеры элемента. */
  measures(el: SmartFakeElement): SmartOp[];
  /** Числовые значения записей свойства (последняя запись — хвост). */
  values(el: SmartFakeElement, prop: string): string[];
}

export function makeSmartWorld(): SmartWorld {
  const ops: SmartOp[] = [];
  let seq = 0;

  const makeEl = (
    name: string,
    rect: RectLike,
    init?: Parameters<SmartWorld['el']>[2],
  ): SmartFakeElement => {
    const inline = new Map<string, string>(Object.entries(init?.inline ?? {}));
    const attrs = new Map<string, string>();
    if (init?.key !== undefined) attrs.set('data-motion-key', init.key);
    const computed: Record<string, string> = { 'border-radius': '0px', ...init?.computed };
    const fake: SmartFakeElement = {
      name,
      rect: { ...rect },
      attrs,
      children: init?.children ?? [],
      shadowRoot: init?.shadowChildren !== undefined ? { children: init.shadowChildren } : null,
      isConnected: init?.connected ?? true,
      computed,
      inline,
      style: {
        setProperty(n: string, v: string): void {
          ops.push({ seq: seq++, el: fake, kind: 'set', prop: n, value: v });
          inline.set(n, v);
        },
        removeProperty(n: string): void {
          ops.push({ seq: seq++, el: fake, kind: 'remove', prop: n });
          inline.delete(n);
        },
        getPropertyValue(n: string): string {
          return inline.get(n) ?? '';
        },
      },
      getAttribute(n: string): string | null {
        return attrs.get(n) ?? null;
      },
      getBoundingClientRect(): RectLike {
        ops.push({
          seq: seq++,
          el: fake,
          kind: 'measure',
          inlineTransform: inline.get('transform') ?? '',
        });
        return {
          x: fake.rect.x - world.scroll.x,
          y: fake.rect.y - world.scroll.y,
          width: fake.rect.width,
          height: fake.rect.height,
        };
      },
    };
    return fake;
  };

  const world: SmartWorld = {
    ops,
    scroll: { x: 0, y: 0 },
    getScroll() {
      return { x: world.scroll.x, y: world.scroll.y };
    },
    getComputedStyle(el: unknown) {
      const fe = el as SmartFakeElement;
      return {
        getPropertyValue(n: string): string {
          return fe.computed[n] ?? '';
        },
      };
    },
    el: makeEl,
    root(name, rect, init) {
      const base = makeEl(name, rect, { children: init?.children, computed: init?.computed });
      const root = base as SmartFakeRoot;
      root.clientLeft = init?.clientLeft ?? 0;
      root.clientTop = init?.clientTop ?? 0;
      root.appendChild = (n: unknown): unknown => {
        const child = n as SmartFakeElement;
        ops.push({ seq: seq++, el: child, kind: 'append' });
        if (!root.children.includes(child)) root.children.push(child);
        child.isConnected = true;
        return n;
      };
      root.removeChild = (n: unknown): unknown => {
        const child = n as SmartFakeElement;
        ops.push({ seq: seq++, el: child, kind: 'removeChild' });
        const i = root.children.indexOf(child);
        if (i >= 0) root.children.splice(i, 1);
        child.isConnected = false;
        return n;
      };
      return root;
    },
    writes(el, prop) {
      return ops.filter(
        (o) =>
          o.el === el &&
          (o.kind === 'set' || o.kind === 'remove') &&
          (prop === undefined || o.prop === prop),
      );
    },
    measures(el) {
      return ops.filter((o) => o.el === el && o.kind === 'measure');
    },
    values(el, prop) {
      return ops
        .filter((o) => o.el === el && o.kind === 'set' && o.prop === prop)
        .map((o) => o.value ?? '');
    },
  };
  return world;
}

/** Убрать ребёнка из родителя «мутацией потребителя» (isConnected → false). */
export function detach(parent: SmartFakeElement, child: SmartFakeElement): void {
  const i = parent.children.indexOf(child);
  if (i >= 0) parent.children.splice(i, 1);
  child.isConnected = false;
}

/** Вставить ребёнка «мутацией потребителя». */
export function attach(parent: SmartFakeElement, child: SmartFakeElement): void {
  if (!parent.children.includes(child)) parent.children.push(child);
  child.isConnected = true;
}
