/**
 * Общие машины состояний типовых мобильных взаимодействий
 * (subpath ./behaviors, фаза H).
 *
 * Subpath export: import { createBottomSheet } from '@labpics/motion/behaviors'
 *
 * ЗАЧЕМ (граница ответственности): ./gestures даёт распознаватели (press/pan/
 * drag) и инерцию, ./decay — аналитическое затухание, ядро — пружинный солвер.
 * Но «bottom sheet со snap-точками», «drag-to-dismiss с порогом», «пейджер с
 * доводкой к странице», «pull-to-refresh с pending» — это ПРИКЛАДНЫЕ машины
 * состояний поверх этих примитивов. ./behaviors закрывает ровно этот разрыв:
 * готовое поведение (фаза + переходы + выбор цели), НЕ знающее про фреймворк
 * или компонентную библиотеку. DOM-примеры (docs/recipes.md) — тонкие адаптеры
 * поверх этого headless API.
 *
 * Общий контракт (BehaviorState<T>): { value, velocity, phase }, где
 * phase ∈ 'idle'|'follow'|'release'|'settle'. Каждое поведение: события ввода
 * (pointerDown/Move/Up/Cancel), текущее состояние (`state`-геттер + `subscribe`),
 * программные переходы, идемпотентные `cancel()`/`destroy()`.
 *
 * Карта ПЕРЕИСПОЛЬЗОВАНИЯ (ничего не дублировано — импорты, не копии):
 *   ../gestures createVelocityTracker — оценка скорости указателя по окну
 *     сэмплов (тот же трекер, что питает createDrag; velocity на отпускании).
 *   ../decay projectDefaultDecayRest — та же точка покоя, куда прилетел бы элемент
 *     под инерцией → выбор целевого snap/страницы по положению+скорости.
 *   BehaviorRunnerFactory — исполнитель существующего пружинного закона:
 *     кадровый entry и compositor передают его явно; внутри нет второго выбора
 *     backend или скрытого протокола на пользовательских опциях.
 *   ../spring validateSpringForFrameLoop — ранний fail-fast MotionParamError В ФАБРИКЕ.
 *   ../tokens spring — токены темпа (дефолтные пружины доводки); семантическую
 *     роль задаёт потребитель, labui НЕ импортируется.
 *
 * Инварианты (нарушение = провал):
 *   B1. ОДНА state machine владеет фазой и переходами; pointer/programmatic
 *       control НЕ создают параллельные loops — единый generation-токен гасит
 *       stale-кадры, в любой момент активен максимум один runner (один clock).
 *   B2. value и velocity КОНЕЧНЫ (_finite + схлопнутый −0) на каждом выходе.
 *   B3. cancel()/destroy() ИДЕМПОТЕНТНЫ; destroy → инертность (вход = no-op).
 *   B4. reduced-motion меняет ХАРАКТЕР пространственного движения (снап вместо
 *       пружинных кадров), сохраняя состояние и РЕЗУЛЬТАТ (character-switch).
 *   B5. SSR-safe: ни window, ни document на пути импорта; единственный
 *       платформенный шов — инжектируемый requestFrame (детерминизм тестов).
 */

import { createVelocityTracker } from '../gestures/index.js';
import { projectDefaultDecayRest } from '../decay.js';
import { MotionParamError } from '../errors.js';
import type { MatchMediaLike } from '../internal/media-query.js';
import { validateSpringForFrameLoop, type SpringParams } from '../spring.js';
import { spring as springTokens } from '../tokens/index.js';
import type { RequestFrameFn } from '../motion-value.js';
import type { BehaviorRunnerFactory, BehaviorRunnerPort } from './runner-port.js';

// ─── Общий контракт ──────────────────────────────────────────────────────────

/** Фаза жизненного цикла поведения (единый контракт всех машин). */
export type BehaviorPhase = 'idle' | 'follow' | 'release' | 'settle';

/**
 * Снимок состояния поведения. `value`/`velocity` в единицах поведения (обычно px
 * / px·s⁻¹); оба всегда конечны (B2). `phase` — текущая фаза машины.
 */
export interface BehaviorState<T = number> {
  readonly value: T;
  readonly velocity: T;
  readonly phase: BehaviorPhase;
}

/** Точка ввода: координаты (px) + время (СЕКУНДЫ, напр. e.timeStamp/1000). */
export interface BehaviorPoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** Ось, вдоль которой поведение читает ввод. */
export type BehaviorAxis = 'x' | 'y';

// ─── Финитность и мелкие утилиты (B2) ────────────────────────────────────────

/**
 * Страж конечности (зеркалит clampFinite ядра + схлопывает −0):
 * finite → как есть (`+0` убивает −0); NaN → 0; ±∞ → ±MAX_VALUE.
 */
function _finite(x: number): number {
  if (Number.isFinite(x)) return x + 0;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Разность уже нормализованных координат с защитой от overflow. */
function _sub(a: number, b: number): number {
  return _finite(a - b);
}

/** Прочитать координату точки по оси (конечную). */
function _coord(p: BehaviorPoint, axis: BehaviorAxis): number {
  return _finite(axis === 'x' ? p.x : p.y);
}

/** Нормализовать factor сопротивления в [0,1] (дефолт при мусоре). */
function _clampFactor(raw: number | undefined, dflt: number): number {
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw!)) : dflt;
}

const DEFAULT_RUBBER_BAND = 0.5;
/** Половина окна трекера — засев прайора скорости при перехвате (канон gestures). */
const PICKUP_SEED_DT_S = 0.05;

/**
 * База поведения: подписчики + текущее состояние + единый runner + трекер
 * скорости + reduced-флаг + идемпотентные cancel/destroy. Каждое из четырёх
 * поведений оборачивает её собственными обработчиками ввода/выбора цели.
 * Объект базы остаётся в замыканиях: наружу выходят только методы и state.
 * Префикс _ позволяет сборщику сокращать имена внутренних полей.
 */
function _createBase<S extends BehaviorState<number>>(
  initial: S,
  runner: BehaviorRunnerPort,
) {
  const tracker = createVelocityTracker();
  const subs = new Set<(s: S) => void>();
  let state = initial;
  let destroyed = false;

  const emit = (next: Partial<S>): boolean => {
    const emitted = state = { ...state, ...next };
    for (const fn of subs) {
      try {
        fn(emitted);
      } catch {
        // Подписчик не имеет права срывать соседей.
      }
      if (state !== emitted) break;
    }
    return !destroyed && state === emitted;
  };

  return {
    _runner: runner,
    _tracker: tracker,
    get state(): S {
      return state;
    },
    get _destroyed(): boolean {
      return destroyed;
    },
    _emit: emit,
    get _following(): boolean {
      return !destroyed && state.phase === 'follow';
    },
    subscribe(fn: (s: S) => void): () => void {
      if (destroyed) return () => {};
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    /**
     * Погасить активную доводку и осесть в покой на ТЕКУЩЕМ значении (phase idle,
     * velocity 0). Идемпотентна: повторный вызов на уже покоящейся машине —
     * no-op (не плодит эмитов). destroy() строится поверх неё.
     * Сброс вычисляется после перехвата позиции, до публикации idle.
     */
    cancel(reset?: () => Partial<S>): void {
      if (destroyed || state.phase === 'idle' || runner._invalidate() === undefined) return;
      tracker.reset();
      emit({ ...reset?.(), velocity: 0, phase: 'idle' } as Partial<S>);
    },
    destroy(): void {
      if (destroyed) return;
      runner._invalidate();
      tracker.reset();
      subs.clear();
      destroyed = true;
    },
  };
}

/** Перехватить активную доводку тем же tracker/runner и сохранить C¹-prior. */
function _beginPickup(
  base: { _runner: BehaviorRunnerPort; _tracker: ReturnType<typeof createVelocityTracker> },
  p: BehaviorPoint,
  axis: BehaviorAxis,
  velocityScale = 1,
): boolean {
  const velocity = base._runner._invalidate();
  if (velocity === undefined) return false;
  const carry = velocity * velocityScale;
  base._tracker.reset();
  if (carry !== 0) {
    const back = { x: _finite(p.x), y: _finite(p.y), t: _finite(p.t) - PICKUP_SEED_DT_S };
    if (axis === 'x') back.x -= carry * PICKUP_SEED_DT_S;
    else back.y -= carry * PICKUP_SEED_DT_S;
    base._tracker.push(back);
  }
  base._tracker.push(p);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════
// 1. BOTTOM SHEET
// ═══════════════════════════════════════════════════════════════════════════

/** Состояние bottom sheet: value = позиция (px) + индекс целевого snap. */
export interface SheetState extends BehaviorState<number> {
  /** Индекс ближайшего/целевого snap в отсортированном массиве. */
  readonly snapIndex: number;
}

/** Опции bottom sheet. */
export interface SheetOptions {
  /** Snap-точки (px); конструктор сохраняет legacy finite-normalization, `update` строгий. */
  readonly snapPoints: readonly number[];
  /** Стартовая позиция (px). По умолчанию — минимальная snap-точка. */
  readonly initial?: number | undefined;
  /** Ось чтения ввода. По умолчанию 'y' (вертикальный лист). */
  readonly axis?: BehaviorAxis | undefined;
  /** Пружина доводки. По умолчанию токен spring.default (./tokens). */
  readonly spring?: SpringParams | undefined;
  /** Сопротивление за крайними snap ∈ [0,1]. По умолчанию 0.5. */
  readonly rubberBand?: number | undefined;
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: MatchMediaLike | undefined;
  readonly onChange?: ((s: SheetState) => void) | undefined;
}

/** Контроллер bottom sheet. */
export interface SheetController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  /** Обновить snap-ограничения без смены владельца/часов. */
  update(snapPoints: readonly number[]): void;
  /** Программный переход к snap по индексу (единый clock, C¹ из текущей скорости). */
  snapTo(index: number): void;
  subscribe(fn: (s: SheetState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: SheetState;
}

/**
 * Выбрать индекс snap по положению+скорости: проецируем момент через ./decay
 * (`.rest` = куда прилетел бы элемент под инерцией) и берём ближайшую snap-точку.
 * Скорость влияет монотонно (больше скорость → дальше проекция → дальний snap).
 */
function _pickSnap(snaps: readonly number[], value: number, velocity: number): number {
  const landing = projectDefaultDecayRest(value, velocity);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < snaps.length; i++) {
    const d = Math.abs(snaps[i]! - landing);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Создать headless bottom sheet: snap-точки + выбор цели по положению+скорости,
 * follow→доводка (пружина/снап) без потери velocity, rubber-band за крайними
 * snap, программный snapTo, прерывание новым pointer-down. Один clock (B1).
 *
 * @throws {MotionParamError} при пустом snapPoints или невалидной пружине.
 */
export function createBottomSheet(options: SheetOptions, createRunner: BehaviorRunnerFactory): SheetController {
  const readSnaps = (next: number[]): number[] => {
    if (!next.length || !next.every(Number.isFinite)) {
      throw new MotionParamError('LM003');
    }
    return next.sort(_sub);
  };
  let snaps = readSnaps([...options.snapPoints].map(_finite));
  const axis = options.axis ?? 'y';
  const springParams = options.spring ?? (springTokens.default as SpringParams);
  validateSpringForFrameLoop(springParams);
  const rubber = _clampFactor(options.rubberBand, DEFAULT_RUBBER_BAND);

  const start = _finite(options.initial ?? snaps[0]!);
  const startIndex = _pickSnap(snaps, start, 0);
  const base = _createBase<SheetState>(
    { value: start, velocity: 0, phase: 'idle', snapIndex: startIndex },
    createRunner(options),
  );

  let grabValue = 0;
  let lastPointer = 0;

  /** Применить rubber-band за крайними snap к сырой позиции под пальцем. */
  const clampFollow = (raw: number): number => {
    const min = snaps[0]!;
    const max = snaps[snaps.length - 1]!;
    if (raw > max) {
      if (!rubber && base.state.value > max) return Math.min(base.state.value, raw);
      return _finite(max + _sub(raw, max) * rubber);
    }
    if (raw < min) {
      if (!rubber && base.state.value < min) return Math.max(base.state.value, raw);
      return _finite(min + _sub(raw, min) * rubber);
    }
    return raw;
  };

  const settleTo = (index: number, velocity: number | undefined): void => {
    if (velocity === undefined) return;
    base._emit({ phase: 'release', snapIndex: index }) && base._runner._settle({
      from: base.state.value,
      velocity,
      target: snaps[index]!,
      spring: springParams,
      onStep: (v, vel) => base._emit({ value: v, velocity: vel }),
      onDone: () => base._emit({ phase: 'settle' }),
    });
  };

  const ctrl: SheetController = {
    pointerDown(p: BehaviorPoint): void {
      if (base._destroyed) return;
      // Прерывание: гасим активную доводку, наследуем её скорость прайором (C¹).
      if (!_beginPickup(base, p, axis)) return;
      lastPointer = _coord(p, axis);
      grabValue = _sub(base.state.value, lastPointer);
      base._emit({ phase: 'follow', velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      lastPointer = _coord(p, axis);
      const raw = lastPointer + grabValue;
      base._emit({ value: clampFollow(raw) });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      const v = axis === 'x' ? base._tracker.velocity().vx : base._tracker.velocity().vy;
      settleTo(_pickSnap(snaps, base.state.value, v), v);
    },
    pointerCancel(): void {
      if (!base._following) return;
      // Детерминизм: осесть в ближайший snap без унаследованной скорости.
      settleTo(_pickSnap(snaps, base.state.value, 0), 0);
    },
    update(next: readonly number[]): void {
      if (base._destroyed) return;
      const parsed = readSnaps([...next]);
      if (parsed.length === snaps.length && parsed.every((v, i) => v === snaps[i])) return;
      snaps = parsed;
      if (base._following) {
        const value = base.state.value;
        const min = snaps[0]!;
        const max = snaps[snaps.length - 1]!;
        grabValue = _sub(!rubber ? value
          : value > max ? max + (value - max) / rubber
          : value < min ? min + (value - min) / rubber : value, lastPointer);
        base._emit({ snapIndex: Math.min(base.state.snapIndex, snaps.length - 1) });
      } else settleTo(Math.min(base.state.snapIndex, snaps.length - 1), base._runner._invalidate());
    },
    snapTo(index: number): void {
      if (base._destroyed) return;
      const i = Math.max(0, Math.min(snaps.length - 1, Math.trunc(_finite(index))));
      settleTo(i, base._runner._invalidate());
    },
    subscribe: base.subscribe,
    cancel: base.cancel,
    destroy: base.destroy,
    get state(): SheetState {
      return base.state;
    },
  };
  if (options.onChange) ctrl.subscribe(options.onChange);
  return ctrl;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. DRAG-TO-DISMISS
// ═══════════════════════════════════════════════════════════════════════════

/** Состояние dismiss: value = смещение (px) от покоя + флаг «отпущено». */
export interface DismissState extends BehaviorState<number> {
  /** true после того, как порог достигнут и элемент уехал в dismissTarget. */
  readonly dismissed: boolean;
}

/** Опции drag-to-dismiss. */
export interface DismissOptions {
  /** Ось чтения ввода. По умолчанию 'y'. */
  readonly axis?: BehaviorAxis | undefined;
  /** Знак направления вдоль оси, которое ЗАКРЫВАЕТ (1 или −1). По умолчанию 1. */
  readonly direction?: 1 | -1 | undefined;
  /** Порог смещения (px, по модулю в направлении dismiss). Обязателен. */
  readonly distanceThreshold: number;
  /** Порог скорости (px/s) — быстрый флик закрывает раньше дистанции. По умолчанию 600. */
  readonly velocityThreshold?: number | undefined;
  /** Куда уезжает элемент при закрытии (px смещения). По умолчанию direction·(distanceThreshold·8). */
  readonly dismissTarget?: number | undefined;
  /** Пружина возврата/уезда. По умолчанию токен spring.default. */
  readonly spring?: SpringParams | undefined;
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: MatchMediaLike | undefined;
  readonly onChange?: ((s: DismissState) => void) | undefined;
  /** Вызывается один раз, когда элемент осел в dismissTarget. */
  readonly onDismiss?: (() => void) | undefined;
}

/** Контроллер drag-to-dismiss. */
export interface DismissController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  subscribe(fn: (s: DismissState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: DismissState;
}

const DEFAULT_DISMISS_VELOCITY = 600;

/**
 * Создать headless drag-to-dismiss: порог по смещению/скорости, настраиваемое
 * направление, возврат с УНАСЛЕДОВАННОЙ скоростью при недостигнутом пороге,
 * детерминизм при pointer-cancel. Один clock (B1).
 *
 * @throws {MotionParamError} при невалидном distanceThreshold или пружине.
 */
export function createDragDismiss(options: DismissOptions, createRunner: BehaviorRunnerFactory): DismissController {
  const axis = options.axis ?? 'y';
  const dir: 1 | -1 = options.direction === -1 ? -1 : 1;
  const dist = _finite(options.distanceThreshold);
  if (!(dist > 0)) {
    throw new MotionParamError('LM004');
  }
  const velThresh = Number.isFinite(options.velocityThreshold)
    ? Math.abs(options.velocityThreshold as number)
    : DEFAULT_DISMISS_VELOCITY;
  const springParams = options.spring ?? (springTokens.default as SpringParams);
  validateSpringForFrameLoop(springParams);
  const dismissTarget = _finite(options.dismissTarget ?? dir * dist * 8);

  const base = _createBase<DismissState>(
    { value: 0, velocity: 0, phase: 'idle', dismissed: false },
    createRunner(options),
  );

  let grabPointer = 0;
  let grabValue = 0;

  const returnHome = (velocity: number): void => {
    base._emit({ phase: 'release' }) && base._runner._settle({
      from: base.state.value,
      velocity,
      target: 0,
      spring: springParams,
      onStep: (v, vel) => base._emit({ value: v, velocity: vel }),
      onDone: () => base._emit({ phase: 'settle' }),
    });
  };

  const dismiss = (velocity: number): void => {
    base._emit({ phase: 'release' }) && base._runner._settle({
      from: base.state.value,
      velocity,
      target: dismissTarget,
      spring: springParams,
      onStep: (v, vel) => base._emit({ value: v, velocity: vel }),
      onDone: () => {
        if (base._emit({ phase: 'settle', dismissed: true })) options.onDismiss?.();
      },
    });
  };

  const ctrl: DismissController = {
    pointerDown(p: BehaviorPoint): void {
      if (base._destroyed || base.state.dismissed) return;
      if (!_beginPickup(base, p, axis)) return;
      grabPointer = _coord(p, axis);
      grabValue = base.state.value;
      base._emit({ phase: 'follow', velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      const raw = _finite(grabValue + _sub(_coord(p, axis), grabPointer));
      base._emit({ value: raw });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      const v = axis === 'x' ? base._tracker.velocity().vx : base._tracker.velocity().vy;
      // Порог: смещение В НАПРАВЛЕНИИ dismiss ИЛИ скорость в ту же сторону.
      const projDist = dir * base.state.value;
      const projVel = dir * v;
      if (projDist >= dist || projVel >= velThresh) dismiss(_finite(v));
      else returnHome(_finite(v));
    },
    pointerCancel(): void {
      if (!base._following) return;
      // Детерминизм: перехват указателя ВСЕГДА возвращает домой, без скорости.
      returnHome(0);
    },
    subscribe: base.subscribe,
    cancel: base.cancel,
    destroy: base.destroy,
    get state(): DismissState {
      return base.state;
    },
  };
  if (options.onChange) ctrl.subscribe(options.onChange);
  return ctrl;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CAROUSEL / PAGER
// ═══════════════════════════════════════════════════════════════════════════

/** Состояние карусели: value = позиция (px, страница i при i·pageSize) + индекс. */
export interface CarouselState extends BehaviorState<number> {
  /** Текущий индекс страницы (единый clock — выводится из position, B1). */
  readonly index: number;
}

/** Опции карусели/пейджера. */
export interface CarouselOptions {
  /** Число страниц (>= 1); конструктор сохраняет legacy truncation, `update` строгий. */
  readonly pageCount: number;
  /** Размер страницы (px, > 0); конструктор сохраняет legacy finite-normalization. */
  readonly pageSize: number;
  /** Стартовая страница. По умолчанию 0. */
  readonly index?: number | undefined;
  /** Ось прокрутки. По умолчанию 'x'. */
  readonly axis?: BehaviorAxis | undefined;
  /** Right-to-left: зеркалит направление выбора страницы. По умолчанию false. */
  readonly rtl?: boolean | undefined;
  /** Порог скорости (px/s) для перелистывания флик-жестом. По умолчанию 400. */
  readonly velocityThreshold?: number | undefined;
  /** Пружина доводки к странице. По умолчанию токен spring.snappy. */
  readonly spring?: SpringParams | undefined;
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: MatchMediaLike | undefined;
  readonly onChange?: ((s: CarouselState) => void) | undefined;
}

/** Контроллер карусели/пейджера. */
export interface CarouselController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  /** Обновить геометрию/ограничения без смены владельца/часов. */
  update(pageCount: number, pageSize: number): void;
  /** Программно перейти на страницу (единый clock). */
  goTo(index: number): void;
  next(): void;
  prev(): void;
  subscribe(fn: (s: CarouselState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: CarouselState;
}

const DEFAULT_CAROUSEL_VELOCITY = 400;

function _readCarouselGeometry(count: number, size: number): void {
  if (!Number.isFinite(count) || count < 1 || count % 1 !== 0) throw new MotionParamError('LM005');
  if (!Number.isFinite(size) || size <= 0) throw new MotionParamError('LM006');
}

/**
 * Создать headless карусель/пейджер: ЕДИНЫЙ clock для позиции и индекса, inertia
 * с доводкой к странице, направление+velocity в выборе страницы, RTL и вертикаль.
 *
 * @throws {MotionParamError} если нормализованный pageCount/pageSize невалиден или пружина невалидна.
 */
export function createCarousel(options: CarouselOptions, createRunner: BehaviorRunnerFactory): CarouselController {
  let pageCount = Math.trunc(_finite(options.pageCount));
  let pageSize = _finite(options.pageSize);
  _readCarouselGeometry(pageCount, pageSize);
  const axis = options.axis ?? 'x';
  const velThresh = Number.isFinite(options.velocityThreshold)
    ? Math.abs(options.velocityThreshold as number)
    : DEFAULT_CAROUSEL_VELOCITY;
  const springParams = options.spring ?? (springTokens.snappy as SpringParams);
  validateSpringForFrameLoop(springParams);

  const clampIndex = (i: number): number => Math.max(0, Math.min(pageCount - 1, i));
  let targetIndex = clampIndex(Math.round(_finite(options.index ?? 0)));
  const initialValue = _finite(targetIndex * pageSize);

  const base = _createBase<CarouselState>(
    { value: initialValue, velocity: 0, phase: 'idle', index: clampIndex(Math.round(initialValue / pageSize)) },
    createRunner(options),
  );

  let grabPointer = 0;
  let grabValue = 0;

  // Знак перевода pointer-смещения в position-пространство:
  // горизонталь LTR → влево = следующая (position растёт) → −d; RTL → +d;
  // вертикаль → вверх = следующая → −d.
  const posDirSign = axis === 'x' && options.rtl === true ? 1 : -1;

  const settleTo = (index: number, velocity: number | undefined): void => {
    if (velocity === undefined) return;
    targetIndex = clampIndex(index);
    base._emit({ phase: 'release', index: clampIndex(base.state.index) }) && base._runner._settle({
      from: base.state.value,
      velocity,
      target: _finite(targetIndex * pageSize),
      spring: springParams,
      // Единый clock: index выводится из position КАЖДЫЙ кадр (не отдельный счётчик).
      onStep: (v, vel) => base._emit({ value: v, velocity: vel, index: clampIndex(Math.round(v / pageSize)) }),
      onDone: () => base._emit({ phase: 'settle' }),
    });
  };

  const ctrl: CarouselController = {
    pointerDown(p: BehaviorPoint): void {
      if (base._destroyed) return;
      if (!_beginPickup(base, p, axis, posDirSign)) return;
      grabPointer = _coord(p, axis);
      grabValue = base.state.value;
      base._emit({ phase: 'follow', velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      const value = _finite(grabValue + posDirSign * _sub(_coord(p, axis), grabPointer));
      base._emit({ value, index: clampIndex(Math.round(value / pageSize)) });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      const vAxis = axis === 'x' ? base._tracker.velocity().vx : base._tracker.velocity().vy;
      // Скорость в position-пространстве.
      const posVel = posDirSign * vAxis;
      // Проекция момента через ./decay → куда прилетела бы позиция.
      const landing = projectDefaultDecayRest(base.state.value, posVel);
      let target = Math.round(landing / pageSize);
      // Флик перелистывает минимум на страницу; доводка — максимум ±1 от старта свайпа.
      const start = clampIndex(Math.round(grabValue / pageSize));
      if (Math.abs(posVel) >= velThresh) target = start + (posVel > 0 ? 1 : -1);
      target = Math.max(start - 1, Math.min(start + 1, target));
      settleTo(target, posVel);
    },
    pointerCancel(): void {
      if (!base._following) return;
      // Детерминизм: доводка к ближайшей странице без скорости.
      settleTo(Math.round(base.state.value / pageSize), 0);
    },
    update(count: number, size: number): void {
      if (base._destroyed) return;
      _readCarouselGeometry(count, size);
      if (count === pageCount && size === pageSize) return;
      pageCount = count;
      pageSize = size;
      if (base._following) base._emit({ index: clampIndex(Math.round(base.state.value / pageSize)) });
      else settleTo(targetIndex, base._runner._invalidate());
    },
    goTo(index: number): void {
      if (base._destroyed) return;
      settleTo(Math.round(_finite(index)), base._runner._invalidate());
    },
    next(): void {
      if (base._destroyed) return;
      const velocity = base._runner._invalidate();
      settleTo(base.state.index + 1, velocity);
    },
    prev(): void {
      if (base._destroyed) return;
      const velocity = base._runner._invalidate();
      settleTo(base.state.index - 1, velocity);
    },
    subscribe: base.subscribe,
    cancel(): void {
      base.cancel(() => ({ index: targetIndex = base.state.index }));
    },
    destroy: base.destroy,
    get state(): CarouselState {
      return base.state;
    },
  };
  if (options.onChange) ctrl.subscribe(options.onChange);
  return ctrl;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. PULL-TO-REFRESH
// ═══════════════════════════════════════════════════════════════════════════

/** Состояние pull-to-refresh: value = дистанция протяжки (px, >= 0). */
export interface PullState extends BehaviorState<number> {
  /** Палец тянет прямо сейчас. */
  readonly pulling: boolean;
  /** Протяжка перешла порог активации (release запустит refresh). */
  readonly armed: boolean;
  /** Асинхронное действие в полёте (удержание на pendingPosition). */
  readonly pending: boolean;
}

/** Опции pull-to-refresh. */
export interface PullOptions {
  /** Порог активации (px протяжки). Обязателен, > 0. */
  readonly threshold: number;
  /** Ось чтения ввода. По умолчанию 'y'. */
  readonly axis?: BehaviorAxis | undefined;
  /** Знак направления протяжки вдоль оси (1 = вниз/плюс). По умолчанию 1. */
  readonly direction?: 1 | -1 | undefined;
  /** Резистентность overscroll ∈ [0,1] (0.5 = вдвое тяжелее пальца). По умолчанию 0.5. */
  readonly resistance?: number | undefined;
  /** Высота удержания при pending (px). По умолчанию = threshold. */
  readonly pendingPosition?: number | undefined;
  /** Пружина возврата/доводки. По умолчанию токен spring.default. */
  readonly spring?: SpringParams | undefined;
  /** Асинхронное действие; возврат пружиной — после его резолва. */
  readonly onRefresh?: (() => void | Promise<void>) | undefined;
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: MatchMediaLike | undefined;
  readonly onChange?: ((s: PullState) => void) | undefined;
}

/** Контроллер pull-to-refresh. */
export interface PullController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  subscribe(fn: (s: PullState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: PullState;
}

/**
 * Создать headless pull-to-refresh: резистентный overscroll, порог активации,
 * pending БЕЗ второго владельца позиции (удержание — тот же единственный runner),
 * возврат пружиной после async-действия. Один clock (B1).
 *
 * @throws {MotionParamError} при невалидном threshold или пружине.
 */
export function createPullToRefresh(options: PullOptions, createRunner: BehaviorRunnerFactory): PullController {
  const threshold = _finite(options.threshold);
  if (!(threshold > 0)) {
    throw new MotionParamError('LM007');
  }
  const axis = options.axis ?? 'y';
  const dir: 1 | -1 = options.direction === -1 ? -1 : 1;
  const resistance = _clampFactor(options.resistance, DEFAULT_RUBBER_BAND);
  const springParams = options.spring ?? (springTokens.default as SpringParams);
  validateSpringForFrameLoop(springParams);
  const pendingPos = _finite(options.pendingPosition ?? threshold);

  const base = _createBase<PullState>(
    { value: 0, velocity: 0, phase: 'idle', pulling: false, armed: false, pending: false },
    createRunner(options),
  );

  let grabPointer = 0;

  const springTo = (
    target: number,
    velocity: number,
    onDone: () => void,
  ): void => {
    base._emit({ phase: 'release' }) && base._runner._settle({
      from: base.state.value,
      velocity,
      target,
      spring: springParams,
      onStep: (v, vel) => base._emit({ value: v, velocity: vel }),
      onDone,
    });
  };

  const returnHome = (velocity: number): void => {
    springTo(0, velocity, () =>
      base._emit({ phase: 'idle', pulling: false, armed: false, pending: false }),
    );
  };

  const runRefresh = (velocity: number): void => {
    // Доводка к pendingPosition ТЕМ ЖЕ runner'ом; на финише — pending-удержание.
    if (!base._emit({ pulling: false })) return;
    springTo(pendingPos, velocity, () => {
      if (!base._emit({ phase: 'settle', pending: true, armed: false })) return;
      const pendingState = base.state;
      const finish = (): void => {
        if (!base._destroyed && base.state === pendingState) returnHome(0);
      };
      try {
        Promise.resolve(options.onRefresh?.()).then(finish, finish);
      } catch {
        finish();
      }
    });
  };

  const ctrl: PullController = {
    pointerDown(p: BehaviorPoint): void {
      if (base._destroyed || base.state.pending) return; // pending владеет позицией
      if (!_beginPickup(base, p, axis, 0)) return;
      grabPointer = _coord(p, axis);
      base._emit({ phase: 'follow', pulling: true, velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      // Сырая протяжка в направлении dir; обратное — 0 (это не pull).
      const rawPull = dir * _sub(_coord(p, axis), grabPointer);
      const value = rawPull > 0 ? _finite(rawPull * resistance) : 0;
      base._emit({ value, armed: value >= threshold });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!base._following) return;
      base._tracker.push(p);
      const vAxis = axis === 'x' ? base._tracker.velocity().vx : base._tracker.velocity().vy;
      const pullVel = dir * vAxis * resistance;
      if (base.state.armed) runRefresh(_finite(pullVel));
      else returnHome(_finite(pullVel));
    },
    pointerCancel(): void {
      if (!base._following) return;
      // Детерминизм: перехват возвращает домой без активации refresh.
      returnHome(0);
    },
    subscribe: base.subscribe,
    cancel(): void {
      base.cancel(() => ({ value: 0, pulling: false, armed: false, pending: false }));
    },
    destroy: base.destroy,
    get state(): PullState {
      return base.state;
    },
  };
  if (options.onChange) ctrl.subscribe(options.onChange);
  return ctrl;
}
