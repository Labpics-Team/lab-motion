/**
 * behaviors/index.ts — headless state machines типовых мобильных взаимодействий
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
 * или компонентную библиотеку. DOM-примеры (README) — тонкие адаптеры поверх
 * этого headless API.
 *
 * Общий контракт (BehaviorState<T>): { value, velocity, phase }, где
 * phase ∈ 'idle'|'follow'|'release'|'settle'. Каждое поведение: события ввода
 * (pointerDown/Move/Up/Cancel), текущее состояние (`state`-геттер + `subscribe`),
 * программные переходы, идемпотентные `cancel()`/`destroy()`.
 *
 * Карта ПЕРЕИСПОЛЬЗОВАНИЯ (ничего не дублировано — импорты, не копии):
 *   ../gestures createVelocityTracker — оценка скорости указателя по окну
 *     сэмплов (тот же трекер, что питает createDrag; velocity на отпускании).
 *   ../decay createDecay — ПРОЕКЦИЯ момента: `.rest` = куда прилетел бы элемент
 *     под инерцией → выбор целевого snap/страницы по положению+скорости.
 *   ../internal/solver solveSpring — единый пружинный солвер (тот же, что ядро и
 *     smooth-pickup MotionValue): доводка value→target с наследованием velocity
 *     (v0n = velocity/range даёт C¹ на стыке follow|release).
 *   ../spring validateSpringParams — ранний fail-fast MotionParamError В ФАБРИКЕ.
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
 *
 * ─── MUTATION PROOF (ручная проба, 2026-07-10; каждый мутант откачен) ─────────
 * 10 мутантов в РАЗНЫЕ поведения/переходы, каждый кусается (RED на зафиксированной
 * спеке; прогон test/behaviors-*.test.ts):
 *   1. Слом выбора snap по скорости (проекция игнорит velocity: landing=value) →
 *      RED (property «flick вверх → верхний snap», sheet-example «доводка по флику»).
 *   2. Потеря velocity на follow→release (v0n=0 вместо velocity/range) → RED
 *      (dismiss «возврат наследует скорость», sheet C¹-контракт).
 *   3. Параллельный loop (pointerDown НЕ инкрементит generation) → RED
 *      (interruption «pointer-down во время settle не плодит второй clock»,
 *      clock.pending()/rafCalls двойные).
 *   4. Слом идемпотентности cancel (нет guard destroyed/idle) → RED
 *      (lifecycle «двойной cancel/destroy», эмитов больше 1).
 *   5. Reduced-leak (убран reduced-ветка в runner) → RED (reduced-контракт:
 *      промежуточные value ∈ (from,target), а обязан быть мгновенный снап).
 *   6. Слом порога dismiss (>= заменён на >) на граничном значении → RED
 *      (dismiss property «ровно на пороге → dismiss»).
 *   7. Слом единого clock carousel (index из отдельного счётчика, не из position)
 *      → RED (carousel «index и position согласованы каждый кадр»).
 *   8. Rubber-band знак (overshoot*factor → overshoot/factor или знак-flip) → RED
 *      (sheet «rubber-band за крайним snap уводит в ту же сторону, меньше»).
 *   9. Pull: второй владелец позиции (pending заводит свой таймер поверх runner)
 *      → RED (pull «pending удерживается тем же runner», нет двойных кадров).
 *  10. Carousel RTL-знак (rtl не флипает направление) → RED (property «RTL
 *      зеркалит выбор страницы»).
 */

import { createVelocityTracker } from '../gestures/index.js';
import { createDecay } from '../decay.js';
import { MotionParamError } from '../errors.js';
import { solveSpring } from '../internal/solver.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from '../internal/constants.js';
import { validateSpringParams, type SpringParams } from '../spring.js';
import { spring as springTokens } from '../tokens/index.js';
import type { RequestFrameFn } from '../motion-value.js';

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

/** Разность с защитой от overflow (|a|+|b|>MAX → ±∞ → clamp). */
function _sub(a: number, b: number): number {
  return _finite(_finite(a) - _finite(b));
}

/** Прочитать координату точки по оси (конечную). */
function _coord(p: BehaviorPoint, axis: BehaviorAxis): number {
  return _finite(axis === 'x' ? p.x : p.y);
}

/** Прочитать предпочтение reduced-motion из инжектируемого matchMedia (B4). */
function _prefersReduced(matchMedia: ((q: string) => MediaQueryList) | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Rubber-band сопротивление за границей (класс elastic у Motion): смещённая
 * координата = граница + overshoot·factor. factor ∈ [0,1] (0 = жёсткий clamp).
 * ЗНАК overshoot сохраняется — увод остаётся в ту же сторону, только короче.
 */
function _rubberBand(overshoot: number, factor: number): number {
  return _finite(overshoot) * factor;
}

/** Нормализовать factor сопротивления в [0,1] (дефолт при мусоре). */
function _clampFactor(raw: number | undefined, dflt: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : dflt;
}

const DEFAULT_RUBBER_BAND = 0.5;
/** Половина окна трекера — засев прайора скорости при перехвате (канон gestures). */
const PICKUP_SEED_DT_S = 0.05;

// ─── Единый runner (B1): один clock, доводка value→target пружиной ───────────

/**
 * Аргументы одной доводки: from/velocity (унаследованная скорость момента
 * отпускания или перехвата), target, пружина, и колбэки на кадр/финиш.
 */
interface _SettleArgs {
  readonly from: number;
  readonly velocity: number;
  readonly target: number;
  readonly spring: SpringParams;
  readonly onStep: (value: number, velocity: number) => void;
  readonly onDone: () => void;
}

/** Хендл единого runner'а поведения. */
interface _Runner {
  /** Запустить доводку value→target (ровно один активный цикл). */
  settle(args: _SettleArgs): void;
  /** Погасить активный цикл (перехват/cancel) — stale-кадры инвалидируются. */
  invalidate(): void;
  /** true, пока идёт пружинный цикл. */
  readonly running: boolean;
  /** Текущее значение цикла (для C¹-перехвата). */
  readonly value: number;
  /** Текущая скорость цикла (для C¹-перехвата). */
  readonly velocity: number;
}

/**
 * Создать единый runner поведения. Владеет generation-токеном: любой новый
 * `settle()` или `invalidate()` инкрементит его, и запланированные кадры чужого
 * поколения гаснут (B1 — ноль параллельных loops). reduced-motion → мгновенный
 * снап в target без единого кадра (B4 character-switch).
 */
function _createRunner(
  requestFrame: RequestFrameFn | undefined,
  reduced: boolean,
): _Runner {
  let gen = 0;
  let running = false;
  let curVal = 0;
  let curVel = 0;

  const schedule = (cb: (ts?: number) => void): void => {
    if (!requestFrame) return; // недостижимо: снап-путь ловит отсутствие шва раньше
    const handle = requestFrame(cb);
    if (handle === 0) setTimeout(() => cb(undefined), 0); // non-draining шов (конвенция repo)
  };

  return {
    settle(args: _SettleArgs): void {
      gen++;
      const my = gen;
      running = true;
      curVal = _finite(args.from);
      curVel = _finite(args.velocity);
      const range = args.target - args.from;

      const finishNow = (): void => {
        if (my !== gen) return;
        running = false;
        curVal = _finite(args.target);
        curVel = 0;
        args.onStep(curVal, 0);
        args.onDone();
      };

      // B4: reduced-motion / вырожденный диапазон / нет кадрового шва → снап.
      if (reduced || range === 0 || !requestFrame) {
        finishNow();
        return;
      }

      // C¹-стык: нормируем унаследованную скорость на диапазон (тот же приём,
      // что smooth-pickup MotionValue и snapBack gestures) — знак «к цели» и
      // непрерывность производной на границе follow|release получаются даром.
      const v0n = args.velocity / range;
      let elapsed = 0;
      let lastTs: number | undefined;
      let frames = 0;

      const tick = (ts?: number): void => {
        if (my !== gen || !running) return; // stale-кадр после перехвата/cancel
        if (typeof ts === 'number' && Number.isFinite(ts)) {
          elapsed = lastTs === undefined ? elapsed : elapsed + Math.max(0, (ts - lastTs) / 1000);
          lastTs = ts;
        } else {
          elapsed += FIXED_DT_S;
        }
        frames++;

        const s = solveSpring(args.spring, elapsed, v0n);
        const val = args.from + s.value * range;
        const vel = s.velocity * range;
        curVal = _finite(val);
        curVel = _finite(vel);
        const denom = Math.abs(range); // > 0 по построению (range !== 0)

        if (
          !Number.isFinite(val) ||
          !Number.isFinite(vel) ||
          (Math.abs(val - args.target) / denom < CONVERGENCE_THRESHOLD &&
            Math.abs(vel) / denom < CONVERGENCE_THRESHOLD) ||
          frames >= MAX_FRAMES
        ) {
          finishNow();
          return;
        }
        args.onStep(curVal, curVel);
        schedule(tick);
      };

      schedule(tick);
    },
    invalidate(): void {
      gen++;
      running = false;
    },
    get running(): boolean {
      return running;
    },
    get value(): number {
      return curVal;
    },
    get velocity(): number {
      return curVel;
    },
  };
}

/**
 * База поведения: подписчики + текущее состояние + единый runner + трекер
 * скорости + reduced-флаг + идемпотентные cancel/destroy. Каждое из четырёх
 * поведений оборачивает её собственными обработчиками ввода/выбора цели.
 */
function _createBase<S extends BehaviorState<number>>(
  initial: S,
  requestFrame: RequestFrameFn | undefined,
  matchMedia: ((q: string) => MediaQueryList) | undefined,
) {
  const reduced = _prefersReduced(matchMedia);
  const runner = _createRunner(requestFrame, reduced);
  const tracker = createVelocityTracker();
  const subs = new Set<(s: S) => void>();
  let state = initial;
  let destroyed = false;

  const emit = (next: Partial<S>): void => {
    state = { ...state, ...next };
    for (const fn of subs) {
      try {
        fn(state);
      } catch {
        // Подписчик не имеет права срывать соседей.
      }
    }
  };

  return {
    reduced,
    runner,
    tracker,
    get state(): S {
      return state;
    },
    get destroyed(): boolean {
      return destroyed;
    },
    emit,
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
     */
    cancel(): void {
      if (destroyed) return;
      if (!runner.running && state.phase === 'idle') return; // уже в покое
      runner.invalidate();
      tracker.reset();
      emit({ velocity: 0, phase: 'idle' } as Partial<S>);
    },
    destroy(): void {
      if (destroyed) return;
      runner.invalidate();
      tracker.reset();
      subs.clear();
      destroyed = true;
    },
  };
}

/**
 * Засеять трекер прайором скорости перехвата (C¹-pickup летящего значения):
 * синтетический сэмпл на полокна назад вдоль скорости — немедленный повторный
 * release наследует движение, а реальные сэмплы вытесняют прайор как обычно.
 * Тот же приём, что glide-pickup в createDrag.
 */
function _seedPickup(
  tracker: ReturnType<typeof createVelocityTracker>,
  p: BehaviorPoint,
  axis: BehaviorAxis,
  vAxis: number,
): void {
  if (vAxis === 0) return;
  const back = { x: _finite(p.x), y: _finite(p.y), t: _finite(p.t) - PICKUP_SEED_DT_S };
  if (axis === 'x') back.x = _finite(p.x) - vAxis * PICKUP_SEED_DT_S;
  else back.y = _finite(p.y) - vAxis * PICKUP_SEED_DT_S;
  tracker.push(back);
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
  /** Snap-точки (px) — будут отсортированы по возрастанию. Минимум одна. */
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
  readonly matchMedia?: ((q: string) => MediaQueryList) | undefined;
  readonly onChange?: ((s: SheetState) => void) | undefined;
}

/** Контроллер bottom sheet. */
export interface SheetController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
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
  const landing = createDecay({ from: value, velocity }).rest;
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
export function createBottomSheet(options: SheetOptions): SheetController {
  const snaps = [...options.snapPoints].map(_finite).sort((a, b) => a - b);
  if (snaps.length === 0) {
    // Дешёвый детерминированный fail-fast (класс MotionParamError ядра).
    throw new MotionParamError('behaviors: snapPoints must be non-empty');
  }
  const axis = options.axis ?? 'y';
  const springParams = options.spring ?? (springTokens.default as SpringParams);
  validateSpringParams(springParams);
  const rubber = _clampFactor(options.rubberBand, DEFAULT_RUBBER_BAND);
  const minSnap = snaps[0]!;
  const maxSnap = snaps[snaps.length - 1]!;

  const start = _finite(options.initial ?? minSnap);
  const startIndex = _pickSnap(snaps, start, 0);
  const base = _createBase<SheetState>(
    { value: start, velocity: 0, phase: 'idle', snapIndex: startIndex },
    options.requestFrame,
    options.matchMedia,
  );

  let dragging = false;
  let grabPointer = 0;
  let grabValue = 0;

  /** Применить rubber-band за крайними snap к сырой позиции под пальцем. */
  const clampFollow = (raw: number): number => {
    if (raw > maxSnap) return _finite(maxSnap + _rubberBand(raw - maxSnap, rubber));
    if (raw < minSnap) return _finite(minSnap + _rubberBand(raw - minSnap, rubber));
    return _finite(raw);
  };

  const settleTo = (index: number, velocity: number): void => {
    const target = snaps[index]!;
    base.emit({ phase: 'release', snapIndex: index });
    base.runner.settle({
      from: base.state.value,
      velocity,
      target,
      spring: springParams,
      onStep: (v, vel) => base.emit({ value: v, velocity: vel }),
      onDone: () => base.emit({ value: target, velocity: 0, phase: 'settle', snapIndex: index }),
    });
  };

  const ctrl: SheetController = {
    pointerDown(p: BehaviorPoint): void {
      if (base.destroyed) return;
      // Прерывание: гасим активную доводку, наследуем её скорость прайором (C¹).
      const carry = base.runner.running ? base.runner.velocity : 0;
      base.runner.invalidate();
      dragging = true;
      grabPointer = _coord(p, axis);
      grabValue = base.state.value;
      base.tracker.reset();
      _seedPickup(base.tracker, p, axis, carry);
      base.tracker.push(p);
      base.emit({ phase: 'follow', velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!dragging) return;
      base.tracker.push(p);
      const raw = _finite(grabValue + _sub(_coord(p, axis), grabPointer));
      base.emit({ value: clampFollow(raw), velocity: 0 });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!dragging) return;
      dragging = false;
      base.tracker.push(p);
      const v = axis === 'x' ? base.tracker.velocity().vx : base.tracker.velocity().vy;
      const index = _pickSnap(snaps, base.state.value, v);
      settleTo(index, _finite(v));
    },
    pointerCancel(): void {
      if (!dragging) return;
      dragging = false;
      // Детерминизм: осесть в ближайший snap без унаследованной скорости.
      const index = _pickSnap(snaps, base.state.value, 0);
      settleTo(index, 0);
    },
    snapTo(index: number): void {
      if (base.destroyed) return;
      const i = Math.max(0, Math.min(snaps.length - 1, Math.trunc(_finite(index))));
      dragging = false;
      const carry = base.runner.running ? base.runner.velocity : 0;
      base.runner.invalidate();
      settleTo(i, carry);
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
  readonly matchMedia?: ((q: string) => MediaQueryList) | undefined;
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
export function createDragDismiss(options: DismissOptions): DismissController {
  const axis = options.axis ?? 'y';
  const dir: 1 | -1 = options.direction === -1 ? -1 : 1;
  const dist = _finite(options.distanceThreshold);
  if (!(dist > 0)) {
    throw new MotionParamError(
      `behaviors: distanceThreshold must be positive finite, got ${options.distanceThreshold}`,
    );
  }
  const velThresh =
    typeof options.velocityThreshold === 'number' && Number.isFinite(options.velocityThreshold)
      ? Math.abs(options.velocityThreshold)
      : DEFAULT_DISMISS_VELOCITY;
  const springParams = options.spring ?? (springTokens.default as SpringParams);
  validateSpringParams(springParams);
  const dismissTarget = _finite(options.dismissTarget ?? dir * dist * 8);

  const base = _createBase<DismissState>(
    { value: 0, velocity: 0, phase: 'idle', dismissed: false },
    options.requestFrame,
    options.matchMedia,
  );

  let dragging = false;
  let grabPointer = 0;
  let grabValue = 0;

  const returnHome = (velocity: number): void => {
    base.emit({ phase: 'release' });
    base.runner.settle({
      from: base.state.value,
      velocity,
      target: 0,
      spring: springParams,
      onStep: (v, vel) => base.emit({ value: v, velocity: vel }),
      onDone: () => base.emit({ value: 0, velocity: 0, phase: 'settle' }),
    });
  };

  const dismiss = (velocity: number): void => {
    base.emit({ phase: 'release' });
    base.runner.settle({
      from: base.state.value,
      velocity,
      target: dismissTarget,
      spring: springParams,
      onStep: (v, vel) => base.emit({ value: v, velocity: vel }),
      onDone: () => {
        base.emit({ value: dismissTarget, velocity: 0, phase: 'settle', dismissed: true });
        options.onDismiss?.();
      },
    });
  };

  const ctrl: DismissController = {
    pointerDown(p: BehaviorPoint): void {
      if (base.destroyed || base.state.dismissed) return;
      const carry = base.runner.running ? base.runner.velocity : 0;
      base.runner.invalidate();
      dragging = true;
      grabPointer = _coord(p, axis);
      grabValue = base.state.value;
      base.tracker.reset();
      _seedPickup(base.tracker, p, axis, carry);
      base.tracker.push(p);
      base.emit({ phase: 'follow', velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!dragging) return;
      base.tracker.push(p);
      const raw = _finite(grabValue + _sub(_coord(p, axis), grabPointer));
      base.emit({ value: raw, velocity: 0 });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!dragging) return;
      dragging = false;
      base.tracker.push(p);
      const v = axis === 'x' ? base.tracker.velocity().vx : base.tracker.velocity().vy;
      // Порог: смещение В НАПРАВЛЕНИИ dismiss ИЛИ скорость в ту же сторону.
      const projDist = dir * base.state.value;
      const projVel = dir * v;
      if (projDist >= dist || projVel >= velThresh) dismiss(_finite(v));
      else returnHome(_finite(v));
    },
    pointerCancel(): void {
      if (!dragging) return;
      dragging = false;
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
  /** Число страниц (>= 1). */
  readonly pageCount: number;
  /** Размер страницы (px, > 0). */
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
  readonly matchMedia?: ((q: string) => MediaQueryList) | undefined;
  readonly onChange?: ((s: CarouselState) => void) | undefined;
}

/** Контроллер карусели/пейджера. */
export interface CarouselController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
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

/**
 * Создать headless карусель/пейджер: ЕДИНЫЙ clock для позиции и индекса, inertia
 * с доводкой к странице, направление+velocity в выборе страницы, RTL и вертикаль.
 *
 * @throws {MotionParamError} при невалидном pageCount/pageSize или пружине.
 */
export function createCarousel(options: CarouselOptions): CarouselController {
  const pageCount = Math.trunc(_finite(options.pageCount));
  const pageSize = _finite(options.pageSize);
  if (!(pageCount >= 1)) {
    throw new MotionParamError(`behaviors: pageCount must be >= 1, got ${options.pageCount}`);
  }
  if (!(pageSize > 0)) {
    throw new MotionParamError(`behaviors: pageSize must be positive finite, got ${options.pageSize}`);
  }
  const axis = options.axis ?? 'x';
  const rtl = options.rtl === true;
  const velThresh =
    typeof options.velocityThreshold === 'number' && Number.isFinite(options.velocityThreshold)
      ? Math.abs(options.velocityThreshold)
      : DEFAULT_CAROUSEL_VELOCITY;
  const springParams = options.spring ?? (springTokens.snappy as SpringParams);
  validateSpringParams(springParams);

  const clampIndex = (i: number): number => Math.max(0, Math.min(pageCount - 1, i));
  const startIndex = clampIndex(Math.round(_finite(options.index ?? 0)));

  const base = _createBase<CarouselState>(
    { value: startIndex * pageSize, velocity: 0, phase: 'idle', index: startIndex },
    options.requestFrame,
    options.matchMedia,
  );

  let dragging = false;
  let grabPointer = 0;
  let grabValue = 0;
  let swipeStartIndex = startIndex;

  // Знак перевода pointer-смещения в position-пространство:
  // горизонталь LTR → влево = следующая (position растёт) → −d; RTL → +d;
  // вертикаль → вверх = следующая → −d.
  const posDirSign = axis === 'x' && rtl ? 1 : -1;

  const settleTo = (index: number, velocity: number): void => {
    const i = clampIndex(index);
    const target = i * pageSize;
    base.emit({ phase: 'release' });
    base.runner.settle({
      from: base.state.value,
      velocity,
      target,
      spring: springParams,
      // Единый clock: index выводится из position КАЖДЫЙ кадр (не отдельный счётчик).
      onStep: (v, vel) => base.emit({ value: v, velocity: vel, index: clampIndex(Math.round(v / pageSize)) }),
      onDone: () => base.emit({ value: target, velocity: 0, phase: 'settle', index: i }),
    });
  };

  const ctrl: CarouselController = {
    pointerDown(p: BehaviorPoint): void {
      if (base.destroyed) return;
      const carry = base.runner.running ? base.runner.velocity : 0;
      base.runner.invalidate();
      dragging = true;
      grabPointer = _coord(p, axis);
      grabValue = base.state.value;
      swipeStartIndex = clampIndex(Math.round(base.state.value / pageSize));
      base.tracker.reset();
      // Прайор скорости перехвата в POSITION-пространстве (уже с posDirSign).
      _seedPickup(base.tracker, p, axis, carry * posDirSign);
      base.tracker.push(p);
      base.emit({ phase: 'follow', velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!dragging) return;
      base.tracker.push(p);
      const d = _sub(_coord(p, axis), grabPointer);
      const value = _finite(grabValue + posDirSign * d);
      base.emit({ value, velocity: 0, index: clampIndex(Math.round(value / pageSize)) });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!dragging) return;
      dragging = false;
      base.tracker.push(p);
      const vAxis = axis === 'x' ? base.tracker.velocity().vx : base.tracker.velocity().vy;
      // Скорость в position-пространстве.
      const posVel = posDirSign * vAxis;
      // Проекция момента через ./decay → куда прилетела бы позиция.
      const landing = createDecay({ from: base.state.value, velocity: posVel }).rest;
      let target = Math.round(landing / pageSize);
      // Флик перелистывает минимум на страницу; доводка — максимум ±1 от старта свайпа.
      if (Math.abs(posVel) >= velThresh) target = swipeStartIndex + (posVel > 0 ? 1 : -1);
      target = Math.max(swipeStartIndex - 1, Math.min(swipeStartIndex + 1, target));
      settleTo(target, _finite(posVel));
    },
    pointerCancel(): void {
      if (!dragging) return;
      dragging = false;
      // Детерминизм: доводка к ближайшей странице без скорости.
      settleTo(Math.round(base.state.value / pageSize), 0);
    },
    goTo(index: number): void {
      if (base.destroyed) return;
      dragging = false;
      const carry = base.runner.running ? base.runner.velocity : 0;
      base.runner.invalidate();
      settleTo(Math.round(_finite(index)), carry);
    },
    next(): void {
      ctrl.goTo(base.state.index + 1);
    },
    prev(): void {
      ctrl.goTo(base.state.index - 1);
    },
    subscribe: base.subscribe,
    cancel: base.cancel,
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
  readonly matchMedia?: ((q: string) => MediaQueryList) | undefined;
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
export function createPullToRefresh(options: PullOptions): PullController {
  const threshold = _finite(options.threshold);
  if (!(threshold > 0)) {
    throw new MotionParamError(`behaviors: threshold must be positive finite, got ${options.threshold}`);
  }
  const axis = options.axis ?? 'y';
  const dir: 1 | -1 = options.direction === -1 ? -1 : 1;
  const resistance = _clampFactor(options.resistance, DEFAULT_RUBBER_BAND);
  const springParams = options.spring ?? (springTokens.default as SpringParams);
  validateSpringParams(springParams);
  const pendingPos = _finite(options.pendingPosition ?? threshold);

  const base = _createBase<PullState>(
    { value: 0, velocity: 0, phase: 'idle', pulling: false, armed: false, pending: false },
    options.requestFrame,
    options.matchMedia,
  );

  let dragging = false;
  let grabPointer = 0;

  const springTo = (
    target: number,
    velocity: number,
    onDone: () => void,
    phaseWhileMoving: BehaviorPhase = 'release',
  ): void => {
    base.emit({ phase: phaseWhileMoving });
    base.runner.settle({
      from: base.state.value,
      velocity,
      target,
      spring: springParams,
      onStep: (v, vel) => base.emit({ value: v, velocity: vel }),
      onDone,
    });
  };

  const returnHome = (velocity: number): void => {
    springTo(0, velocity, () =>
      base.emit({ value: 0, velocity: 0, phase: 'idle', pulling: false, armed: false, pending: false }),
    );
  };

  const runRefresh = (velocity: number): void => {
    // Доводка к pendingPosition ТЕМ ЖЕ runner'ом; на финише — pending-удержание.
    base.emit({ pulling: false });
    springTo(pendingPos, velocity, () => {
      base.emit({ value: pendingPos, velocity: 0, phase: 'settle', pending: true, armed: false });
      // Возврат пружиной ПОСЛЕ резолва async — без второго владельца позиции.
      Promise.resolve(options.onRefresh?.()).then(
        () => {
          if (base.destroyed) return;
          returnHome(0);
        },
        () => {
          if (base.destroyed) return;
          returnHome(0); // даже при reject позиция обязана вернуться (не залипнуть)
        },
      );
    });
  };

  const ctrl: PullController = {
    pointerDown(p: BehaviorPoint): void {
      if (base.destroyed || base.state.pending) return; // pending владеет позицией
      base.runner.invalidate();
      dragging = true;
      grabPointer = _coord(p, axis);
      base.tracker.reset();
      base.tracker.push(p);
      base.emit({ phase: 'follow', pulling: true, velocity: 0 });
    },
    pointerMove(p: BehaviorPoint): void {
      if (!dragging) return;
      base.tracker.push(p);
      // Сырая протяжка в направлении dir; обратное — 0 (это не pull).
      const rawPull = dir * _sub(_coord(p, axis), grabPointer);
      const value = rawPull > 0 ? _finite(rawPull * resistance) : 0;
      base.emit({ value, velocity: 0, armed: value >= threshold });
    },
    pointerUp(p: BehaviorPoint): void {
      if (!dragging) return;
      dragging = false;
      base.tracker.push(p);
      const vAxis = axis === 'x' ? base.tracker.velocity().vx : base.tracker.velocity().vy;
      const pullVel = dir * vAxis * resistance;
      if (base.state.armed) runRefresh(_finite(pullVel));
      else returnHome(_finite(pullVel));
    },
    pointerCancel(): void {
      if (!dragging) return;
      dragging = false;
      // Детерминизм: перехват возвращает домой без активации refresh.
      returnHome(0);
    },
    subscribe: base.subscribe,
    cancel: base.cancel,
    destroy: base.destroy,
    get state(): PullState {
      return base.state;
    },
  };
  if (options.onChange) ctrl.subscribe(options.onChange);
  return ctrl;
}
