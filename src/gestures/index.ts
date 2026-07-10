/**
 * gestures/index.ts — headless-распознаватели жестов (subpath ./gestures).
 *
 * Слой интеракции движка: press/tap (с клавиатурным путём), hover,
 * pan (порог+оси), drag (границы + rubber-band + инерция через ./decay).
 *
 * Архитектура: распознаватели — ЧИСТЫЕ машины состояний, питающиеся
 * структурными точками {x, y, t}. DOM-событий здесь нет — потребитель
 * (биндинг/приложение) сам транслирует PointerEvent → GesturePoint
 * (`{x: e.clientX, y: e.clientY, t: e.timeStamp / 1000}`). Это даёт
 * бит-в-бит детерминизм в тестах и SSR-безопасность без гвардов.
 *
 * Инварианты пакета:
 *   G1. CSS-safe: все эмитимые числа конечны (clampFinite на каждом выходе).
 *   G2. Zero-DOM/SSR-safe: ни window, ни document на верхнем уровне модуля;
 *       единственный платформенный шов — инжектируемый requestFrame (drag).
 *   G3. Детерминизм: время только из входных точек и requestFrame-шва.
 *   G4. Reduced-motion (drag): CHARACTER-switch — release снапает в точку
 *       покоя физики немедленно (без глайд-кадров), а не отключает движение.
 *   G5. Zero runtime deps: только внутренние примитивы (./decay, канонический
 *       solveSpring/validateSpringParams ядра, errors).
 */

import { createDecay, type DecayModel } from '../decay.js';
import { trimSlidingWindow } from '../internal/sliding-window.js';
import { solveSpring } from '../internal/solver.js';
import { CONVERGENCE_THRESHOLD } from '../internal/constants.js';
import { type SpringParams, validateSpringParams } from '../spring.js';
import type { RequestFrameFn } from '../motion-value.js';

// ─── Общие типы и утилиты ────────────────────────────────────────────────────

/** Точка жеста: координаты (px) + время (СЕКУНДЫ, напр. e.timeStamp/1000). */
export interface GesturePoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** Ось блокировки жеста. */
export type GestureAxis = 'x' | 'y';

/**
 * Страж конечности — зеркалит семантику clampFinite из spring.ts:
 * finite → как есть; NaN → 0; ±∞ → ±MAX_VALUE.
 */
function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Разность с защитой от overflow (|a|+|b|>MAX_VALUE → ±∞ → clamp). */
function finiteSub(a: number, b: number): number {
  return finite(finite(a) - finite(b));
}

// ─── Velocity tracker ────────────────────────────────────────────────────────

/** Оценщик мгновенной скорости указателя по скользящему окну сэмплов. */
export interface VelocityTracker {
  /** Добавить сэмпл (координаты px, время в секундах). */
  push(p: GesturePoint): void;
  /** Скорость (px/s) по окну: (последний − первый в окне) / Δt. Всегда конечна. */
  velocity(): { vx: number; vy: number };
  /** Сбросить все сэмплы. */
  reset(): void;
}

const DEFAULT_VELOCITY_WINDOW_S = 0.1;

/**
 * Создать трекер скорости.
 * Оценка = наклон между первым и последним сэмплом внутри окна `windowSec`
 * (по умолчанию 0.1s) — устойчиво к дрожанию отдельных событий и
 * детерминированно. Δt=0 (одинаковые timestamps) → скорость 0, не NaN.
 */
export function createVelocityTracker(windowSec?: number): VelocityTracker {
  const win =
    typeof windowSec === 'number' && Number.isFinite(windowSec) && windowSec > 0
      ? windowSec
      : DEFAULT_VELOCITY_WINDOW_S;
  let samples: GesturePoint[] = [];

  return {
    push(p: GesturePoint): void {
      const s = { x: finite(p.x), y: finite(p.y), t: finite(p.t) };
      samples.push(s);
      samples = trimSlidingWindow(samples, win);
    },
    velocity(): { vx: number; vy: number } {
      if (samples.length < 2) return { vx: 0, vy: 0 };
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = b.t - a.t;
      if (!(dt > 0)) return { vx: 0, vy: 0 }; // Δt<=0/NaN → нет наклона
      return { vx: finite(finiteSub(b.x, a.x) / dt), vy: finite(finiteSub(b.y, a.y) / dt) };
    },
    reset(): void {
      samples = [];
    },
  };
}

// ─── Press (tap) ─────────────────────────────────────────────────────────────

/** Опции распознавателя нажатия. */
export interface PressOptions {
  /**
   * Допуск дрожания (px): движение СТРОГО дальше slop отменяет нажатие.
   * По умолчанию 3 (паритет порога tap-cancel у Motion).
   */
  readonly slop?: number | undefined;
  readonly onPressStart?: (() => void) | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly onPressCancel?: (() => void) | undefined;
}

/** Машина состояний нажатия: pointer-путь + клавиатурный путь (Enter/Space). */
export interface PressRecognizer {
  pointerDown(p: GesturePoint): void;
  pointerMove(p: GesturePoint): void;
  pointerUp(p: GesturePoint): void;
  pointerCancel(): void;
  /** Клавиатурная доступность: Enter/Space ведут себя как down/up; Escape отменяет. */
  keyDown(key: string): void;
  keyUp(key: string): void;
  readonly pressing: boolean;
}

const DEFAULT_PRESS_SLOP_PX = 3;

/** Создать распознаватель нажатия (tap) с клавиатурным путём. */
export function createPress(options?: PressOptions): PressRecognizer {
  const slop =
    typeof options?.slop === 'number' && Number.isFinite(options.slop) && options.slop >= 0
      ? options.slop
      : DEFAULT_PRESS_SLOP_PX;
  const onStart = options?.onPressStart;
  const onPress = options?.onPress;
  const onCancel = options?.onPressCancel;

  /** 'idle' | 'pointer' | 'key' — активный источник; 'cancelled' ждёт up для сброса. */
  let state: 'idle' | 'pointer' | 'key' | 'cancelled' = 'idle';
  let originX = 0;
  let originY = 0;

  const cancel = (): void => {
    if (state === 'pointer' || state === 'key') {
      state = 'cancelled';
      onCancel?.();
    }
  };

  return {
    pointerDown(p: GesturePoint): void {
      if (state !== 'idle') return;
      state = 'pointer';
      originX = finite(p.x);
      originY = finite(p.y);
      onStart?.();
    },
    pointerMove(p: GesturePoint): void {
      if (state !== 'pointer') return;
      const dx = finiteSub(p.x, originX);
      const dy = finiteSub(p.y, originY);
      // Сравнение квадратов — без sqrt; строгое ">" держит границу slop нажатой.
      if (dx * dx + dy * dy > slop * slop) cancel();
    },
    pointerUp(_p: GesturePoint): void {
      if (state === 'pointer') {
        state = 'idle';
        onPress?.();
      } else if (state === 'cancelled') {
        state = 'idle';
      }
    },
    pointerCancel(): void {
      cancel();
      if (state === 'cancelled') state = 'idle';
    },
    keyDown(key: string): void {
      if (key === 'Enter' || key === ' ') {
        if (state !== 'idle') return; // автоповтор ОС не даёт второго start
        state = 'key';
        onStart?.();
        return;
      }
      if (key === 'Escape') cancel();
    },
    keyUp(key: string): void {
      if (key !== 'Enter' && key !== ' ') return;
      if (state === 'key') {
        state = 'idle';
        onPress?.();
      } else if (state === 'cancelled') {
        state = 'idle';
      }
    },
    get pressing(): boolean {
      return state === 'pointer' || state === 'key';
    },
  };
}

// ─── Hover ───────────────────────────────────────────────────────────────────

/** Опции распознавателя наведения. */
export interface HoverOptions {
  readonly onHoverStart?: (() => void) | undefined;
  readonly onHoverEnd?: (() => void) | undefined;
}

/** Распознаватель наведения; эмулированный touch-hover фильтруется. */
export interface HoverRecognizer {
  /** pointerType из PointerEvent ('mouse'|'pen'|'touch'); touch игнорируется. */
  enter(pointerType?: string): void;
  leave(): void;
  readonly hovering: boolean;
}

/** Создать распознаватель наведения (touch-события не считаются hover'ом). */
export function createHover(options?: HoverOptions): HoverRecognizer {
  let hovering = false;
  return {
    enter(pointerType?: string): void {
      if (pointerType === 'touch') return; // синтетический hover тача — не hover
      if (hovering) return;
      hovering = true;
      options?.onHoverStart?.();
    },
    leave(): void {
      if (!hovering) return;
      hovering = false;
      options?.onHoverEnd?.();
    },
    get hovering(): boolean {
      return hovering;
    },
  };
}

// ─── Pan ─────────────────────────────────────────────────────────────────────

/** Событие панорамирования: смещение от точки pointerDown + скорость. */
export interface PanEvent {
  readonly dx: number;
  readonly dy: number;
  readonly vx: number;
  readonly vy: number;
}

/** Опции распознавателя pan. */
export interface PanOptions {
  /** Порог старта (px), по умолчанию 3 (паритет Motion). */
  readonly threshold?: number | undefined;
  /** Блокировка оси: порог и смещения меряются только по ней, вторая — 0. */
  readonly axis?: GestureAxis | undefined;
  readonly onPanStart?: (() => void) | undefined;
  readonly onPan?: ((e: PanEvent) => void) | undefined;
  readonly onPanEnd?: ((e: PanEvent) => void) | undefined;
}

/** Машина состояний панорамирования. */
export interface PanRecognizer {
  pointerDown(p: GesturePoint): void;
  pointerMove(p: GesturePoint): void;
  pointerUp(p: GesturePoint): void;
  pointerCancel(): void;
  readonly panning: boolean;
}

const DEFAULT_PAN_THRESHOLD_PX = 3;

/** Создать распознаватель pan (порог, оси, скорость на отпускании). */
export function createPan(options?: PanOptions): PanRecognizer {
  const threshold =
    typeof options?.threshold === 'number' && Number.isFinite(options.threshold) && options.threshold >= 0
      ? options.threshold
      : DEFAULT_PAN_THRESHOLD_PX;
  const axis = options?.axis;

  let state: 'idle' | 'pending' | 'panning' = 'idle';
  let originX = 0;
  let originY = 0;
  const tracker = createVelocityTracker();

  const deltas = (p: GesturePoint): { dx: number; dy: number } => {
    const dx = axis === 'y' ? 0 : finiteSub(p.x, originX);
    const dy = axis === 'x' ? 0 : finiteSub(p.y, originY);
    return { dx, dy };
  };

  const makeEvent = (p: GesturePoint, vx: number, vy: number): PanEvent => {
    const { dx, dy } = deltas(p);
    return {
      dx,
      dy,
      vx: finite(axis === 'y' ? 0 : vx),
      vy: finite(axis === 'x' ? 0 : vy),
    };
  };

  const end = (p: GesturePoint, velocity: { vx: number; vy: number }): void => {
    if (state === 'panning') options?.onPanEnd?.(makeEvent(p, velocity.vx, velocity.vy));
    state = 'idle';
    tracker.reset();
  };

  let lastPoint: GesturePoint = { x: 0, y: 0, t: 0 };

  return {
    pointerDown(p: GesturePoint): void {
      if (state !== 'idle') return;
      state = 'pending';
      originX = finite(p.x);
      originY = finite(p.y);
      lastPoint = p;
      tracker.reset();
      tracker.push(p);
    },
    pointerMove(p: GesturePoint): void {
      if (state === 'idle') return;
      lastPoint = p;
      tracker.push(p);
      const { dx, dy } = deltas(p);
      if (state === 'pending') {
        // Порог по заблокированной оси или по 2D-дистанции.
        const dist2 = axis ? (axis === 'x' ? dx * dx : dy * dy) : dx * dx + dy * dy;
        if (dist2 >= threshold * threshold) {
          state = 'panning';
          options?.onPanStart?.();
        } else {
          return;
        }
      }
      const v = tracker.velocity();
      options?.onPan?.(makeEvent(p, v.vx, v.vy));
    },
    pointerUp(p: GesturePoint): void {
      if (state === 'idle') return;
      tracker.push(p);
      end(p, tracker.velocity());
    },
    pointerCancel(): void {
      if (state === 'idle') return;
      end(lastPoint, { vx: 0, vy: 0 });
    },
    get panning(): boolean {
      return state === 'panning';
    },
  };
}

// ─── Drag ────────────────────────────────────────────────────────────────────

/** Границы по одной оси (px). */
export interface DragBounds {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

/** Параметры инерции отпускания (прокидываются в createDecay). */
export interface DragInertiaOptions {
  readonly power?: number | undefined;
  readonly timeConstant?: number | undefined;
  readonly restDelta?: number | undefined;
}

/** Опции drag-контроллера. */
export interface DragOptions {
  /** Начальная позиция значения. По умолчанию {x:0, y:0}. */
  readonly from?: { readonly x?: number | undefined; readonly y?: number | undefined } | undefined;
  /** Блокировка оси: вторая ось заморожена. */
  readonly axis?: GestureAxis | undefined;
  /** Границы позиции по осям. */
  readonly bounds?:
    | { readonly x?: DragBounds | undefined; readonly y?: DragBounds | undefined }
    | undefined;
  /**
   * Сопротивление за границей ∈ [0,1]: displayed = bound + overshoot·rubberBand
   * (класс поведения elastic у Motion, дефолт 0.5). 0 = жёсткий clamp.
   */
  readonly rubberBand?: number | undefined;
  /** Инерция отпускания; false = остановиться сразу. По умолчанию включена. */
  readonly inertia?: DragInertiaOptions | false | undefined;
  /**
   * Пружина snap-back на границе глайда (iOS-манера, #93 C2a): при касании
   * bounds инерционным глайдом остаточная скорость НЕ выбрасывается, а
   * наследуется пружиной к границе — C¹ на стыке decay|spring (короткий
   * overshoot за границу и упругий возврат на неё). Отсутствие опции =
   * прежнее поведение: жёсткий clamp, скорость касания гасится.
   * Невалидные параметры → MotionParamError синхронно из createDrag.
   */
  readonly snapBackSpring?: SpringParams | undefined;
  /** Инжектируемый matchMedia для prefers-reduced-motion (G4). */
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
  /** Инжектируемый кадровый шов для глайда (ts в мс). */
  readonly requestFrame?: RequestFrameFn | undefined;
  /** Единственный канал вывода позиции. Значения всегда конечны (G1). */
  readonly onStep?: ((x: number, y: number) => void) | undefined;
  /** Позиция окончательно осела (после глайда/снапа/отпускания). */
  readonly onRest?: ((x: number, y: number) => void) | undefined;
}

/**
 * Внешний прайор скорости захвата (px/s) — шов «compositor → gesture» (#93):
 * элемент летит НЕ нашим глайдом (WAAPI/compositor-ран, чужой аниматор), и
 * потребитель в pointerdown сообщает жесту его живую скорость. Рецепт для
 * compositor-рана (./compositor, БЕЗ чтения DOM):
 *
 *   const read = readCompositorSpring(spring, { from, to, t: elapsedSec });
 *   controller.stop(); // владение переходит жесту
 *   drag.pointerDown(point, { vx: read.velocity });
 *
 * Прямого импорта gestures→compositor нет — субпути ядра независимы; связка
 * живёт у потребителя. Вырожденные компоненты (NaN/±∞/не-число) → ровно 0.
 */
export interface DragPickup {
  readonly vx?: number | undefined;
  readonly vy?: number | undefined;
}

/** Вырожденный внешний прайор → ровно 0 (нет прайора); −0 схлопывается. */
function pickupV(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v + 0 : 0;
}

/** Контроллер перетаскивания. */
export interface DragControls {
  /**
   * Захват. `pickup` — внешний прайор скорости летящего элемента (#93,
   * compositor→gesture): явная передача АВТОРИТЕТНА и замещает внутренний
   * glide-прайор (потребитель знает живую скорость лучше); отсутствие
   * аргумента — прежнее поведение (наследуется скорость активного глайда).
   */
  pointerDown(p: GesturePoint, pickup?: DragPickup): void;
  pointerMove(p: GesturePoint): void;
  pointerUp(p: GesturePoint): void;
  pointerCancel(): void;
  /** Заглушить активный глайд без onRest (аналог cancel). */
  stop(): void;
  readonly x: number;
  readonly y: number;
  readonly dragging: boolean;
  /** true, пока после отпускания идёт инерционный глайд. */
  readonly gliding: boolean;
}

const DEFAULT_RUBBER_BAND = 0.5;
/** Фиксированный шаг глайда, когда шов не дал timestamp (конвенция driver.ts). */
const GLIDE_FIXED_DT_S = 1 / 60;
/** Потолок кадров глайда — страховка от вечного цикла (конвенция MAX_FRAMES). */
const GLIDE_MAX_FRAMES = 2000;
/**
 * Смещение синтетического прайор-сэмпла при pickup летящего объекта (#93 C2b):
 * половина окна трекера — немедленный release наследует скорость глайда почти
 * целиком, а удержание пальца естественно вытесняет прайор из окна (v → 0).
 */
const GLIDE_PICKUP_SEED_DT_S = DEFAULT_VELOCITY_WINDOW_S / 2;

function prefersReducedMotion(matchMedia: ((q: string) => MediaQueryList) | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Создать headless drag-контроллер: интеграция позиции, границы с
 * rubber-band сопротивлением, инерция отпускания через аналитический
 * ./decay и CHARACTER-switch при reduced-motion.
 */
export function createDrag(options?: DragOptions): DragControls {
  const axis = options?.axis;
  const rubberBandRaw = options?.rubberBand;
  const rubberBand =
    typeof rubberBandRaw === 'number' && Number.isFinite(rubberBandRaw)
      ? Math.min(1, Math.max(0, rubberBandRaw))
      : DEFAULT_RUBBER_BAND;
  const inertia = options?.inertia;
  const snapBack = options?.snapBackSpring;
  // Fail-fast как у всех пружинных входов ядра: невалидная пружина не должна
  // дожить до первого касания границы (там она молча зациклила бы глайд).
  if (snapBack !== undefined) validateSpringParams(snapBack);
  const requestFrame: RequestFrameFn | undefined = options?.requestFrame;
  const onStep = options?.onStep;
  const onRest = options?.onRest;

  // Текущая ЛОГИЧЕСКАЯ позиция (raw, до rubber-band) и отображаемая.
  let rawX = finite(options?.from?.x ?? 0);
  let rawY = finite(options?.from?.y ?? 0);
  let dispX = rawX;
  let dispY = rawY;

  let dragging = false;
  let gliding = false;
  /** Инвалидация кадров глайда при перехвате (класс stale-frame, как в MotionValue). */
  let generation = 0;
  /** Текущая скорость активного глайда (px/s) — прайор для pickup (#93 C2b). */
  let glideVx = 0;
  let glideVy = 0;

  // Точка pointerDown и позиция на момент захвата.
  let grabPointerX = 0;
  let grabPointerY = 0;
  let grabRawX = 0;
  let grabRawY = 0;

  const tracker = createVelocityTracker();

  const boundsFor = (a: GestureAxis): DragBounds | undefined =>
    a === 'x' ? options?.bounds?.x : options?.bounds?.y;

  /** Применить границы с rubber-band к одной координате. */
  const applyBounds = (a: GestureAxis, raw: number, rb: number): number => {
    const b = boundsFor(a);
    if (!b) return finite(raw);
    const v = finite(raw);
    const min = typeof b.min === 'number' && Number.isFinite(b.min) ? b.min : -Infinity;
    const max = typeof b.max === 'number' && Number.isFinite(b.max) ? b.max : Infinity;
    if (v > max) return finite(max + (v - max) * rb);
    if (v < min) return finite(min + (v - min) * rb);
    return v;
  };

  /** Жёсткий clamp (для глайда и снапов — rubber-band только под пальцем). */
  const hardClamp = (a: GestureAxis, raw: number): number => applyBounds(a, raw, 0);

  const emit = (): void => {
    onStep?.(dispX, dispY);
  };

  const settle = (): void => {
    gliding = false;
    onRest?.(dispX, dispY);
  };

  /** Инерционный глайд после отпускания: decay по каждой оси, hard-clamp на границах. */
  const startGlide = (vx: number, vy: number): void => {
    const inertiaOpts = inertia === false ? undefined : inertia;
    const mm = options?.matchMedia;

    // Модели затухания по осям (ось заморожена → скорость 0 → rest = from).
    const dx = createDecay({
      from: dispX,
      velocity: axis === 'y' ? 0 : finite(vx),
      power: inertiaOpts?.power,
      timeConstant: inertiaOpts?.timeConstant,
      restDelta: inertiaOpts?.restDelta,
    });
    const dy = createDecay({
      from: dispY,
      velocity: axis === 'x' ? 0 : finite(vy),
      power: inertiaOpts?.power,
      timeConstant: inertiaOpts?.timeConstant,
      restDelta: inertiaOpts?.restDelta,
    });

    // G4: reduced-motion — снап в (клампнутую) точку покоя без кадров.
    if (prefersReducedMotion(mm)) {
      rawX = dispX = hardClamp('x', dx.rest);
      rawY = dispY = hardClamp('y', dy.rest);
      emit();
      settle();
      return;
    }

    /**
     * Per-axis траектория глайда: фаза decay → (опционально) фаза spring.
     * Без snapBackSpring поведение прежнее БИТ-В-БИТ (characterization-пин):
     * hard-clamp на границе и оседание оси в кадре касания.
     * Со snapBackSpring: в кадре первого выхода decay за границу ось
     * переключается на пружину к границе через канонический
     * solveSpring(params, t, v0) (тот же, что smooth-pickup MotionValue):
     * from = сырое значение decay за границей, target = граница,
     * v0n = velocityAt(касания) / range — нормировка даёт знак «к границе»
     * автоматически. Стык C¹: значение стыка лежит на той же decay-траектории,
     * v0 пружины — её же аналитическая производная.
     */
    const makeAxis = (a: GestureAxis, model: DecayModel) => {
      let t0 = -1; // <0 — фаза decay; иначе elapsed старта пружины
      let from = 0;
      let target = 0;
      let v0n = 0;
      return (elapsed: number): { v: number; vel: number; done: boolean } => {
        if (t0 >= 0) {
          const range = target - from;
          const s = solveSpring(snapBack as SpringParams, elapsed - t0, v0n);
          const val = from + s.value * range;
          const vel = s.velocity * range;
          const denom = Math.abs(range); // > 0 по построению (raw строго за границей)
          // Сходимость как в ядре (относительный CONVERGENCE_THRESHOLD) либо
          // non-finite-страж: единственный безопасный исход — снап на границу.
          if (
            !Number.isFinite(val) ||
            !Number.isFinite(vel) ||
            (Math.abs(val - target) / denom < CONVERGENCE_THRESHOLD &&
              Math.abs(vel) / denom < CONVERGENCE_THRESHOLD)
          ) {
            return { v: target, vel: 0, done: true };
          }
          return { v: finite(val), vel: finite(vel), done: false };
        }
        const raw = model.valueAt(elapsed);
        const clamped = hardClamp(a, raw);
        if (snapBack !== undefined && clamped !== raw) {
          t0 = elapsed;
          from = raw;
          target = clamped;
          v0n = model.velocityAt(elapsed) / (clamped - raw);
          return { v: finite(raw), vel: finite(model.velocityAt(elapsed)), done: false };
        }
        return {
          v: clamped,
          vel: clamped === raw ? finite(model.velocityAt(elapsed)) : 0,
          done: model.isSettledAt(elapsed) || clamped !== raw,
        };
      };
    };
    const axX = makeAxis('x', dx);
    const axY = makeAxis('y', dy);

    gliding = true;
    generation++;
    const gen = generation;
    glideVx = dx.velocityAt(0);
    glideVy = dy.velocityAt(0);
    let elapsed = 0;
    let lastTs: number | undefined;
    let frames = 0;

    const schedule = (cb: (ts?: number) => void): void => {
      if (!requestFrame) {
        // Без шва и без rAF глайд невозможен честно — оседаем сразу в clamp(rest).
        rawX = dispX = hardClamp('x', dx.rest);
        rawY = dispY = hardClamp('y', dy.rest);
        emit();
        settle();
        return;
      }
      const handle = requestFrame(cb);
      if (handle === 0) setTimeout(() => cb(undefined), 0); // non-draining шов (конвенция repo)
    };

    const tick = (ts?: number): void => {
      if (gen !== generation || !gliding) return; // stale-кадр после перехвата/stop
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        elapsed = lastTs === undefined ? elapsed : elapsed + Math.max(0, (ts - lastTs) / 1000);
        lastTs = ts;
      } else {
        elapsed += GLIDE_FIXED_DT_S;
      }
      frames++;

      const rx = axX(elapsed);
      const ry = axY(elapsed);
      rawX = dispX = rx.v;
      rawY = dispY = ry.v;
      glideVx = rx.vel;
      glideVy = ry.vel;
      emit();

      if ((rx.done && ry.done) || frames >= GLIDE_MAX_FRAMES) {
        settle();
        return;
      }
      schedule(tick);
    };

    schedule(tick);
  };

  return {
    pointerDown(p: GesturePoint, pickup?: DragPickup): void {
      // Прайор скорости нового жеста: явный внешний (compositor→gesture, #93)
      // авторитетен и замещает внутренний целиком; иначе — скорость глайда.
      const pickupVx = pickup !== undefined ? pickupV(pickup.vx) : gliding ? glideVx : 0;
      const pickupVy = pickup !== undefined ? pickupV(pickup.vy) : gliding ? glideVy : 0;
      generation++; // перехват: гасим возможный глайд
      gliding = false;
      dragging = true;
      grabPointerX = finite(p.x);
      grabPointerY = finite(p.y);
      grabRawX = rawX;
      grabRawY = rawY;
      tracker.reset();
      // C¹-pickup летящего объекта (#93 C2b): скорость активного глайда —
      // прайор нового жеста. Засев через штатную sliding-window механику
      // трекера: синтетический сэмпл на полокна назад вдоль скорости глайда.
      // Немедленный release без движения продолжает движение (не убивает его);
      // сэмплы реального движения вытесняют прайор из окна как обычно.
      if (pickupVx !== 0 || pickupVy !== 0) {
        tracker.push({
          x: finite(p.x) - pickupVx * GLIDE_PICKUP_SEED_DT_S,
          y: finite(p.y) - pickupVy * GLIDE_PICKUP_SEED_DT_S,
          t: finite(p.t) - GLIDE_PICKUP_SEED_DT_S,
        });
      }
      tracker.push(p);
    },
    pointerMove(p: GesturePoint): void {
      if (!dragging) return;
      tracker.push(p);
      if (axis !== 'y') rawX = finite(grabRawX + finiteSub(p.x, grabPointerX));
      if (axis !== 'x') rawY = finite(grabRawY + finiteSub(p.y, grabPointerY));
      dispX = applyBounds('x', rawX, rubberBand);
      dispY = applyBounds('y', rawY, rubberBand);
      emit();
    },
    pointerUp(p: GesturePoint): void {
      if (!dragging) return;
      dragging = false;
      tracker.push(p);
      const v = tracker.velocity();
      if (inertia === false) {
        // Без инерции: rubber-banded позиция оседает на границе.
        rawX = dispX = hardClamp('x', dispX);
        rawY = dispY = hardClamp('y', dispY);
        emit();
        settle();
        return;
      }
      startGlide(v.vx, v.vy);
    },
    pointerCancel(): void {
      // Единая семантика «системный перехват указателя»: осесть где стоишь
      // (клампнуто) — и при активном drag, и при инерционном глайде.
      if (gliding) {
        generation++; // инвалидировать уже запланированный кадр глайда
        rawX = dispX = hardClamp('x', dispX);
        rawY = dispY = hardClamp('y', dispY);
        emit();
        settle();
        return;
      }
      if (!dragging) return;
      dragging = false;
      rawX = dispX = hardClamp('x', dispX);
      rawY = dispY = hardClamp('y', dispY);
      emit();
      settle();
    },
    /**
     * Заглушить активный ГЛАЙД без onRest (тихая отмена инерции).
     * Скоуп: только глайд. Во время активного drag (палец на элементе) —
     * сознательный no-op: жест владеет позицией, обрывать его силой нельзя
     * (поведение запинено тестом «stop() во время АКТИВНОГО drag»).
     */
    stop(): void {
      generation++;
      gliding = false;
    },
    get x(): number {
      return dispX;
    },
    get y(): number {
      return dispY;
    },
    get dragging(): boolean {
      return dragging;
    },
    get gliding(): boolean {
      return gliding;
    },
  };
}
