/**
 * projection/dom.ts — тонкий DOM-адаптер вложенного FLIP (subpath ./projection).
 *
 * Единственный файл субпутя, знающий про DOM — и то duck-typed и В МОМЕНТ вызова
 * (P2/SSR-safe: импорт не трогает globalThis; node-тесты на tree-shaped фейках).
 *
 * Граница переизмерения (спека §4.0, ключевой фикс класса «замер под transform»:
 * getBoundingClientRect возвращает бокс ПОСЛЕ transform): play() — синхронный JS,
 * paint между шагами не случается:
 *   (а) batch-CLEAR — снять наши инлайны (восстановить сохранённые) у узлов
 *       активного полёта одним проходом ЗАПИСЕЙ;
 *   (б) batch-MEASURE — все getBoundingClientRect + радиусы вторым проходом
 *       ЧТЕНИЙ (один принудительный reflow — неизбежная цена FLIP-границы);
 *   (в) построить дерево (composed-подъём) и стартовать полёт.
 * first-концы при этом НЕ меряются: capture() mid-flight берёт аналитический
 * V(p̂) через controls.boxAt (§4.2) — ноль DOM-чтений под нашим transform.
 *
 * Дерево: ближайший проецирующий предок ищется composed-подъёмом
 * assignedSlot → parentElement → getRootNode().host (границы ОТКРЫТЫХ shadow
 * root прозрачны; closed — невидимы, документировано).
 *
 * Риски (спека §10): getComputedStyle 8×N — синхронный style recalc (смягчение:
 * шорт-чек border-radius, radius:false, батч чтений до первой записи); чужой
 * inline/CSS-transform на треканном узле — gBCR вернёт визуальный бокс, математика
 * примет его за layout → искажение (matrix-декомпозиция — не-цель v1).
 */

import { MotionParamError } from '../errors.js';
import type { FlipRect } from '../flip/index.js';
import type { RequestFrameFn } from '../motion-value.js';
import type { SpringParams } from '../spring.js';
import { createProjection, type ProjectionPlayNode } from './driver.js';
import { finite, type BoxRadii, type CornerRadius, type ProjectionFrame } from './geometry.js';

// ─── Публичные типы ──────────────────────────────────────────────────────────

/** Duck-typed минимум (node-тесты на фейках). */
export interface DomProjectionElement {
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  readonly style: {
    setProperty(n: string, v: string): void;
    removeProperty(n: string): void;
    getPropertyValue(n: string): string;
  };
  readonly parentElement?: DomProjectionElement | null | undefined;
  readonly assignedSlot?: DomProjectionElement | null | undefined;
  /** Для подъёма через границу shadow root: getRootNode().host. */
  getRootNode?(): { readonly host?: DomProjectionElement | null | undefined } | null;
}

export interface DomProjectionOptions {
  readonly spring?: SpringParams | undefined;
  readonly clamp?: boolean | undefined; // default false
  readonly requestFrame?: RequestFrameFn | undefined; // default: globalThis.requestAnimationFrame в момент вызова
  readonly matchMedia?: ((q: string) => { matches: boolean }) | undefined;
  /** Снимать радиусы (8 longhand-компонент на узел). Default true. */
  readonly radius?: boolean | undefined;
  /** Page-space шов. Default: defaultView/globalThis scrollX/scrollY под try/catch → {0,0}. */
  readonly getScroll?: (() => { x: number; y: number }) | undefined;
  /** Шов чтения computed-радиусов. Default: globalThis.getComputedStyle в момент вызова. */
  readonly getComputedStyle?:
    | ((el: DomProjectionElement) => { getPropertyValue(n: string): string })
    | undefined;
}

export interface DomProjectionControls {
  /** FIRST-замер набора элементов (page-space + радиусы + прежние инлайны).
   *  Mid-flight: узлы активного полёта → аналитический V(p̂), БЕЗ замера под transform. */
  capture(elements: readonly DomProjectionElement[]): void;
  /** LAST-замер (граница §4.0: batch clear→measure→start), дерево по composed-предкам,
   *  запись style на кадре. play без capture → MotionParamError
   *  `projection.play: call capture(elements) before mutating the DOM`. */
  play(): void;
  /** Снимает наши инлайны (снап в layout), полёт глушится. Без onRest-аналога. */
  cancel(): void;
  readonly playing: boolean;
}

// ─── Швы по умолчанию (DOM резолвится в момент вызова) ───────────────────────

function defaultGetScroll(): { x: number; y: number } {
  try {
    const g = globalThis as { scrollX?: unknown; scrollY?: unknown };
    const x = typeof g.scrollX === 'number' && Number.isFinite(g.scrollX) ? g.scrollX : 0;
    const y = typeof g.scrollY === 'number' && Number.isFinite(g.scrollY) ? g.scrollY : 0;
    return { x, y };
  } catch {
    return { x: 0, y: 0 };
  }
}

type ComputedStyleFn = (el: DomProjectionElement) => { getPropertyValue(n: string): string };

// ─── Парсинг радиусов (спека §3.5: computed longhand'ы, % → px на замере) ────

const RADIUS_LONGHANDS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

/** 'Xpx' | 'X%' → px против базы (% — семантика CSS: x-полуось от width, y — от height). */
function parseRadiusToken(token: string, base: number): number | null {
  if (token.endsWith('px')) {
    const n = Number(token.slice(0, -2));
    return Number.isFinite(n) ? n : null;
  }
  if (token.endsWith('%')) {
    const n = Number(token.slice(0, -1));
    return Number.isFinite(n) ? (n * base) / 100 : null;
  }
  return null; // calc()/var()/иные юниты → честная тихая деградация (радиусы undefined)
}

function readRadii(
  el: DomProjectionElement,
  width: number,
  height: number,
  getCS: ComputedStyleFn,
): BoxRadii | undefined {
  try {
    const cs = getCS(el);
    // Шорт-чек: border-radius пуст/'0px' → узел без радиусов (ноль работы в полёте).
    const shorthand = cs.getPropertyValue('border-radius');
    if (shorthand === '' || shorthand === '0px') return undefined;
    const corners: CornerRadius[] = [];
    for (const prop of RADIUS_LONGHANDS) {
      const raw = cs.getPropertyValue(prop).trim();
      if (raw === '') return undefined;
      const parts = raw.split(/\s+/);
      if (parts.length < 1 || parts.length > 2) return undefined;
      const x = parseRadiusToken(parts[0], width);
      const y = parseRadiusToken(parts.length === 2 ? parts[1] : parts[0], height);
      if (x === null || y === null) return undefined;
      corners.push({ x, y });
    }
    return corners as unknown as BoxRadii;
  } catch {
    return undefined; // враждебное состояние DOM — никогда не бросает
  }
}

/** Аналитические first-радиусы mid-flight: визуальный радиус СЕЙЧАС = lerp(rF, rL, p̂). */
function lerpRadii(a: BoxRadii, b: BoxRadii, t: number): BoxRadii {
  const corners: CornerRadius[] = [];
  for (let c = 0; c < 4; c++) {
    corners.push({
      x: finite(a[c].x + (b[c].x - a[c].x) * t) + 0,
      y: finite(a[c].y + (b[c].y - a[c].y) * t) + 0,
    });
  }
  return corners as unknown as BoxRadii;
}

// ─── Адаптер ─────────────────────────────────────────────────────────────────

interface CapturedEntry {
  readonly el: DomProjectionElement;
  readonly id: string;
  readonly first: FlipRect;
  readonly radiiFirst: BoxRadii | undefined;
  readonly savedTransform: string;
  readonly savedOrigin: string;
  readonly savedRadius: string;
}

interface FlightEntry {
  readonly el: DomProjectionElement;
  readonly savedTransform: string;
  readonly savedOrigin: string;
  readonly savedRadius: string;
  readonly radiiFirst: BoxRadii | undefined;
  readonly radiiLast: BoxRadii | undefined;
}

function restoreProp(
  style: DomProjectionElement['style'],
  name: string,
  saved: string,
): void {
  if (saved === '') style.removeProperty(name);
  else style.setProperty(name, saved);
}

function safeInline(el: DomProjectionElement, name: string): string {
  try {
    return el.style.getPropertyValue(name);
  } catch {
    return '';
  }
}

/** Потолок composed-подъёма — страж от враждебных циклических «деревьев». */
const MAX_ANCESTOR_HOPS = 4096;

function composedParent(el: DomProjectionElement): DomProjectionElement | null {
  const slot = el.assignedSlot;
  if (slot !== null && slot !== undefined && slot !== el) return slot;
  const parent = el.parentElement;
  if (parent !== null && parent !== undefined) return parent;
  if (typeof el.getRootNode === 'function') {
    try {
      const host = el.getRootNode()?.host;
      if (host !== null && host !== undefined && host !== el) return host;
    } catch {
      return null;
    }
  }
  return null;
}

/** Создать DOM-контроллер проекции: capture → (мутация потребителя) → play. */
export function createDomProjection(options?: DomProjectionOptions): DomProjectionControls {
  const radius = options?.radius !== false;
  const getScroll = options?.getScroll ?? defaultGetScroll;
  // rAF резолвится в момент вызова фабрики (SSR-safe импорт); нет rAF в среде →
  // undefined → драйвер завершает полёт синхронно (канон flip :251-256).
  const requestFrame =
    options?.requestFrame ??
    (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ===
    'function'
      ? (cb: (ts?: number) => void): number =>
          (
            globalThis as unknown as {
              requestAnimationFrame: (cb: (ts?: number) => void) => number;
            }
          ).requestAnimationFrame(cb)
      : undefined);

  const resolveComputedStyle = (): ComputedStyleFn | undefined => {
    if (options?.getComputedStyle !== undefined) return options.getComputedStyle;
    const g = globalThis as { getComputedStyle?: unknown };
    if (typeof g.getComputedStyle !== 'function') return undefined;
    const fn = g.getComputedStyle as (el: unknown) => { getPropertyValue(n: string): string };
    return (el) => fn(el);
  };

  /** Стабильные id элементов (переживают повторные capture — ключ continuity драйвера). */
  const ids = new WeakMap<DomProjectionElement, string>();
  let nextId = 0;
  const idOf = (el: DomProjectionElement): string => {
    let id = ids.get(el);
    if (id === undefined) {
      id = `n${nextId++}`;
      ids.set(el, id);
    }
    return id;
  };

  let captured: Map<DomProjectionElement, CapturedEntry> | null = null;
  let flightEls: Map<string, FlightEntry> | null = null;

  const writeFrames = (frames: readonly ProjectionFrame[]): void => {
    if (flightEls === null) return;
    for (const frame of frames) {
      const entry = flightEls.get(frame.id);
      if (entry === undefined) continue;
      const style = entry.el.style;
      if (frame.degenerate) {
        // Вырожденный anchor: transform не применять — вернуть прежний инлайн.
        restoreProp(style, 'transform', entry.savedTransform);
      } else {
        style.setProperty(
          'transform',
          `translate(${frame.tx}px, ${frame.ty}px) scale(${frame.sx}, ${frame.sy})`,
        );
      }
      const radii = frame.radii;
      if (radii !== undefined) {
        style.setProperty(
          'border-radius',
          `${radii[0].x}px ${radii[1].x}px ${radii[2].x}px ${radii[3].x}px / ` +
            `${radii[0].y}px ${radii[1].y}px ${radii[2].y}px ${radii[3].y}px`,
        );
      }
    }
  };

  /** Restore сохранённых инлайнов + очистка состояния полёта (rest и cancel). */
  const restoreAll = (): void => {
    if (flightEls === null) return;
    for (const entry of flightEls.values()) {
      restoreProp(entry.el.style, 'transform', entry.savedTransform);
      restoreProp(entry.el.style, 'transform-origin', entry.savedOrigin);
      restoreProp(entry.el.style, 'border-radius', entry.savedRadius);
    }
    flightEls = null;
  };

  const controls = createProjection({
    spring: options?.spring,
    clamp: options?.clamp,
    requestFrame,
    matchMedia: options?.matchMedia,
    onFrame: writeFrames,
    onRest: restoreAll,
  });

  return {
    capture(elements: readonly DomProjectionElement[]): void {
      const scroll = getScrollSafe(getScroll);
      const getCS = radius ? resolveComputedStyle() : undefined;
      const map = new Map<DomProjectionElement, CapturedEntry>();

      for (const el of elements) {
        if (el === null || el === undefined || typeof el.getBoundingClientRect !== 'function') {
          continue; // враждебный вход — тихая деградация, не бросок
        }
        const id = idOf(el);
        const flightEntry = controls.playing ? flightEls?.get(id) : undefined;

        let first: FlipRect | undefined;
        let radiiFirst: BoxRadii | undefined;
        let savedTransform: string;
        let savedOrigin: string;
        let savedRadius: string;

        if (flightEntry !== undefined) {
          // §4.2: узел активного полёта — аналитический V(p̂), DOM под нашим
          // transform НЕ меряется; прежние инлайны — из состояния полёта.
          first = controls.boxAt(id);
          radiiFirst =
            flightEntry.radiiFirst !== undefined && flightEntry.radiiLast !== undefined
              ? lerpRadii(flightEntry.radiiFirst, flightEntry.radiiLast, controls.progress)
              : undefined;
          savedTransform = flightEntry.savedTransform;
          savedOrigin = flightEntry.savedOrigin;
          savedRadius = flightEntry.savedRadius;
        } else {
          savedTransform = safeInline(el, 'transform');
          savedOrigin = safeInline(el, 'transform-origin');
          savedRadius = safeInline(el, 'border-radius');
        }

        if (first === undefined) {
          let rect: { x: number; y: number; width: number; height: number };
          try {
            rect = el.getBoundingClientRect();
          } catch {
            continue; // исчезнувший/враждебный узел — никогда не бросает
          }
          first = {
            x: rect.x + scroll.x,
            y: rect.y + scroll.y,
            width: rect.width,
            height: rect.height,
          };
          if (getCS !== undefined) radiiFirst = readRadii(el, rect.width, rect.height, getCS);
        }

        map.set(el, { el, id, first, radiiFirst, savedTransform, savedOrigin, savedRadius });
      }
      captured = map;
    },

    play(): void {
      if (captured === null) {
        throw new MotionParamError('projection.play: call capture(elements) before mutating the DOM');
      }

      // (а) batch-CLEAR: наши инлайны узлов активного полёта — одним проходом записей
      // (восстановление инлайнов = замер ниже видит чистый layout и чистые радиусы).
      if (flightEls !== null) {
        for (const entry of flightEls.values()) {
          restoreProp(entry.el.style, 'transform', entry.savedTransform);
          restoreProp(entry.el.style, 'transform-origin', entry.savedOrigin);
          restoreProp(entry.el.style, 'border-radius', entry.savedRadius);
        }
      }

      // (б) batch-MEASURE: только чтения (один принудительный reflow).
      const scroll = getScrollSafe(getScroll);
      const getCS = radius ? resolveComputedStyle() : undefined;
      interface Measured {
        readonly cap: CapturedEntry;
        readonly last: FlipRect;
        readonly radiiLast: BoxRadii | undefined;
      }
      const measured: Measured[] = [];
      const measuredIds = new Set<string>();
      for (const cap of captured.values()) {
        let rect: { x: number; y: number; width: number; height: number };
        try {
          rect = cap.el.getBoundingClientRect();
        } catch {
          continue; // узел исчез между capture и play — тихая деградация
        }
        const last: FlipRect = {
          x: rect.x + scroll.x,
          y: rect.y + scroll.y,
          width: rect.width,
          height: rect.height,
        };
        const radiiLast =
          getCS !== undefined ? readRadii(cap.el, rect.width, rect.height, getCS) : undefined;
        measured.push({ cap, last, radiiLast });
        measuredIds.add(cap.id);
      }

      // (в) дерево по composed-предкам + старт полёта.
      const byEl = captured;
      const findAncestorId = (el: DomProjectionElement): string | null => {
        let cursor = composedParent(el);
        let hops = 0;
        while (cursor !== null && hops < MAX_ANCESTOR_HOPS) {
          const entry = byEl.get(cursor);
          if (entry !== undefined && measuredIds.has(entry.id)) return entry.id;
          cursor = composedParent(cursor);
          hops++;
        }
        return null;
      };

      const nodes: ProjectionPlayNode[] = measured.map((m) => ({
        id: m.cap.id,
        parent: findAncestorId(m.cap.el),
        first: m.cap.first,
        last: m.last,
        radii:
          m.cap.radiiFirst !== undefined && m.radiiLast !== undefined
            ? { first: m.cap.radiiFirst, last: m.radiiLast }
            : undefined,
      }));

      // Новый writer-таргет ДО старта (первый кадр драйвера — синхронный).
      const newFlight = new Map<string, FlightEntry>();
      for (const m of measured) {
        newFlight.set(m.cap.id, {
          el: m.cap.el,
          savedTransform: m.cap.savedTransform,
          savedOrigin: m.cap.savedOrigin,
          savedRadius: m.cap.savedRadius,
          radiiFirst: m.cap.radiiFirst,
          radiiLast: m.radiiLast,
        });
      }
      flightEls = newFlight;

      // Записи ПОСЛЕ всех чтений: transform-origin '0 0' — жёсткий контракт формул (P5).
      for (const m of measured) {
        m.cap.el.style.setProperty('transform-origin', '0 0');
      }

      controls.play(nodes);
    },

    cancel(): void {
      controls.cancel();
      restoreAll(); // снап в конечный layout; идемпотентен (flightEls → null)
    },

    get playing(): boolean {
      return controls.playing;
    },
  };
}

function getScrollSafe(getScroll: () => { x: number; y: number }): { x: number; y: number } {
  try {
    const s = getScroll();
    return {
      x: typeof s.x === 'number' && Number.isFinite(s.x) ? s.x : 0,
      y: typeof s.y === 'number' && Number.isFinite(s.y) ? s.y : 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}
