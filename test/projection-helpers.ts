/**
 * test/projection-helpers.ts — общие фикстуры тестов субпутя ./projection.
 *
 * НЕ тест-файл (не собирается vitest'ом как сьют): tree-shaped duck-фейки,
 * детерминированные шаг-часы и seeded-LCG — конвенции пакета
 * (канон плоских фейков: test/animate-facade-helpers.ts:41-58; tree-shaped
 * расширение — прецедентное решение спеки §7 «Новая фикстура»; seeded fuzz —
 * test/decay-finiteness-fuzz.test.ts; jsdom НЕ используется, node-env).
 *
 * RED-канон (test/animate-facade-helpers.ts:9-31): типы публичной поверхности —
 * ЛОКАЛЬНЫЕ копии; тесты обращаются к модулю через namespace-import +
 * pick-хелперы — на заглушке src/projection каждый тест падал бы СВОИМ ассертом
 * («… is not a function»), а не link-ошибкой: RED for the right reason.
 */

// ─── Типы публичной поверхности (локальная копия для RED-фазы, спека §2.2) ───

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CornerRadiusLike {
  readonly x: number;
  readonly y: number;
}

export type BoxRadiiLike = readonly [
  CornerRadiusLike,
  CornerRadiusLike,
  CornerRadiusLike,
  CornerRadiusLike,
];

export interface ProjectionBoxesLike {
  readonly first: RectLike;
  readonly last: RectLike;
  readonly anchor?: RectLike | undefined;
}

export interface ProjectedTransformLike {
  readonly tx: number;
  readonly ty: number;
  readonly sx: number;
  readonly sy: number;
}

export interface ProjectionFrameLike {
  readonly id: string;
  readonly tx: number;
  readonly ty: number;
  readonly sx: number;
  readonly sy: number;
  readonly kx: number;
  readonly ky: number;
  readonly radii?: BoxRadiiLike | undefined;
  readonly opacity?: number | undefined;
  readonly degenerate: boolean;
}

export interface ProjectionNodeInitLike {
  readonly id: string;
  readonly parent?: string | null | undefined;
  readonly first: RectLike;
  readonly last: RectLike;
  readonly anchor?: RectLike | undefined;
  readonly radii?: { readonly first: BoxRadiiLike; readonly last: BoxRadiiLike } | undefined;
  readonly opacity?: { readonly from: number; readonly to: number } | undefined;
}

/** Узел play(): first опционален для id живого полёта (visual pickup, §2.2). */
export type ProjectionPlayNodeLike = Omit<ProjectionNodeInitLike, 'first'> & {
  readonly first?: RectLike | undefined;
};

export interface ProjectorLike {
  at(p: number): readonly ProjectionFrameLike[];
  readonly order: readonly string[];
}

export interface ProjectionControlsLike {
  play(nodes: readonly ProjectionPlayNodeLike[]): void;
  cancel(): void;
  seek(p: number): void;
  release(velocity?: number): void;
  boxAt(id: string): RectLike | undefined;
  readonly playing: boolean;
  readonly progress: number;
  readonly velocity: number;
}

export interface DomProjectionControlsLike {
  capture(elements: readonly unknown[]): void;
  play(): void;
  cancel(): void;
  readonly playing: boolean;
}

export type MixBoxFn = (first: RectLike, last: RectLike, p: number) => RectLike;
export type ProjectAtFn = (
  node: ProjectionBoxesLike,
  ancestor: ProjectionBoxesLike | null,
  p: number,
) => ProjectedTransformLike;
export type CornerRadiusAtFn = (
  first: CornerRadiusLike,
  last: CornerRadiusLike,
  kx: number,
  ky: number,
  p: number,
) => CornerRadiusLike;
export type CreateProjectorFn = (nodes: readonly ProjectionNodeInitLike[]) => ProjectorLike;
export type CreateProjectionFn = (options?: Record<string, unknown>) => ProjectionControlsLike;
export type CreateDomProjectionFn = (
  options?: Record<string, unknown>,
) => DomProjectionControlsLike;

// ─── pick-хелперы (namespace-import → undefined на RED-заглушке) ─────────────

export function pickMixBox(mod: Record<string, unknown>): MixBoxFn {
  return mod['mixBox'] as MixBoxFn;
}
export function pickProjectAt(mod: Record<string, unknown>): ProjectAtFn {
  return mod['projectAt'] as ProjectAtFn;
}
export function pickCornerRadiusAt(mod: Record<string, unknown>): CornerRadiusAtFn {
  return mod['cornerRadiusAt'] as CornerRadiusAtFn;
}
export function pickCreateProjector(mod: Record<string, unknown>): CreateProjectorFn {
  return mod['createProjector'] as CreateProjectorFn;
}
export function pickCreateProjection(mod: Record<string, unknown>): CreateProjectionFn {
  return mod['createProjection'] as CreateProjectionFn;
}
export function pickCreateDomProjection(mod: Record<string, unknown>): CreateDomProjectionFn {
  return mod['createDomProjection'] as CreateDomProjectionFn;
}

// ─── Детерминированные шаг-часы (draining requestFrame, handle ≠ 0) ──────────

export interface StepClock {
  /** Инжектируемый requestFrame (handle ≠ 0 → без setTimeout-шима). */
  requestFrame(cb: (ts?: number) => void): number;
  /** Продвинуть время на dtMs и выполнить все накопленные колбэки с новым ts. */
  step(dtMs: number): void;
  /** step, пока очередь не опустеет (или maxSteps). Возвращает число шагов. */
  drain(dtMs?: number, maxSteps?: number): number;
  /** Число запланированных rAF-заявок за всё время (reduce-пины). */
  rafCalls(): number;
  /** Заявок сейчас в очереди. */
  pending(): number;
  readonly now: number;
}

export function makeClock(startTs = 0): StepClock {
  let ts = startTs;
  let queue: Array<(t?: number) => void> = [];
  let handle = 0;
  let calls = 0;
  return {
    requestFrame(cb: (t?: number) => void): number {
      queue.push(cb);
      calls++;
      return ++handle;
    },
    step(dtMs: number): void {
      ts += dtMs;
      const batch = queue;
      queue = [];
      for (const cb of batch) cb(ts);
    },
    drain(dtMs = 16, maxSteps = 5000): number {
      let steps = 0;
      while (queue.length > 0 && steps < maxSteps) {
        this.step(dtMs);
        steps++;
      }
      return steps;
    },
    rafCalls(): number {
      return calls;
    },
    pending(): number {
      return queue.length;
    },
    get now(): number {
      return ts;
    },
  };
}

// ─── Seeded PRNG (Park-Miller LCG — конвенция fuzz-тестов пакета) ────────────

export function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

// ─── matchMedia-шов reduced-motion ────────────────────────────────────────────

export function reduceMedia(matches = true): (q: string) => { matches: boolean } {
  return () => ({ matches });
}

// ─── Tree-shaped duck-фейки (спека §7 «Новая фикстура», §2.2 DomProjectionElement)

/** Одна операция мира: запись стиля или замер (общий журнал — порядок сквозной). */
export interface WorldOp {
  readonly seq: number;
  readonly el: FakeElement;
  readonly kind: 'set' | 'remove' | 'measure';
  readonly prop?: string;
  readonly value?: string;
  /** kind='measure': inline transform элемента В МОМЕНТ замера (граница §4.0). */
  readonly inlineTransform?: string;
}

export interface FakeElement {
  readonly name: string;
  /** Rect-модель: page-space layout-бокс (мутируется тестом = «перестановка DOM»). */
  rect: RectLike;
  parentElement: FakeElement | null;
  assignedSlot: FakeElement | null;
  /** Хост shadow-root'а для composed-подъёма (getRootNode().host). */
  host: FakeElement | null;
  /** computed-style данные (радиусы) для getComputedStyle-шва. */
  readonly computed: Record<string, string>;
  readonly style: {
    setProperty(n: string, v: string): void;
    removeProperty(n: string): void;
    getPropertyValue(n: string): string;
  };
  getBoundingClientRect(): RectLike;
  getRootNode(): { readonly host: FakeElement | null };
  /** Текущие инлайн-стили (для проверок restore). */
  readonly inline: Map<string, string>;
}

export interface FakeWorld {
  /** Сквозной журнал операций всех элементов (порядок = доказательство границы 4.0). */
  readonly ops: WorldOp[];
  /** Скролл окна: gBCR фейка отдаёт rect − scroll (viewport), page-шов прибавляет. */
  scroll: { x: number; y: number };
  getScroll(): { x: number; y: number };
  getComputedStyle(el: unknown): { getPropertyValue(n: string): string };
  el(
    name: string,
    rect: RectLike,
    init?: {
      parent?: FakeElement | null;
      slot?: FakeElement | null;
      host?: FakeElement | null;
      inline?: Record<string, string>;
      computed?: Record<string, string>;
    },
  ): FakeElement;
  /** Все замеры элемента. */
  measures(el: FakeElement): WorldOp[];
  /** Все записи (set/remove) элемента, опционально по одному свойству. */
  writes(el: FakeElement, prop?: string): WorldOp[];
}

export function makeWorld(): FakeWorld {
  const ops: WorldOp[] = [];
  let seq = 0;
  const world: FakeWorld = {
    ops,
    scroll: { x: 0, y: 0 },
    getScroll() {
      return { x: world.scroll.x, y: world.scroll.y };
    },
    getComputedStyle(el: unknown) {
      const fe = el as FakeElement;
      return {
        getPropertyValue(n: string): string {
          return fe.computed[n] ?? '';
        },
      };
    },
    el(name, rect, init) {
      const inline = new Map<string, string>(Object.entries(init?.inline ?? {}));
      const computed: Record<string, string> = { 'border-radius': '0px', ...init?.computed };
      const fake: FakeElement = {
        name,
        rect: { ...rect },
        parentElement: init?.parent ?? null,
        assignedSlot: init?.slot ?? null,
        host: init?.host ?? null,
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
        getRootNode() {
          return { host: fake.host };
        },
      };
      return fake;
    },
    measures(el) {
      return ops.filter((o) => o.el === el && o.kind === 'measure');
    },
    writes(el, prop) {
      return ops.filter(
        (o) => o.el === el && o.kind !== 'measure' && (prop === undefined || o.prop === prop),
      );
    },
  };
  return world;
}

// ─── Разбор записанных значений ──────────────────────────────────────────────

/** Парсит writer-формат спеки §2.4: `translate(txpx, typx) scale(sx, sy)`. */
export function parseTranslateScale(value: string): {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
} | null {
  const m =
    /translate\(\s*(-?[\d.eE+-]+)px\s*,\s*(-?[\d.eE+-]+)px\s*\)\s*scale\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)/.exec(
      value,
    );
  if (!m) return null;
  return { tx: Number(m[1]), ty: Number(m[2]), sx: Number(m[3]), sy: Number(m[4]) };
}

