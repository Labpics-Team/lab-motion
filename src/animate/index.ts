/**
 * animate/index.ts — одно-строчный DOM-фасад (subpath ./animate).
 *
 * Subpath export: import { animate } from '@labpics/motion/animate'
 *
 * ЗАЧЕМ: паритет DX с Motion/anime.js v4 — `animate(el, { x: 100 })` вместо
 * ручной сборки MotionValue/drive/CompositorSpring. Фасад НЕ добавляет физики:
 * вся математика — существующие ядро и субпути (см. карту ниже), здесь только
 * DOM-склейка (цели, каналы, реестр прерываний, маршрутизация путей).
 *
 * Карта переиспользования (ядро не тронуто ни байтом):
 *   ./compositor — readCompositorSpring (аналитика кадра и C¹-ретаргета),
 *                  compileSpringPlan (WAAPI-план), resolveCompositorTier (авто-tier);
 *   ./value      — parse/interpolate (цвета/юниты), buildTransform (шортхенды);
 *   ./tokens     — дефолты: spring.default | duration.normal + easing.standard;
 *   ./stagger    — каскад задержек (число = gap, конфиг — как есть).
 *
 * Маршрутизация (авто-tier, решение на вызов):
 *   reduced       → единая снап-политика пакета (мгновенный финал, без кадров);
 *   compositor    → spring-режим + transform/opacity → Element.animate
 *                   (вся кривая в linear()-easing, ноль работы main-потока);
 *   иначе         → main-thread rAF-микроцикл (та же замкнутая форма).
 *
 * Инварианты (наследуют ядро): SSR-safe импорт (DOM — только в вызове,
 * селектор резолвится через document.querySelectorAll В МОМЕНТ вызова);
 * финитность (NaN/∞ → ранний MotionParamError, в стиль не эмитятся);
 * детерминизм (время только через инжектируемый requestFrame/now/setTimer);
 * повторный animate на том же элементе/свойстве — прерывание с подхватом
 * скорости (канон MotionValue smooth-pickup, C¹ на обоих путях).
 */

import { resolveCompositorTier, type SetTimerFn } from '../compositor/index.js';
import { MotionParamError } from '../errors.js';
import { FIXED_DT_S } from '../internal/constants.js';
import { type SpringParams, validateSpringParams } from '../spring.js';
import { stagger, type StaggerOptions } from '../stagger/index.js';
import {
  duration as durationTokens,
  easing as easingTokens,
  spring as springTokens,
} from '../tokens/index.js';
import { interpolate } from '../value/index.js';
import {
  bindGroup,
  formatTransform,
  groupRecord,
  parseProps,
  type AnimatableElement,
  type BoundGroup,
  type ChannelSpec,
  type GroupKey,
} from './channels.js';
import { MainUnit, type MotionMode, type RequestFrameFn } from './main-unit.js';
import { WaapiUnit, type WaapiTarget } from './waapi-unit.js';

// ─── Публичные типы ──────────────────────────────────────────────────────────

export type { AnimatableElement };

/** Цель: элемент, список (Array/NodeList) или CSS-селектор (резолв в вызове). */
export type AnimateTarget =
  | AnimatableElement
  | string
  | ArrayLike<AnimatableElement>
  | readonly AnimatableElement[];

/** Значение канала: цель или пара [from, to] (явный from отключает подхват). */
export type AnimatePropValue =
  | number
  | string
  | readonly [number | string, number | string];

/** Каналы движения: transform-шортхенды, opacity, любые CSS-свойства. */
export type AnimateProps = Record<string, AnimatePropValue>;

/** Опции animate(). spring и duration/ease взаимоисключающие. */
export interface AnimateOptions {
  /** Пружина (дефолт режима: tokens spring.default). */
  readonly spring?: SpringParams | undefined;
  /** Длительность tween (мс). Задана → режим tween (дефолт ease: standard). */
  readonly duration?: number | undefined;
  /** Изинг tween t∈[0,1]→прогресс. Задан без duration → duration.normal. */
  readonly ease?: ((t: number) => number) | undefined;
  /** Задержка старта (мс, ≥ 0) — всем целям. */
  readonly delay?: number | undefined;
  /** Каскад для многих целей: число = gap (мс) или конфиг ./stagger. */
  readonly stagger?: number | StaggerOptions | undefined;
  /** Вызывается один раз, когда ВСЕ цели осели естественно (не cancel). */
  readonly onComplete?: (() => void) | undefined;
  /** Шов кадра main-пути (детерминизм тестов). Дефолт: rAF / setTimeout-шим. */
  readonly requestFrame?: RequestFrameFn | undefined;
  /** Шов reduced-motion. Дефолт: globalThis.matchMedia (если среда умеет). */
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  /** Часы (мс) compositor-пути. Дефолт: performance.now / Date.now. */
  readonly now?: (() => number) | undefined;
  /** Таймер compositor-finished. Дефолт: setTimeout/clearTimeout. */
  readonly setTimer?: SetTimerFn | undefined;
}

/** Контролы прогона (для группы целей — агрегированные). */
export interface AnimateControls {
  /** Резолвится при завершении всех целей (естественном или прерывании). */
  readonly finished: Promise<void>;
  /** Возобновить после pause(). */
  play(): void;
  /** Заморозить в текущей позиции (кадры не эмитятся). */
  pause(): void;
  /** Перемотать к виртуальному времени анимации (мс) с немедленным эмитом. */
  seek(tMs: number): void;
  /** Остановить в текущей позиции; finished резолвится. */
  cancel(): void;
  /** Алиас cancel() (канон driver). */
  stop(): void;
}

// ─── Внутренние контракты ────────────────────────────────────────────────────

/** Общий интерфейс юнитов обоих движков (fan-out контролов). */
interface UnitControls {
  readonly finished: Promise<void>;
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  cancel(): void;
}

const NOOP_UNIT: Omit<UnitControls, 'finished'> = {
  play() {},
  pause() {},
  seek() {},
  cancel() {},
};

// ─── Дефолтные швы (читаются в вызове — SSR-safe) ────────────────────────────

function defaultRequestFrame(cb: (ts?: number) => void): number {
  if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(cb);
  return setTimeout(cb, FIXED_DT_S * 1000) as unknown as number;
}

function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

function defaultSetTimer(cb: () => void, ms: number): () => void {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
}

function defaultMatchMedia():
  | ((query: string) => { matches: boolean })
  | undefined {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === 'function' ? mm.bind(globalThis) : undefined;
}

// ─── Разбор опций ────────────────────────────────────────────────────────────

function resolveMode(options: AnimateOptions): MotionMode {
  const hasSpring = options.spring !== undefined;
  const hasTween = options.duration !== undefined || options.ease !== undefined;
  if (hasSpring && hasTween) {
    throw new MotionParamError(
      `animate: опции spring и duration/ease взаимоисключающие — выберите один режим движения`,
    );
  }
  if (hasTween) {
    const durationMs = options.duration ?? durationTokens.normal;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new MotionParamError(
        `animate: duration должен быть конечным и > 0 (мс), получено ${String(options.duration)}`,
      );
    }
    const ease = options.ease ?? easingTokens.standard.fn;
    if (typeof ease !== 'function') {
      throw new MotionParamError(`animate: ease должен быть функцией t∈[0,1]→число`);
    }
    return { type: 'tween', durationMs, ease };
  }
  const spring = options.spring ?? springTokens.default;
  validateSpringParams(spring);
  return { type: 'spring', spring };
}

function resolveDelay(options: AnimateOptions): number {
  const delay = options.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new MotionParamError(
      `animate: delay должен быть конечным и >= 0 (мс), получено ${String(options.delay)}`,
    );
  }
  return delay;
}

function resolveStaggerDelays(options: AnimateOptions, count: number): number[] {
  const s = options.stagger;
  if (s === undefined) return new Array<number>(count).fill(0);
  if (typeof s === 'number') {
    if (!Number.isFinite(s) || s < 0) {
      throw new MotionParamError(
        `animate: stagger-шаг должен быть конечным и >= 0 (мс), получено ${String(s)}`,
      );
    }
    return stagger(count, { gap: s });
  }
  return stagger(count, s); // конфиг ./stagger стерилизует входы сам
}

// ─── Резолв целей (в момент вызова — SSR-safe импорт) ────────────────────────

function isElementLike(t: unknown): t is AnimatableElement {
  const style = (t as { style?: unknown } | null)?.style as
    | { setProperty?: unknown; getPropertyValue?: unknown }
    | undefined;
  return (
    style !== undefined &&
    style !== null &&
    typeof style.setProperty === 'function' &&
    typeof style.getPropertyValue === 'function'
  );
}

function resolveTargets(target: unknown): AnimatableElement[] {
  if (typeof target === 'string') {
    const doc = (globalThis as { document?: { querySelectorAll?: (s: string) => unknown } })
      .document;
    if (doc === undefined || typeof doc.querySelectorAll !== 'function') {
      throw new MotionParamError(
        `animate: селектор '${target}' требует document, а в этой среде его нет — ` +
          `селектор резолвится в момент вызова (импорт SSR-safe); передайте элемент(ы) напрямую`,
      );
    }
    return collectArrayLike(doc.querySelectorAll(target));
  }
  if (target !== null && typeof target === 'object' && 'length' in (target as object)) {
    return collectArrayLike(target);
  }
  if (isElementLike(target)) return [target];
  throw new MotionParamError(
    `animate: цель должна быть Element, списком элементов или строкой-селектором`,
  );
}

function collectArrayLike(list: unknown): AnimatableElement[] {
  const arr = list as ArrayLike<unknown>;
  const n = typeof arr.length === 'number' && Number.isFinite(arr.length) ? arr.length : 0;
  const out: AnimatableElement[] = [];
  for (let i = 0; i < n; i++) {
    const el = arr[i];
    if (!isElementLike(el)) {
      throw new MotionParamError(`animate: цель #${i} не элемент (нет style.setProperty)`);
    }
    out.push(el);
  }
  return out;
}

// ─── Группировка спецификаций ────────────────────────────────────────────────

function groupSpecs(specs: readonly ChannelSpec[]): Map<GroupKey, ChannelSpec[]> {
  const groups = new Map<GroupKey, ChannelSpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec.group);
    if (list === undefined) groups.set(spec.group, [spec]);
    else list.push(spec);
  }
  return groups;
}

// ─── Снап (единая reduced-политика пакета: мгновенный финал, без кадров) ─────

function snapGroup(el: AnimatableElement, group: GroupKey, bound: BoundGroup): void {
  const rec = groupRecord(el, group);
  if (group === 'transform') {
    const live = new Map<string, number>();
    for (const ch of bound.numeric) live.set(ch.key, ch.to);
    el.style.setProperty('transform', formatTransform(bound.residuals, live));
  } else if (bound.css !== undefined) {
    rec.cssValue = interpolate(bound.css.fromAst, bound.css.toAst, 1);
    el.style.setProperty(group, String(rec.cssValue));
  } else {
    el.style.setProperty(group, String(bound.numeric[0]!.to));
  }
  for (const ch of bound.numeric) rec.numeric.set(ch.key, { value: ch.to, velocity: 0 });
  bound.residuals.forEach((v, k) => {
    if (!rec.numeric.has(k)) rec.numeric.set(k, { value: v, velocity: 0 });
  });
}

// ─── animate ─────────────────────────────────────────────────────────────────

/**
 * Анимирует элемент(ы) к целям props одной строкой.
 *
 * @param target  Element | список | CSS-селектор (резолв в момент вызова).
 * @param props   Каналы: x/y/scale/rotate/… (шортхенды transform), opacity,
 *                любые CSS-свойства; значение — цель или пара [from, to].
 * @param options { spring } ИЛИ { duration, ease }; delay; stagger; onComplete.
 * @returns Контролы { finished, play, pause, seek, cancel, stop }.
 * @throws {MotionParamError} рано, ДО записей в стиль: не-конечные числа,
 *         'transform' целиком, конфликт режимов, селектор без document.
 */
export function animate(
  target: AnimateTarget,
  props: AnimateProps,
  options: AnimateOptions = {},
): AnimateControls {
  // 1. Валидация — вся ДО побочных эффектов (ноль записей при броске).
  const mode = resolveMode(options);
  const baseDelay = resolveDelay(options);
  const specs = parseProps(props);
  const els = resolveTargets(target);
  const staggerDelays = resolveStaggerDelays(options, els.length);

  const matchMedia = options.matchMedia ?? defaultMatchMedia();
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const now = options.now ?? defaultNow;
  const setTimer = options.setTimer ?? defaultSetTimer;

  // 2. Агрегация завершения: onComplete — один раз, когда ВСЕ юниты осели
  //    естественно; cancel/прерывание резолвит finished без onComplete.
  const units: UnitControls[] = [];
  let total = 0;
  let done = 0;
  let natural = 0;
  let setupDone = false;
  let completed = false;
  const maybeComplete = (): void => {
    if (!completed && setupDone && done === total && natural === total) {
      completed = true;
      options.onComplete?.();
    }
  };
  const report = (nat: boolean): void => {
    done++;
    if (nat) natural++;
    maybeComplete();
  };

  // 3. По целям и группам: подхват живого прогона → маршрут → юнит.
  const groups = groupSpecs(specs);
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    const delayMs = baseDelay + (staggerDelays[i] ?? 0);
    const tier = resolveCompositorTier({
      target: el,
      matchMedia,
      requestFrame: options.requestFrame,
    });
    for (const [group, list] of groups) {
      const rec = groupRecord(el, group);
      const bound = bindGroup(el, group, list, rec);
      rec.owner?.supersede(); // прерывание с подхватом: состояние уже снято выше
      if (tier === 'reduced') {
        snapGroup(el, group, bound);
        total++;
        units.push({ finished: Promise.resolve(), ...NOOP_UNIT });
        report(true);
        continue;
      }
      const compositorEligible =
        tier === 'compositor' &&
        mode.type === 'spring' &&
        (group === 'transform' || group === 'opacity');
      total++;
      if (compositorEligible) {
        const unit = new WaapiUnit({
          el: el as WaapiTarget,
          group,
          record: rec,
          numeric: bound.numeric,
          residuals: bound.residuals,
          spring: mode.spring,
          delayMs,
          now,
          setTimer,
          onDone: report,
        });
        rec.owner = unit;
        units.push(unit);
      } else {
        const unit = new MainUnit({
          el,
          group,
          record: rec,
          numeric: bound.numeric,
          css: bound.css,
          residuals: bound.residuals,
          mode,
          delayMs,
          requestFrame,
          onDone: report,
        });
        rec.owner = unit;
        units.push(unit);
      }
    }
  }
  setupDone = true;
  maybeComplete();

  // 4. Агрегированные контролы (пустой список целей → уже разрешённый no-op).
  const finished = Promise.all(units.map((u) => u.finished)).then(() => undefined);
  return {
    finished,
    play(): void {
      for (const u of units) u.play();
    },
    pause(): void {
      for (const u of units) u.pause();
    },
    seek(tMs: number): void {
      for (const u of units) u.seek(tMs);
    },
    cancel(): void {
      for (const u of units) u.cancel();
    },
    stop(): void {
      for (const u of units) u.cancel();
    },
  };
}
