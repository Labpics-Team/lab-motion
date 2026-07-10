/**
 * smart/index.ts — Figma-подобный smart-animate поверх ./projection (subpath ./smart).
 *
 * Subpath export: import { captureSmart, smartTransition } from '@labpics/motion/smart'
 *
 * ЗАЧЕМ: ./projection даёт честный вложенный FLIP набора элементов, но требует от
 * потребителя вручную собрать этот набор и знать «что во что превратилось». ./smart
 * закрывает ровно этот разрыв: ДВА снимка дерева по строковому identity-ключу
 * (data-motion-key), диф → matched / entered / exited / skipped, и оркестрация
 * поверх ОДНОГО projection-движка:
 *   - matched → FLIP через createProjection (id узла = строка-ключ ⇒ continuity
 *     переживает ПЕРЕСОЗДАНИЕ DOM-узла: перехват повторным capture/animate берёт
 *     аналитический V(p̂) и пересеивает скорость — C¹ у драйвера, здесь только
 *     бухгалтерия «в какой элемент писать кадр»);
 *   - entered → fade-in (opacity 0→1, БЕЗ transform);
 *   - exited → ghost-протокол (реинсерт в root absolute на padding-box, фейд 1→0,
 *     removeChild ДО резолва finished — терминальное действие раньше уведомлений);
 *   - единый clock/пружина на весь переход (дерево едет одним жестом).
 *
 * Карта переиспользования (./projection не тронут ни байтом; ядро не тронуто):
 *   ../projection createProjection — весь FLIP + continuity + C¹ (id = ключ);
 *     ProjectionPlayNode.first === undefined ⇒ visual pickup V(p̂) в драйвере
 *     (ноль DOM-чтений под нашим transform) — механика перехвата и continue-exit.
 *   ../spring validateSpringParams — ранний MotionParamError В ФАБРИКЕ, даже под
 *     reduced-motion (капчур валидирует параметры до любых эффектов).
 *   Паттерны-копии (НЕ импорты — импорт утянул бы чужой граф в копию субпутя при
 *   splitting:false): finite (~4 строки, приватна в projection/geometry);
 *   prefersReducedMotion (projection/driver :205); batch clear→measure→start
 *   (projection/dom :372-405); composed shadow-обход открытых shadow root
 *   (projection/dom :198-212). Reduced-motion резолвится ЗДЕСЬ (character-switch):
 *   matched снапаются (ноль записей), enter/exit-фейды ЖИВЫЕ — драйверу matchMedia
 *   НЕ передаётся (иначе он снапнул бы и фейды).
 *
 * Минимальный скоуп #99 (фаза G): VT-тир вырезан — SmartTier без 'view-transitions'
 * (нативный View Transitions API — отдельная фаза; здесь честный projection-путь
 * + reduced + ssr). Осознанно вне: авто-детект мутаций (MutationObserver),
 * live-подписка на смену reduce в полёте, closed shadow roots, вложенные
 * scroll-контейнеры (только window-scroll page-space — наследуется от projection).
 *
 * Инварианты: P1 CSS-safe (каждое число кадра конечно, −0 схлопнут — держит
 * projection + finite()-стражи координат ghost'а); P2 DOM трогается только в
 * момент вызова (SSR-safe импорт, node-тесты на duck-фейках); P3 детерминизм
 * (время из инжектируемого requestFrame).
 *
 * ─── MUTATION PROOF (ручная проба, 2026-07-10; каждый мутант откачен) ─────────
 * 10 мутантов в РАЗНЫЕ места, каждый кусается (RED на зафиксированной спеке;
 * прогон test/smart-{diff,lifecycle,api-surface-pin}.test.ts = 43 теста, + fuzz):
 *   1. Слом матчинга по id (snapshot.get(key)→undefined ⇒ matched становятся
 *      entered) → 15 RED («пересозданный узел = matched», «перемещение = matched»…).
 *   2. Потеря exited (exit-ветка классификации → skipped) → 5 RED (ghost-протокол,
 *      «exited=[b]», cancel-ghost).
 *   3. Потеря continuity на перехвате (continue-exit узел first: box вместо
 *      undefined ⇒ нет visual pickup) → 1 RED («фейд продолжается без прыжка», 12
 *      знаков).
 *   4. Reduced-leak (убран `if (!reduced)` вокруг matched-узлов ⇒ matched едут
 *      transform-ом под reduce) → 1 RED («matched без transform», writes(a)=0).
 *   5. Слом fail-fast (epsilon-валидация удалена) → 1 RED («epsilon … got NaN»).
 *   6. Слом границы capture (полётные узлы МЕРЯЮТСЯ под transform вместо boxAt) →
 *      1 RED («capture mid-flight не меряет узлы полёта» + C⁰ after[0]).
 *   7. Убран finite()-страж координат ghost'а (_px без _finite) → fuzz 1 RED
 *      («NaNpx» в left/top/width/height при злом ректе).
 *   8. Слом валидации дубликата ключа (throw убран) → 2 RED (buffered-текст обоих
 *      keyAttr) + fuzz negative RED (дубликат ОБЯЗАН бросать).
 *   9. Слом degenerate-классификации (NaN-last не → skipped) → 1 RED («NaN-rect →
 *      skipped», writes(bad)=0).
 *  10. Reduced снапает фейды (matchMedia передан драйверу ⇒ фейды не живые) →
 *      1 RED («enter/exit-фейды ЖИВЫЕ», нет промежуточных opacity ∈ (0,1)).
 */

import { MotionParamError } from '../errors.js';
import { validateSpringParams, type SpringParams } from '../spring.js';
import {
  createProjection,
  type BoxRadii,
  type CornerRadius,
  type ProjectionControls,
  type ProjectionFrame,
  type ProjectionPlayNode,
} from '../projection/index.js';

// ─── Публичная константа ──────────────────────────────────────────────────────

/** DX-константа: атрибут identity-ключа по умолчанию. */
export const SMART_KEY_ATTR = 'data-motion-key';

// ─── Публичные типы (стираются в рантайме — в Object.keys не попадают) ────────

export type SmartTier = 'projection' | 'reduced' | 'ssr';

export interface SmartPlan {
  readonly matched: readonly string[];
  readonly entered: readonly string[];
  readonly exited: readonly string[];
  readonly skipped: readonly string[];
}

export interface SmartHandle {
  readonly finished: Promise<void>;
  cancel(): void;
  readonly playing: boolean;
  readonly progress: number;
  readonly tier: SmartTier;
  readonly plan: SmartPlan;
}

export interface SmartCapture {
  animate(): SmartHandle;
  readonly size: number;
}

/** Duck-typed минимум DOM-элемента (node-тесты на фейках). */
export interface SmartElement {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  readonly style: {
    setProperty(n: string, v: string): void;
    removeProperty(n: string): void;
    getPropertyValue(n: string): string;
  };
  readonly isConnected?: boolean;
}

export interface SmartRoot extends SmartElement {
  appendChild(node: unknown): unknown;
  removeChild(node: unknown): unknown;
  readonly clientLeft?: number;
  readonly clientTop?: number;
}

export interface SmartOptions {
  readonly keyAttr?: string | undefined;
  readonly epsilon?: number | undefined;
  readonly spring?: SpringParams | undefined;
  readonly shadow?: boolean | undefined;
  readonly radius?: boolean | undefined;
  readonly respectReducedMotion?: boolean | undefined;
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  readonly getScroll?: (() => { x: number; y: number }) | undefined;
  readonly getComputedStyle?:
    | ((el: unknown) => { getPropertyValue(n: string): string })
    | undefined;
  readonly clamp?: boolean | undefined;
  /** Только для resolveSmartTier: признак наличия document-подобной среды. */
  readonly documentLike?: unknown;
}

// ─── Внутренние типы ──────────────────────────────────────────────────────────

interface _Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface _StructEntry {
  readonly el: SmartElement;
  readonly key: string;
  readonly parentKey: string | null;
}

interface _SnapEntry {
  readonly el: SmartElement;
  readonly box: _Rect;
  readonly radii: BoxRadii | undefined;
  readonly parentKey: string | null;
}

type _NodeKind = 'matched' | 'enter' | 'exit';

interface _FlightNode {
  el: SmartElement;
  readonly kind: _NodeKind;
  readonly savedTransform: string;
  readonly savedOrigin: string;
  readonly savedRadius: string;
  readonly savedOpacity: string;
  /** exit: этот узел — наш ghost (владение адаптера, removeChild на терминале). */
  readonly isGhost: boolean;
  /** matched-реинкарнация пишет ещё и opacity — восстановить на терминале. */
  readonly hasOpacity: boolean;
  /** exit: зафиксированный page-box ghost'а (last continue-exit). */
  readonly ghostBox?: _Rect | undefined;
}

interface _GhostEntry {
  readonly el: SmartElement;
  readonly box: _Rect;
}

interface _ActiveRun {
  resolve(): void;
  setState(s: 'settled' | 'canceled' | 'superseded'): void;
}

interface _Controller {
  readonly controls: ProjectionControls;
  readonly getScroll: () => { x: number; y: number };
  readonly getCS: ((el: unknown) => { getPropertyValue(n: string): string }) | undefined;
  readonly radius: boolean;
  readonly root: SmartRoot;
  flight: Map<string, _FlightNode>;
  ghosts: Map<string, _GhostEntry>;
  ghostEls: Set<SmartElement>;
  rootPositionAdded: boolean;
  active: _ActiveRun | null;
  cancelActive(): void;
}

// ─── Локальные стражи (копия семантики projection/geometry finite) ───────────

/** NaN→0, ±Inf→±MAX_VALUE (P1). @internal */
function _finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Число → CSS-px со схлопом −0 (P1: '-0px' не эмитится). @internal */
function _px(x: number): string {
  return `${_finite(x) + 0}px`;
}

const _DEGENERATE_EPS = 1e-6;

/** Вырожденный бокс: нефинитен ЛИБО width/height ≤ ε (0×0, display:none). */
function _isDegenerate(b: _Rect): boolean {
  return (
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y) ||
    !Number.isFinite(b.width) ||
    !Number.isFinite(b.height) ||
    b.width <= _DEGENERATE_EPS ||
    b.height <= _DEGENERATE_EPS
  );
}

/** Узел «двигался» — любой канал бокса (или радиус) изменился больше ε. */
function _isMoved(
  a: _Rect,
  b: _Rect,
  ra: BoxRadii | undefined,
  rb: BoxRadii | undefined,
  eps: number,
): boolean {
  if (
    Math.abs(a.x - b.x) > eps ||
    Math.abs(a.y - b.y) > eps ||
    Math.abs(a.width - b.width) > eps ||
    Math.abs(a.height - b.height) > eps
  ) {
    return true;
  }
  if (ra !== undefined && rb !== undefined) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(ra[c].x - rb[c].x) > eps || Math.abs(ra[c].y - rb[c].y) > eps) return true;
    }
  }
  return false;
}

// ─── Радиусы (копия семантики projection/dom readRadii: computed longhand'ы) ──

const _RADIUS_LONGHANDS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

function _parseRadiusToken(token: string, base: number): number | null {
  if (token.endsWith('px')) {
    const n = Number(token.slice(0, -2));
    return Number.isFinite(n) ? n : null;
  }
  if (token.endsWith('%')) {
    const n = Number(token.slice(0, -1));
    return Number.isFinite(n) ? (n * base) / 100 : null;
  }
  return null;
}

function _readRadii(
  getCS: ((el: unknown) => { getPropertyValue(n: string): string }) | undefined,
  el: SmartElement,
  width: number,
  height: number,
): BoxRadii | undefined {
  if (getCS === undefined) return undefined;
  try {
    const cs = getCS(el);
    const shorthand = cs.getPropertyValue('border-radius');
    if (shorthand === '' || shorthand === '0px') return undefined;
    const corners: CornerRadius[] = [];
    for (const prop of _RADIUS_LONGHANDS) {
      const raw = cs.getPropertyValue(prop).trim();
      if (raw === '') return undefined;
      const parts = raw.split(/\s+/);
      if (parts.length < 1 || parts.length > 2) return undefined;
      const x = _parseRadiusToken(parts[0], width);
      const y = _parseRadiusToken(parts.length === 2 ? parts[1] : parts[0], height);
      if (x === null || y === null) return undefined;
      corners.push({ x, y });
    }
    return corners as unknown as BoxRadii;
  } catch {
    return undefined;
  }
}

// ─── DOM-швы (duck-typed, тотальные к враждебному состоянию) ──────────────────

function _isElementLike(root: unknown): root is SmartRoot {
  return (
    root !== null &&
    typeof root === 'object' &&
    typeof (root as { getBoundingClientRect?: unknown }).getBoundingClientRect === 'function'
  );
}

function _childrenOf(node: unknown): SmartElement[] {
  const ch = (node as { children?: unknown }).children;
  if (Array.isArray(ch)) return ch as SmartElement[];
  if (ch && typeof (ch as { length?: unknown }).length === 'number') {
    return Array.from(ch as ArrayLike<SmartElement>);
  }
  return [];
}

function _shadowChildrenOf(node: unknown): SmartElement[] {
  const sr = (node as { shadowRoot?: { children?: unknown } | null }).shadowRoot;
  if (sr === null || sr === undefined) return [];
  const ch = sr.children;
  if (Array.isArray(ch)) return ch as SmartElement[];
  if (ch && typeof (ch as { length?: unknown }).length === 'number') {
    return Array.from(ch as ArrayLike<SmartElement>);
  }
  return [];
}

function _getAttr(el: SmartElement, name: string): string | null {
  try {
    return typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  } catch {
    return null;
  }
}

function _inl(el: SmartElement, name: string): string {
  try {
    return el.style.getPropertyValue(name);
  } catch {
    return '';
  }
}

function _restoreProp(el: SmartElement, name: string, saved: string): void {
  if (saved === '') el.style.removeProperty(name);
  else el.style.setProperty(name, saved);
}

function _scroll(getScroll: () => { x: number; y: number }): { x: number; y: number } {
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

/** Page-space бокс: gBCR + scroll (враждебный gBCR → вырожденный бокс, не бросок). */
function _pageBox(el: SmartElement, scroll: { x: number; y: number }): _Rect {
  let r: { x: number; y: number; width: number; height: number };
  try {
    r = el.getBoundingClientRect();
  } catch {
    return { x: NaN, y: NaN, width: NaN, height: NaN };
  }
  return { x: r.x + scroll.x, y: r.y + scroll.y, width: r.width, height: r.height };
}

// ─── Walker: структура дерева по keyAttr (light DOM + открытые shadow roots) ──

/**
 * Обход root → упорядоченный (document order) список keyed-элементов с nearest
 * keyed-предком. Keyless-обёртки прозрачны; открытый shadowRoot прозрачен при
 * shadow. Известные ghost-элементы (владение адаптера) пропускаются целиком.
 * Дубликат ключа → ранний MotionParamError с буквальным текстом.
 */
function _structure(
  root: SmartRoot,
  keyAttr: string,
  shadow: boolean,
  ghostEls: Set<SmartElement>,
): _StructEntry[] {
  const out: _StructEntry[] = [];
  const seen = new Set<string>();

  const recurse = (node: SmartElement, ancestorKey: string | null): void => {
    const kids = _childrenOf(node);
    const shadowKids = shadow ? _shadowChildrenOf(node) : [];
    for (const child of kids.concat(shadowKids)) {
      if (ghostEls.has(child)) continue; // наш ghost — прозрачен для дифа
      const key = _getAttr(child, keyAttr);
      let nextAncestor = ancestorKey;
      if (key !== null && key !== '') {
        if (seen.has(key)) {
          throw new MotionParamError(`smart: duplicate ${keyAttr}="${key}" under root`);
        }
        seen.add(key);
        out.push({ el: child, key, parentKey: ancestorKey });
        nextAncestor = key;
      }
      recurse(child, nextAncestor);
    }
  };

  recurse(root, null);
  return out;
}

// ─── resolveSmartTier (precedence reduced → projection → ssr) ─────────────────

function _prefersReduced(
  matchMedia: ((q: string) => { matches: boolean }) | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

export function resolveSmartTier(inputs?: Record<string, unknown>): SmartTier {
  const i = inputs ?? {};
  if (_prefersReduced(i['matchMedia'] as never)) return 'reduced';
  if (
    typeof i['requestFrame'] === 'function' ||
    (i['documentLike'] !== undefined && i['documentLike'] !== null)
  ) {
    return 'projection';
  }
  return 'ssr';
}

// ─── Валидация параметров (fail-fast, рано, даже под reduce) ──────────────────

function _validateOptions(opt: SmartOptions): void {
  if (opt.keyAttr !== undefined) {
    if (typeof opt.keyAttr !== 'string' || opt.keyAttr === '') {
      throw new MotionParamError('smart: keyAttr must be a non-empty string');
    }
  }
  if (opt.epsilon !== undefined) {
    if (!Number.isFinite(opt.epsilon) || opt.epsilon < 0) {
      throw new MotionParamError(
        `smart: epsilon must be a finite number >= 0, got ${opt.epsilon}`,
      );
    }
  }
  if (opt.spring !== undefined) {
    validateSpringParams(opt.spring); // MotionParamError В ФАБРИКЕ, даже под reduce
  }
}

// ─── Эффективный tier капчура ────────────────────────────────────────────────

function _effectiveTier(opt: SmartOptions): 'reduced' | 'projection' {
  const reduced = _prefersReduced(opt.matchMedia) && opt.respectReducedMotion !== false;
  return reduced ? 'reduced' : 'projection';
}

// ─── Инертный (SSR) capture/handle ───────────────────────────────────────────

const _EMPTY_PLAN: SmartPlan = { matched: [], entered: [], exited: [], skipped: [] };

function _inertHandle(tier: SmartTier, plan: SmartPlan): SmartHandle {
  return {
    finished: Promise.resolve(),
    cancel(): void {
      /* идемпотентно на инертном */
    },
    get playing(): boolean {
      return false;
    },
    get progress(): number {
      return 1;
    },
    get tier(): SmartTier {
      return tier;
    },
    get plan(): SmartPlan {
      return plan;
    },
  };
}

function _inertCapture(): SmartCapture {
  return {
    animate(): SmartHandle {
      return _inertHandle('ssr', _EMPTY_PLAN);
    },
    size: 0,
  };
}

// ─── Реестр контроллеров (по root; continuity живёт здесь) ────────────────────

const _controllers = new WeakMap<object, _Controller>();

function _getController(root: SmartRoot, opt: SmartOptions): _Controller {
  const existing = _controllers.get(root);
  if (existing !== undefined) return existing;

  const getScroll = opt.getScroll ?? ((): { x: number; y: number } => ({ x: 0, y: 0 }));
  const getCS = opt.getComputedStyle;
  const radius = opt.radius !== false;

  const writeFrames = (frames: readonly ProjectionFrame[]): void => {
    const flight = ctrl.flight;
    for (const frame of frames) {
      const node = flight.get(frame.id);
      if (node === undefined) continue;
      const style = node.el.style;
      if (node.kind === 'matched') {
        if (!frame.degenerate) {
          style.setProperty(
            'transform',
            `translate(${frame.tx}px, ${frame.ty}px) scale(${frame.sx}, ${frame.sy})`,
          );
        }
        const radii = frame.radii;
        if (radii !== undefined) {
          style.setProperty(
            'border-radius',
            `${_px(radii[0].x)} ${_px(radii[1].x)} ${_px(radii[2].x)} ${_px(radii[3].x)} / ` +
              `${_px(radii[0].y)} ${_px(radii[1].y)} ${_px(radii[2].y)} ${_px(radii[3].y)}`,
          );
        }
      }
      // enter/exit-фейды и matched-реинкарнация: opacity — единственный канал ghost'а.
      if (frame.opacity !== undefined) {
        style.setProperty('opacity', String(_finite(frame.opacity) + 0));
      }
    }
  };

  const controls = createProjection({
    spring: opt.spring,
    clamp: opt.clamp,
    requestFrame: opt.requestFrame,
    // matchMedia драйверу НЕ передаётся: reduced-motion резолвит ./smart
    // (matched снап, но фейды ЖИВЫЕ — драйвер снапнул бы и их).
    onFrame: writeFrames,
    onRest: (): void => _onNaturalRest(ctrl),
  });

  const ctrl: _Controller = {
    controls,
    getScroll,
    getCS,
    radius,
    root,
    flight: new Map(),
    ghosts: new Map(),
    ghostEls: new Set(),
    rootPositionAdded: false,
    active: null,
    cancelActive(): void {
      _cancelRun(ctrl);
    },
  };
  _controllers.set(root, ctrl);
  return ctrl;
}

function _inFlight(ctrl: _Controller, key: string): boolean {
  return ctrl.flight.has(key) && ctrl.controls.playing;
}

// ─── Терминальная уборка (natural rest / cancel — одна форма) ─────────────────

function _cleanup(ctrl: _Controller): void {
  for (const node of ctrl.flight.values()) {
    if (node.kind === 'exit') {
      // Ghost — владение адаптера: removeChild + снятие наших инлайнов.
      try {
        ctrl.root.removeChild(node.el);
      } catch {
        /* уже отсоединён */
      }
      const st = node.el.style;
      for (const p of ['position', 'left', 'top', 'width', 'height', 'opacity']) {
        st.removeProperty(p);
      }
    } else {
      _restoreProp(node.el, 'transform', node.savedTransform);
      _restoreProp(node.el, 'transform-origin', node.savedOrigin);
      _restoreProp(node.el, 'border-radius', node.savedRadius);
      if (node.hasOpacity || node.kind === 'enter') {
        _restoreProp(node.el, 'opacity', node.savedOpacity);
      }
    }
  }
  if (ctrl.rootPositionAdded) {
    ctrl.root.style.removeProperty('position');
    ctrl.rootPositionAdded = false;
  }
  ctrl.flight = new Map();
  ctrl.ghosts = new Map();
  ctrl.ghostEls = new Set();
}

function _onNaturalRest(ctrl: _Controller): void {
  _cleanup(ctrl);
  const active = ctrl.active;
  ctrl.active = null;
  if (active !== null) {
    active.setState('settled');
    active.resolve();
  }
}

function _cancelRun(ctrl: _Controller): void {
  ctrl.controls.cancel();
  _cleanup(ctrl);
  const active = ctrl.active;
  ctrl.active = null;
  if (active !== null) {
    active.setState('canceled');
    active.resolve();
  }
}

// ─── Ghost-протокол ───────────────────────────────────────────────────────────

/** Реинсерт ghost'а в root absolute на прежних page-координатах (padding-box). */
function _appendAndPinGhost(ctrl: _Controller, el: SmartElement, box: _Rect): void {
  try {
    ctrl.root.appendChild(el);
  } catch {
    /* враждебный root — тихая деградация */
  }
  const rootBox = _pageBox(ctrl.root, _scroll(ctrl.getScroll));
  const clientLeft = typeof ctrl.root.clientLeft === 'number' ? ctrl.root.clientLeft : 0;
  const clientTop = typeof ctrl.root.clientTop === 'number' ? ctrl.root.clientTop : 0;
  const st = el.style;
  st.setProperty('position', 'absolute');
  st.setProperty('left', _px(box.x - rootBox.x - clientLeft));
  st.setProperty('top', _px(box.y - rootBox.y - clientTop));
  st.setProperty('width', _px(box.width));
  st.setProperty('height', _px(box.height));
  // Static root → position:relative (канон auto: absolute ghost якорится к root).
  if (!ctrl.rootPositionAdded && ctrl.getCS !== undefined) {
    try {
      if (ctrl.getCS(ctrl.root).getPropertyValue('position') === 'static') {
        ctrl.root.style.setProperty('position', 'relative');
        ctrl.rootPositionAdded = true;
      }
    } catch {
      /* нет computed — не якорим */
    }
  }
}

/** Немедленное физическое удаление ghost'а (реинкарнация ключа при живом ghost). */
function _removeGhost(ctrl: _Controller, key: string): void {
  const g = ctrl.ghosts.get(key);
  if (g === undefined) return;
  try {
    ctrl.root.removeChild(g.el);
  } catch {
    /* уже отсоединён */
  }
  const st = g.el.style;
  for (const p of ['position', 'left', 'top', 'width', 'height', 'opacity']) st.removeProperty(p);
  ctrl.ghosts.delete(key);
  ctrl.ghostEls.delete(g.el);
}

// ─── Handle реального прогона ─────────────────────────────────────────────────

function _makeRunHandle(ctrl: _Controller, plan: SmartPlan, tier: SmartTier): SmartHandle {
  let state: 'playing' | 'settled' | 'canceled' | 'superseded' = 'playing';
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });

  ctrl.active = {
    resolve: resolveFinished,
    setState: (s): void => {
      state = s;
    },
  };

  return {
    finished,
    cancel(): void {
      if (state !== 'playing') return; // superseded/settled/canceled — идемпотентно
      state = 'canceled';
      ctrl.cancelActive();
    },
    get playing(): boolean {
      return state === 'playing' && ctrl.controls.playing;
    },
    get progress(): number {
      return state === 'playing' ? ctrl.controls.progress : 1;
    },
    get tier(): SmartTier {
      return tier;
    },
    get plan(): SmartPlan {
      return plan;
    },
  };
}

// ─── Ядро: диф двух снимков → оркестрация ────────────────────────────────────

function _animate(
  ctrl: _Controller,
  snapshot: Map<string, _SnapEntry>,
  opt: SmartOptions,
): SmartHandle {
  const tier = _effectiveTier(opt);
  const reduced = tier === 'reduced';
  const keyAttr = opt.keyAttr ?? SMART_KEY_ATTR;
  const shadow = opt.shadow !== false;
  const epsilon = opt.epsilon ?? 0.01;

  // (а) batch-CLEAR: снять наши инлайны узлов активного полёта (кроме ghost'ов —
  // они запинены absolute и продолжают жить), чтобы замер ниже видел чистый layout.
  for (const node of ctrl.flight.values()) {
    if (node.kind === 'exit') continue;
    _restoreProp(node.el, 'transform', node.savedTransform);
    _restoreProp(node.el, 'transform-origin', node.savedOrigin);
    _restoreProp(node.el, 'border-radius', node.savedRadius);
    if (node.hasOpacity || node.kind === 'enter') {
      _restoreProp(node.el, 'opacity', node.savedOpacity);
    }
  }

  // (б) batch-MEASURE: структура + page-боксы + радиусы NEW-снимка (один reflow).
  const structure = _structure(ctrl.root, keyAttr, shadow, ctrl.ghostEls);
  const scroll = _scroll(ctrl.getScroll);
  const newLive = new Map<string, _SnapEntry>();
  const newOrder: string[] = [];
  for (const s of structure) {
    const box = _pageBox(s.el, scroll);
    const radii = ctrl.radius ? _readRadii(ctrl.getCS, s.el, box.width, box.height) : undefined;
    newLive.set(s.key, { el: s.el, box, radii, parentKey: s.parentKey });
    newOrder.push(s.key);
  }

  // (в) классификация.
  const matched = new Set<string>();
  const enteredKeys: string[] = [];
  const skippedKeys: string[] = [];
  const exitedKeys: string[] = [];
  const reincarnated = new Set<string>();
  interface _Desc {
    kind: _NodeKind;
    el: SmartElement;
    oldBox?: _Rect;
    newBox?: _Rect;
    oldRadii?: BoxRadii | undefined;
    newRadii?: BoxRadii | undefined;
    parentKey?: string | null;
    reincarnation?: boolean;
    ghostBox?: _Rect;
    newExit?: boolean;
  }
  const desc = new Map<string, _Desc>();

  for (const key of newOrder) {
    const nl = newLive.get(key)!;
    if (_isDegenerate(nl.box)) {
      skippedKeys.push(key);
      continue;
    }
    if (ctrl.ghosts.has(key)) {
      // Реинкарнация: ключ вернулся при живом ghost → matched от состояния ghost'а.
      reincarnated.add(key);
      matched.add(key);
      desc.set(key, {
        kind: 'matched',
        el: nl.el,
        newBox: nl.box,
        newRadii: nl.radii,
        parentKey: nl.parentKey,
        reincarnation: true,
      });
      continue;
    }
    const old = snapshot.get(key);
    if (old === undefined) {
      enteredKeys.push(key);
      desc.set(key, { kind: 'enter', el: nl.el, newBox: nl.box });
    } else if (_isDegenerate(old.box)) {
      // Вырожденный first (0×0 на capture): FLIP-«откуда» нет → fade-in на новом месте.
      enteredKeys.push(key);
      desc.set(key, { kind: 'enter', el: nl.el, newBox: nl.box });
    } else {
      matched.add(key);
      desc.set(key, {
        kind: 'matched',
        el: nl.el,
        oldBox: old.box,
        newBox: nl.box,
        oldRadii: old.radii,
        newRadii: nl.radii,
        parentKey: nl.parentKey,
      });
    }
  }

  // exited/skipped из тех, кого при capture видели, а теперь нет.
  for (const [key, old] of snapshot) {
    if (newLive.has(key) || reincarnated.has(key)) continue;
    const connected = old.el.isConnected === true;
    if (connected) {
      // Уехал в чужой контейнер — не украден.
      skippedKeys.push(key);
    } else {
      exitedKeys.push(key);
      desc.set(key, { kind: 'exit', el: old.el, ghostBox: old.box, newExit: true, parentKey: null });
    }
  }

  // continue-exit: ghost всё ещё «в полёте», ключ по-прежнему отсутствует.
  for (const [key, g] of ctrl.ghosts) {
    if (newLive.has(key) || reincarnated.has(key) || desc.has(key)) continue;
    exitedKeys.push(key);
    desc.set(key, { kind: 'exit', el: g.el, ghostBox: g.box, newExit: false, parentKey: null });
  }

  // (г) участие matched: узел едет, если двигался сам ИЛИ движется его matched-предок.
  const moving = new Map<string, boolean>();
  const isMovingSelf = (key: string): boolean => {
    if (reincarnated.has(key)) return true;
    if (_inFlight(ctrl, key)) return true;
    const d = desc.get(key)!;
    return _isMoved(d.oldBox!, d.newBox!, d.oldRadii, d.newRadii, epsilon);
  };
  const nearestMatchedAncestor = (key: string): string | null => {
    let anc = desc.get(key)?.parentKey ?? null;
    while (anc !== null && !matched.has(anc)) {
      anc = newLive.get(anc)?.parentKey ?? null;
    }
    return anc;
  };
  const participate = (key: string): boolean => {
    const memo = moving.get(key);
    if (memo !== undefined) return memo;
    let p = isMovingSelf(key);
    if (!p) {
      const anc = nearestMatchedAncestor(key);
      if (anc !== null) p = participate(anc);
    }
    moving.set(key, p);
    return p;
  };

  const matchedPlan: string[] = [];
  for (const key of newOrder) {
    if (matched.has(key) && participate(key)) matchedPlan.push(key);
  }

  const plan: SmartPlan = {
    matched: matchedPlan,
    entered: enteredKeys,
    exited: exitedKeys,
    skipped: skippedKeys,
  };

  // (д) пустой диф → мгновенно resolved инертный handle (ноль кадров, ноль записей).
  if (
    matchedPlan.length === 0 &&
    enteredKeys.length === 0 &&
    exitedKeys.length === 0 &&
    reincarnated.size === 0
  ) {
    return _inertHandle(tier, plan);
  }

  // (е) построить projection-узлы + новый flight-таргет + ghost-операции.
  // Реинкарнация: физически снять ghost ДО старта (узел стартует от его состояния).
  for (const key of reincarnated) _removeGhost(ctrl, key);

  const nodes: ProjectionPlayNode[] = [];
  const newFlight = new Map<string, _FlightNode>();
  const newGhosts = new Map<string, _GhostEntry>(ctrl.ghosts);
  const newGhostEls = new Set<SmartElement>(ctrl.ghostEls);

  const projParent = (key: string): string | null => {
    let anc = desc.get(key)?.parentKey ?? null;
    while (anc !== null) {
      if (matched.has(anc) && participate(anc)) return anc;
      anc = newLive.get(anc)?.parentKey ?? null;
    }
    return null;
  };

  // matched (под reduced — снап: НЕ едут transform-ом, но в plan.matched остаются).
  if (!reduced) {
    for (const key of matchedPlan) {
      const d = desc.get(key)!;
      const el = d.el;
      const pickup = _inFlight(ctrl, key);
      nodes.push({
        id: key,
        parent: projParent(key),
        first: pickup ? undefined : d.oldBox,
        last: d.newBox!,
        radii:
          d.oldRadii !== undefined && d.newRadii !== undefined
            ? { first: d.oldRadii, last: d.newRadii }
            : undefined,
        opacity: d.reincarnation ? { from: 0, to: 1 } : undefined,
      });
      newFlight.set(key, {
        el,
        kind: 'matched',
        savedTransform: _inl(el, 'transform'),
        savedOrigin: _inl(el, 'transform-origin'),
        savedRadius: _inl(el, 'border-radius'),
        savedOpacity: _inl(el, 'opacity'),
        isGhost: false,
        hasOpacity: d.reincarnation === true,
      });
    }
  }

  // enter (fade-in 0→1, БЕЗ transform — живой и под reduced).
  for (const key of enteredKeys) {
    const d = desc.get(key)!;
    const el = d.el;
    nodes.push({
      id: key,
      parent: null,
      first: d.newBox,
      last: d.newBox!,
      opacity: { from: 0, to: 1 },
    });
    newFlight.set(key, {
      el,
      kind: 'enter',
      savedTransform: _inl(el, 'transform'),
      savedOrigin: _inl(el, 'transform-origin'),
      savedRadius: _inl(el, 'border-radius'),
      savedOpacity: _inl(el, 'opacity'),
      isGhost: false,
      hasOpacity: false,
    });
  }

  // exit (ghost fade 1→0). Новый ghost реинсертится и пинится; continue-exit
  // продолжает аналитический фейд драйвера (first: undefined → pickup opacity).
  for (const key of exitedKeys) {
    const d = desc.get(key)!;
    const el = d.el;
    const box = d.ghostBox!;
    if (d.newExit) {
      _appendAndPinGhost(ctrl, el, box);
      newGhosts.set(key, { el, box });
      newGhostEls.add(el);
      nodes.push({ id: key, parent: null, first: box, last: box, opacity: { from: 1, to: 0 } });
    } else {
      nodes.push({ id: key, parent: null, first: undefined, last: box, opacity: { from: 1, to: 0 } });
    }
    newFlight.set(key, {
      el,
      kind: 'exit',
      savedTransform: '',
      savedOrigin: '',
      savedRadius: '',
      savedOpacity: '',
      isGhost: true,
      hasOpacity: false,
      ghostBox: box,
    });
  }

  ctrl.ghosts = newGhosts;
  ctrl.ghostEls = newGhostEls;

  return _startRun(ctrl, nodes, newFlight, plan, tier);
}

function _startRun(
  ctrl: _Controller,
  nodes: readonly ProjectionPlayNode[],
  newFlight: Map<string, _FlightNode>,
  plan: SmartPlan,
  tier: SmartTier,
): SmartHandle {
  // Перехват: прерванный handle резолвится (не-natural).
  const prev = ctrl.active;
  ctrl.active = null;
  if (prev !== null) {
    prev.setState('superseded');
    prev.resolve();
  }

  ctrl.flight = newFlight;
  const handle = _makeRunHandle(ctrl, plan, tier); // регистрирует ctrl.active ДО play
  ctrl.controls.play(nodes);

  // transform-origin '0 0' (жёсткий контракт projection) — ПОСЛЕ успешного play.
  // Синхронный finish (пустые nodes / нет rAF) уже обнулил flight — origin не пишем.
  if (ctrl.flight === newFlight) {
    for (const [key, node] of newFlight) {
      if (node.kind === 'matched' && ctrl.flight.has(key)) {
        node.el.style.setProperty('transform-origin', '0 0');
      }
    }
  }
  return handle;
}

// ─── Публичный API: captureSmart ──────────────────────────────────────────────

export function captureSmart(root: unknown, options?: SmartOptions): SmartCapture {
  const opt = options ?? {};
  _validateOptions(opt); // fail-fast — до проверки среды, даже под reduce

  if (!_isElementLike(root)) return _inertCapture();

  const ctrl = _getController(root, opt);
  const keyAttr = opt.keyAttr ?? SMART_KEY_ATTR;
  const shadow = opt.shadow !== false;

  // FIRST-снимок: структура (валидация дубля) + боксы/радиусы. Узлы активного
  // полёта НЕ меряются (аналитический V(p̂) через boxAt — ноль DOM под transform).
  const structure = _structure(ctrl.root, keyAttr, shadow, ctrl.ghostEls);
  const scroll = _scroll(ctrl.getScroll);
  const snapshot = new Map<string, _SnapEntry>();
  for (const s of structure) {
    let box: _Rect;
    let radii: BoxRadii | undefined;
    if (_inFlight(ctrl, s.key)) {
      const b = ctrl.controls.boxAt(s.key);
      box = b !== undefined ? { x: b.x, y: b.y, width: b.width, height: b.height } : { x: 0, y: 0, width: 0, height: 0 };
      radii = undefined;
    } else {
      box = _pageBox(s.el, scroll);
      radii = ctrl.radius ? _readRadii(ctrl.getCS, s.el, box.width, box.height) : undefined;
    }
    snapshot.set(s.key, { el: s.el, box, radii, parentKey: s.parentKey });
  }

  const size = structure.length;
  return {
    animate(): SmartHandle {
      return _animate(ctrl, snapshot, opt);
    },
    size,
  };
}

// ─── Публичный API: smartTransition (capture → mutate → animate) ──────────────

export function smartTransition(
  root: unknown,
  mutate: () => void | Promise<void>,
  options?: SmartOptions,
): SmartHandle {
  if (typeof mutate !== 'function') {
    throw new MotionParamError('smart: mutate must be a function');
  }
  const opt = options ?? {};
  const cap = captureSmart(root, opt); // валидация параметров здесь же (fail-fast)

  const result = mutate();
  if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<void>).then === 'function') {
    return _deferredHandle(cap, result as Promise<void>, _isElementLike(root) ? _effectiveTier(opt) : 'ssr');
  }
  return cap.animate();
}

/** Синхронный фасад для async mutate: переход подвязывается после await. */
function _deferredHandle(cap: SmartCapture, promise: Promise<void>, tier: SmartTier): SmartHandle {
  let inner: SmartHandle | null = null;
  let canceled = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });

  void promise.then(
    () => {
      if (canceled) {
        resolveFinished();
        return;
      }
      inner = cap.animate();
      void inner.finished.then(resolveFinished);
    },
    () => resolveFinished(), // ошибка mutate не виснет finished
  );

  return {
    finished,
    cancel(): void {
      canceled = true;
      if (inner !== null) inner.cancel();
      else resolveFinished();
    },
    get playing(): boolean {
      return inner !== null ? inner.playing : false;
    },
    get progress(): number {
      return inner !== null ? inner.progress : 0;
    },
    get tier(): SmartTier {
      return inner !== null ? inner.tier : tier;
    },
    get plan(): SmartPlan {
      return inner !== null ? inner.plan : _EMPTY_PLAN;
    },
  };
}
