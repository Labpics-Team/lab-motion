/**
 * flip/index.ts — FLIP-математика и драйвер (subpath ./flip).
 *
 * Закрывает S12 суперсета: layout-анимация по технике FLIP
 * (First-Last-Invert-Play — фирменный класс Motion `layout`) —
 * элемент уже стоит на НОВОМ месте, а визуально «доезжает» со старого
 * чистым transform'ом (без reflow на каждом кадре), плюс фирменная
 * коррекция scale-искажений (border-radius / counter-scale детей).
 *
 * Архитектура: headless — измерения (getBoundingClientRect) делает
 * ПОТРЕБИТЕЛЬ до/после перестановки DOM и передаёт два прямоугольника;
 * движок отдаёт числа transform'а в onStep. Ноль DOM внутри.
 *
 *   const fl = createFlip({
 *     onStep: (t) => {
 *       el.style.transform =
 *         `translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})`;
 *       const r = correctRadius(8, t.sx, t.sy);
 *       el.style.borderRadius = `${r.x}px / ${r.y}px`;
 *     },
 *     onRest: () => { el.style.transform = ''; },
 *   });
 *   const first = el.getBoundingClientRect();
 *   // ... DOM переставлен (класс/порядок/размер изменился) ...
 *   const last = el.getBoundingClientRect();
 *   fl.play(first, last);
 *
 * Инварианты пакета:
 *   F1. CSS-safe: все числа transform'а конечны (вырожденные размеры — страж).
 *   F2. Zero-DOM/SSR-safe; швы requestFrame/matchMedia инжектируются.
 *   F3. Детерминизм: время только из ts кадра / FIXED_DT.
 *   F4. Reduced-motion CHARACTER-switch: снап в identity без кадров
 *       (элемент просто оказывается на новом месте).
 *   F5. Zero runtime deps; transform-origin потребителя — '0 0'
 *       (формулы dx/sx выведены для верхнего-левого origin).
 */

import { spring, type SpringParams } from '../spring.js';
import type { RequestFrameFn } from '../motion-value.js';

// ─── Типы и стражи ───────────────────────────────────────────────────────────

/** Прямоугольник (px): срез getBoundingClientRect. */
export interface FlipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Инверсия First→Last: с чего начинается визуальный «доезд». */
export interface FlipInversion {
  /** Смещение из last в first (px). */
  readonly dx: number;
  readonly dy: number;
  /** Масштаб из last в first. */
  readonly sx: number;
  readonly sy: number;
}

/** Значения transform'а на кадре. */
export interface FlipTransform {
  readonly tx: number;
  readonly ty: number;
  readonly sx: number;
  readonly sy: number;
}

/** Страж конечности (семантика clampFinite ядра). */
function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Конечное деление; знаменатель 0/NaN → нейтральный fallback. */
function finiteDiv(num: number, den: number, fallback: number): number {
  const d = finite(den);
  if (d === 0) return fallback;
  return finite(finite(num) / d);
}

function clamp01(x: number): number {
  const f = Number.isNaN(x) ? 0 : x;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// ─── Чистая математика ───────────────────────────────────────────────────────

/**
 * Инверсия FLIP: transform, визуально возвращающий элемент с last на first
 * (transform-origin '0 0'). Вырожденные размеры → страж конечности (F1).
 */
export function computeFlip(first: FlipRect, last: FlipRect): FlipInversion {
  return {
    dx: finite(finite(first.x) - finite(last.x)),
    dy: finite(finite(first.y) - finite(last.y)),
    sx: finiteDiv(first.width, last.width, 1),
    sy: finiteDiv(first.height, last.height, 1),
  };
}

/**
 * Transform на прогрессе p ∈ [0,1]: p=0 — полная инверсия (визуально first),
 * p=1 — identity (элемент на своём новом месте). p клампится; NaN → 0.
 */
export function flipAt(inv: FlipInversion, p: number): FlipTransform {
  const t = clamp01(p);
  const inv1 = 1 - t;
  // «+ 0» схлопывает -0 → +0 (IEEE): в CSS «-0px» валиден, но грязен.
  return {
    tx: finite(inv.dx * inv1) + 0,
    ty: finite(inv.dy * inv1) + 0,
    sx: finite(inv.sx + (1 - inv.sx) * t) + 0,
    sy: finite(inv.sy + (1 - inv.sy) * t) + 0,
  };
}

/**
 * Коррекция border-radius под текущий масштаб: чтобы радиус ВЫГЛЯДЕЛ
 * постоянным (radius px), применить `${x}px / ${y}px` (фирменный класс
 * scale-distortion correction у Motion). Нулевой масштаб → страж.
 */
export function correctRadius(radius: number, sx: number, sy: number): { x: number; y: number } {
  const r = finite(radius);
  return {
    x: finiteDiv(r, sx, r),
    y: finiteDiv(r, sy, r),
  };
}

/**
 * Обратный масштаб для дочернего элемента: родитель скейлится (sx, sy) —
 * ребёнок с counter-scale не искажается.
 */
export function counterScale(sx: number, sy: number): { sx: number; sy: number } {
  return {
    sx: finiteDiv(1, sx, 1),
    sy: finiteDiv(1, sy, 1),
  };
}

// ─── Драйвер ─────────────────────────────────────────────────────────────────

/** Опции драйвера FLIP. */
export interface FlipOptions {
  /** Пружина «доезда». По умолчанию { mass: 1, stiffness: 200, damping: 24 }. */
  readonly spring?: SpringParams | undefined;
  /** Инжектируемый кадровый шов (ts в мс). */
  readonly requestFrame?: RequestFrameFn | undefined;
  /** Инжектируемый matchMedia для prefers-reduced-motion (F4). */
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
  /** Числа transform'а на каждом кадре (F1: всегда конечны). */
  readonly onStep?: ((t: FlipTransform) => void) | undefined;
  /** Полёт завершён (identity достигнута). Ровно один раз на play. */
  readonly onRest?: (() => void) | undefined;
}

/** Контроллер FLIP-полётов. */
export interface FlipControls {
  /** Запустить «доезд» с first на last. Повторный play перехватывает полёт. */
  play(first: FlipRect, last: FlipRect): void;
  /** Заглушить полёт без onRest. */
  cancel(): void;
  readonly playing: boolean;
  /** Прогресс текущего полёта [0,1] (1 — покой/identity). */
  readonly progress: number;
}

const DEFAULT_FLIP_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 24 };
/** Фиксированный шаг, когда шов не дал timestamp (конвенция driver.ts). */
const FLIP_FIXED_DT_S = 1 / 60;
/** Потолок кадров — страховка от вечного цикла (конвенция MAX_FRAMES). */
const FLIP_MAX_FRAMES = 2000;
/** Порог сходимости нормированной пружины (|1−value| и |velocity|). */
const FLIP_REST = 1e-3;

function prefersReducedMotion(matchMedia: ((q: string) => MediaQueryList) | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** Создать контроллер FLIP: пружина 0→1 поверх инверсии, синхронные колбэки. */
export function createFlip(options?: FlipOptions): FlipControls {
  const params = options?.spring ?? DEFAULT_FLIP_SPRING;
  const requestFrame = options?.requestFrame;
  const onStep = options?.onStep;
  const onRest = options?.onRest;

  let playing = false;
  let progress = 1; // покой = identity
  /** Инвалидация кадров перехваченного полёта (класс stale-frame). */
  let generation = 0;

  const emit = (inv: FlipInversion, p: number): void => {
    progress = p;
    onStep?.(flipAt(inv, p));
  };

  return {
    play(first: FlipRect, last: FlipRect): void {
      generation++; // перехват: кадры прежнего полёта инертны
      const gen = generation;
      const inv = computeFlip(first, last);

      // F4: reduced-motion — элемент просто оказывается на новом месте.
      if (prefersReducedMotion(options?.matchMedia)) {
        playing = false;
        emit(inv, 1);
        onRest?.();
        return;
      }

      playing = true;
      progress = 0;
      let elapsed = 0;
      let lastTs: number | undefined;
      let frames = 0;

      const finish = (): void => {
        playing = false;
        emit(inv, 1);
        onRest?.();
      };

      const schedule = (cb: (ts?: number) => void): void => {
        if (!requestFrame) {
          // Без шва и без rAF полёт невозможен честно — identity сразу.
          finish();
          return;
        }
        const handle = requestFrame(cb);
        if (handle === 0) setTimeout(() => cb(undefined), 0); // non-draining шов
      };

      const tick = (ts?: number): void => {
        if (gen !== generation || !playing) return; // stale/отменён
        if (typeof ts === 'number' && Number.isFinite(ts)) {
          elapsed = lastTs === undefined ? elapsed : elapsed + Math.max(0, (ts - lastTs) / 1000);
          lastTs = ts;
        } else {
          elapsed += FLIP_FIXED_DT_S;
        }
        frames++;

        const s = spring(params, elapsed);
        const p = clamp01(s.value);
        const converged =
          (Math.abs(1 - s.value) < FLIP_REST && Math.abs(s.velocity) < FLIP_REST) ||
          frames >= FLIP_MAX_FRAMES;
        if (converged) {
          finish();
          return;
        }
        emit(inv, p);
        schedule(tick);
      };

      // Первый кадр — синхронно у инверсии (без мигания на новом месте).
      emit(inv, 0);
      schedule(tick);
    },
    cancel(): void {
      generation++;
      playing = false;
    },
    get playing(): boolean {
      return playing;
    },
    get progress(): number {
      return progress;
    },
  };
}
