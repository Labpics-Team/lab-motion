/**
 * scroll/index.ts — headless scroll-математика (subpath ./scroll).
 *
 * Закрывает S10 суперсета: scroll-linked прогресс (страница/контейнер и
 * target-с-офсетами в семантике Motion), scroll-triggered видимость
 * (in-view машина класса IntersectionObserver), скорость скролла и
 * scrub-клей к scrubbable-объектам (timeline.seek/totalDuration).
 *
 * Архитектура: как и ./gestures — ЧИСТАЯ математика на структурных входах.
 * DOM-метрики (scrollTop/scrollHeight/clientHeight/getBoundingClientRect)
 * снимает и передаёт ПОТРЕБИТЕЛЬ:
 *   observer.update({
 *     pos: el.scrollTop, contentLength: el.scrollHeight,
 *     viewportLength: el.clientHeight, t: e.timeStamp / 1000,
 *     targetStart: rect.top, targetSize: rect.height,
 *   });
 * Ось (x/y) выбирается тем, какие метрики переданы. Пиннинг — CSS
 * position:sticky (как документирует Motion), движку код не нужен.
 * ScrollTimeline (hw-accel) — отдельный WAAPI-скоуп, не здесь.
 *
 * Инварианты пакета:
 *   SC1. CSS-safe: любой выход конечен; прогресс всегда ∈ [0,1].
 *   SC2. Zero-DOM/SSR-safe: ни window, ни document — нигде.
 *   SC3. Детерминизм: время только из входных точек {t}.
 *   SC4. Zero runtime deps.
 */

import { trimSlidingWindow } from '../internal/sliding-window.js';

// ─── Общие утилиты ───────────────────────────────────────────────────────────

/** Страж конечности (семантика clampFinite из spring.ts). */
function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Clamp в [0,1] с конечным выходом. */
function clamp01(x: number): number {
  const f = finite(x);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// ─── Прогресс страницы/контейнера ────────────────────────────────────────────

/**
 * Прогресс скролла [0,1] по позиции и длинам.
 * Нескроллируемый контент (contentLength <= viewportLength) → 0
 * (паритет Motion: «нечего скроллить» = путь не начат).
 */
export function scrollProgress(pos: number, contentLength: number, viewportLength: number): number {
  const range = finite(contentLength) - finite(viewportLength);
  if (!(range > 0)) return 0; // вырожденный/невалидный диапазон
  return clamp01(finite(pos) / range);
}

// ─── Target-прогресс с офсетами (семантика Motion offset) ────────────────────

/** Анкер края: имя, доля [0..1] или '<n>px'. */
export type ScrollEdgeAnchor = 'start' | 'center' | 'end' | number | `${number}px`;

/** Пара анкеров «точка target × точка viewport», задающая одну границу диапазона. */
export interface ScrollOffsetPair {
  readonly target: ScrollEdgeAnchor;
  readonly viewport: ScrollEdgeAnchor;
}

/** Метрики скроллера. */
export interface ScrollMetrics {
  /** Текущая позиция скролла (px). */
  readonly pos: number;
  /** Полная длина контента (px). */
  readonly contentLength: number;
  /** Длина вьюпорта скроллера (px). */
  readonly viewportLength: number;
}

/** Разрешить анкер в пиксели от начала измеряемого отрезка длиной len. */
function resolveAnchor(a: ScrollEdgeAnchor, len: number): number {
  if (a === 'start') return 0;
  if (a === 'center') return finite(len) / 2;
  if (a === 'end') return finite(len);
  if (typeof a === 'number') return clamp01(a) * finite(len); // доля
  const px = parseFloat(a);
  return finite(px);
}

/**
 * Прогресс [0,1] прохождения target через viewport между двумя офсет-парами
 * (семантика Motion: ['start end','end start'] = «от входа снизу до выхода
 * сверху»). target.start — в КООРДИНАТАХ КОНТЕНТА (абсолютный px).
 * Вырожденный диапазон → ступенька 0/1 без NaN.
 */
export function resolveTargetProgress(
  metrics: ScrollMetrics,
  target: { readonly start: number; readonly size: number },
  offsets: readonly [ScrollOffsetPair, ScrollOffsetPair],
): number {
  const pos = finite(metrics.pos);
  const vp = finite(metrics.viewportLength);
  const tStart = finite(target.start);
  const tSize = finite(target.size);

  // Позиция скролла, при которой анкер target совпадает с анкером viewport:
  // target.start + anchorT = pos + anchorV  →  pos = target.start + anchorT − anchorV
  const posFor = (pair: ScrollOffsetPair): number =>
    finite(tStart + resolveAnchor(pair.target, tSize) - resolveAnchor(pair.viewport, vp));

  const p0 = posFor(offsets[0]);
  const p1 = posFor(offsets[1]);
  const range = p1 - p0;
  if (!(range > 0)) return pos > p0 ? 1 : 0; // вырожденный/перевёрнутый диапазон — ступенька
  return clamp01((pos - p0) / range);
}

// ─── Скорость скролла ────────────────────────────────────────────────────────

/** Сэмпл позиции скролла: px + время (секунды). */
export interface ScrollSample {
  readonly pos: number;
  readonly t: number;
}

/** 1D-оценщик скорости скролла (px/s) по скользящему окну. */
export interface ScrollVelocityTracker {
  push(s: ScrollSample): void;
  /** Скорость px/s: (последний − первый в окне) / Δt. Всегда конечна; Δt<=0 → 0. */
  velocity(): number;
  reset(): void;
}

const DEFAULT_WINDOW_S = 0.1;

/** Создать трекер скорости скролла (окно по умолчанию 0.1s). */
export function createScrollVelocity(windowSec?: number): ScrollVelocityTracker {
  const win =
    typeof windowSec === 'number' && Number.isFinite(windowSec) && windowSec > 0
      ? windowSec
      : DEFAULT_WINDOW_S;
  let samples: ScrollSample[] = [];
  return {
    push(s: ScrollSample): void {
      const p = { pos: finite(s.pos), t: finite(s.t) };
      samples.push(p);
      samples = trimSlidingWindow(samples, win);
    },
    velocity(): number {
      if (samples.length < 2) return 0;
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = b.t - a.t;
      if (!(dt > 0)) return 0;
      return finite(finite(b.pos - a.pos) / dt);
    },
    reset(): void {
      samples = [];
    },
  };
}

// ─── In-view машина (scroll-triggered) ───────────────────────────────────────

/** Порог видимости: 'some' = любой пиксель, 'all' = целиком, число = доля площади. */
export type InViewAmount = 'some' | 'all' | number;

/** Опции in-view машины. */
export interface InViewOptions {
  /** Порог входа. По умолчанию 'some'. */
  readonly amount?: InViewAmount | undefined;
  /** Расширение вьюпорта (px, отрицательное сужает) — аналог rootMargin. */
  readonly margin?: number | undefined;
  readonly onEnter?: (() => void) | undefined;
  readonly onLeave?: (() => void) | undefined;
}

/** Кадр видимости: позиция target в КООРДИНАТАХ ВЬЮПОРТА (как rect.top). */
export interface InViewUpdate {
  readonly targetStart: number;
  readonly targetSize: number;
  readonly viewportLength: number;
}

/** Машина видимости с однократными enter/leave на смену состояния. */
export interface InViewRecognizer {
  update(m: InViewUpdate): void;
  readonly inView: boolean;
}

/** Создать in-view машину (математика класса IntersectionObserver). */
export function createInView(options?: InViewOptions): InViewRecognizer {
  const amount: InViewAmount =
    options?.amount === 'all' || options?.amount === 'some'
      ? options.amount
      : typeof options?.amount === 'number' && Number.isFinite(options.amount)
        ? clamp01(options.amount)
        : 'some';
  const margin =
    typeof options?.margin === 'number' && Number.isFinite(options.margin) ? options.margin : 0;

  let inView = false;

  return {
    update(m: InViewUpdate): void {
      const start = finite(m.targetStart);
      const size = Math.max(0, finite(m.targetSize));
      const vp = finite(m.viewportLength);
      // Видимая часть target в расширенном вьюпорте [-margin, vp+margin].
      const visible = Math.max(
        0,
        Math.min(start + size, vp + margin) - Math.max(start, -margin),
      );
      const now =
        amount === 'some'
          ? visible > 0
          : amount === 'all'
            ? size > 0 && visible >= size
            : size > 0 && visible >= (amount as number) * size;
      if (now && !inView) {
        inView = true;
        options?.onEnter?.();
      } else if (!now && inView) {
        inView = false;
        options?.onLeave?.();
      }
    },
    get inView(): boolean {
      return inView;
    },
  };
}

// ─── Оркестратор ─────────────────────────────────────────────────────────────

/** Инфо, передаваемое в onProgress. */
export interface ScrollProgressInfo {
  /** Скорость скролла, px/s (по скользящему окну). */
  readonly velocity: number;
  /** Текущая позиция скролла, px. */
  readonly pos: number;
}

/** Опции наблюдателя скролла. */
export interface ScrollObserverOptions {
  /**
   * Офсет-пары target-режима (семантика Motion). Заданы + в update приходит
   * targetStart/targetSize → прогресс по target; иначе — прогресс страницы.
   */
  readonly offset?: readonly [ScrollOffsetPair, ScrollOffsetPair] | undefined;
  /** Порог in-view (только target-режим). */
  readonly amount?: InViewAmount | undefined;
  /** Расширение вьюпорта для in-view (px). */
  readonly margin?: number | undefined;
  /** Окно оценки скорости (секунды). */
  readonly windowSec?: number | undefined;
  readonly onProgress?: ((progress: number, info: ScrollProgressInfo) => void) | undefined;
  readonly onEnter?: (() => void) | undefined;
  readonly onLeave?: (() => void) | undefined;
}

/** Кадр обновления наблюдателя. Метрики оси выбирает потребитель. */
export interface ScrollObserverUpdate extends ScrollMetrics {
  /** Время кадра (секунды, напр. e.timeStamp/1000) — для скорости. */
  readonly t?: number | undefined;
  /**
   * Позиция target в координатах ВЬЮПОРТА СКРОЛЛЕРА. Для скролла окна —
   * rect.top / rect.left; для контейнерного скроллера — разность:
   * targetRect.top − containerRect.top (rect.top сам по себе даёт координаты
   * вьюпорта БРАУЗЕРА и для контейнера будет неверен).
   */
  readonly targetStart?: number | undefined;
  /** Размер target по оси (rect.height / rect.width). */
  readonly targetSize?: number | undefined;
}

/** Наблюдатель скролла: прогресс + скорость + enter/leave одним update-каналом. */
export interface ScrollObserver {
  update(m: ScrollObserverUpdate): void;
}

/** Создать наблюдатель скролла (страничный или target-режим). */
export function createScrollObserver(options?: ScrollObserverOptions): ScrollObserver {
  const tracker = createScrollVelocity(options?.windowSec);
  const inView = createInView({
    amount: options?.amount,
    margin: options?.margin,
    onEnter: options?.onEnter,
    onLeave: options?.onLeave,
  });

  return {
    update(m: ScrollObserverUpdate): void {
      const pos = finite(m.pos);
      if (typeof m.t === 'number') tracker.push({ pos, t: m.t });

      const hasTarget =
        typeof m.targetStart === 'number' && typeof m.targetSize === 'number';

      if (hasTarget) {
        inView.update({
          targetStart: m.targetStart as number,
          targetSize: m.targetSize as number,
          viewportLength: m.viewportLength,
        });
      }

      if (options?.onProgress) {
        let p: number;
        if (hasTarget && options.offset) {
          // targetStart приходит в координатах вьюпорта → в координаты контента.
          const contentStart = pos + finite(m.targetStart as number);
          p = resolveTargetProgress(m, { start: contentStart, size: m.targetSize as number }, options.offset);
        } else {
          p = scrollProgress(m.pos, m.contentLength, m.viewportLength);
        }
        options.onProgress(p, { velocity: tracker.velocity(), pos });
      }
    },
  };
}

// ─── Scrub-клей ──────────────────────────────────────────────────────────────

/** Scrubbable-цель: timeline (`createTimeline`) или совместимый объект. */
export interface ScrubTarget {
  readonly totalDuration: number;
  seek(t: number): void;
}

/**
 * Клей «прогресс → seek»: маппит [0,1] в виртуальное время цели.
 * Пример: `observer = createScrollObserver({ onProgress: scrubBinding(tl) })`.
 * Вход клампится: NaN → 0, за пределами [0,1] → края (SC1).
 */
export function scrubBinding(target: ScrubTarget): (progress: number) => void {
  return (progress: number): void => {
    target.seek(clamp01(progress) * finite(target.totalDuration));
  };
}
