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
 *   internal defaults — тот же SSOT, что spring.default/duration.base/easing.standard;
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

import {
  type SetTimerFn,
} from '../compositor/core.js';
import {
  prefersReduced,
  resolveCompositorTierCodeFromCapability,
  type CompositorTierCode,
} from '../compositor/detect.js';
import {
  DEFAULT_TOLERANCE,
  tryCompileSpringExecutionArtifactTupleUnchecked,
  type SpringExecutionArtifactTuple,
} from '../compositor/curve.js';
import { MotionParamError } from '../errors.js';
import {
  DEFAULT_DURATION_MS,
  DEFAULT_SPRING,
  STANDARD_EASING,
} from '../internal/motion-defaults.js';
import { type SpringParams, validateSpringParams } from '../spring.js';
import type { StaggerOptions } from '../stagger/index.js';
import { scheduleStagger } from '../stagger/scheduler.js';
import { buildTransform } from '../value/transform.js';
import {
  bindGroup,
  cssAt,
  dominantV0,
  groupRecord,
  parseProps,
  type AnimatableElement,
  type BoundGroup,
  type ChannelSpec,
  type GroupKey,
  type GroupOwner,
  type GroupRecord,
} from './channels.js';
import {
  MainUnit,
  type MotionMode,
  type RequestFrameFn,
} from './main-unit.js';
import { surfaceBatchFor, type SurfaceBatch } from './surface-batch.js';
import {
  collectBoundedArrayLike,
  requireAnimateOptions,
  requireAnimateProps,
} from './targets.js';
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
  /** Изинг tween t∈[0,1]→прогресс. Задан без duration → duration.base. */
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
  /** Перемотать к конечному времени (мс); пауза сохраняется, нефинитное игнорируется. */
  seek(tMs: number): void;
  /** Остановить в текущей позиции; finished резолвится. */
  cancel(): void;
  /** Алиас cancel() (канон driver). */
  stop(): void;
}

// ─── Внутренние контракты ────────────────────────────────────────────────────

/** Общий интерфейс юнитов обоих движков (fan-out контролов). */
interface UnitControls {
  _commit?(): void;
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  cancel(): void;
}

function releaseTransition(rec: GroupRecord, owner: GroupOwner | undefined): void {
  rec._transition = false;
  // User onComplete при release не должен скрыть исходный host-сбой successor.
  try { owner?._release?.(); } catch { /* owner уже терминализирован */ }
}

// ─── Дефолтные швы (читаются в вызове — SSR-safe) ────────────────────────────

function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

function defaultSetTimer(cb: () => void, ms: number): () => void {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
}

// ─── Разбор опций ────────────────────────────────────────────────────────────

function resolveMode(options: AnimateOptions): MotionMode {
  const input = options.spring;
  const durationInput = options.duration;
  const easeInput = options.ease;
  const hasSpring = input !== undefined;
  const hasTween = durationInput !== undefined || easeInput !== undefined;
  if (hasSpring && hasTween) {
    throw new MotionParamError('LM136');
  }
  if (hasTween) {
    const durationMs = durationInput ?? DEFAULT_DURATION_MS;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new MotionParamError('LM137');
    }
    const ease = easeInput ?? STANDARD_EASING;
    if (typeof ease !== 'function') {
      throw new MotionParamError('LM138');
    }
    return { _type: 'tween', _durationMs: durationMs, _ease: ease };
  }
  // Внутренний snapshot не даёт мутации caller-owned объекта сменить физику живого рана
  // после однократного чтения и валидации; кадровый hot-path может быть unchecked.
  const source = input ?? DEFAULT_SPRING;
  const spring = {
    mass: source.mass,
    stiffness: source.stiffness,
    damping: source.damping,
  };
  validateSpringParams(spring);
  return { _type: 'spring', _spring: spring };
}

function resolveDelay(input: number | undefined): number {
  const delay = input ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new MotionParamError('LM139');
  }
  return delay;
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
  let source = target;
  if (typeof target === 'string') {
    const doc = (globalThis as { document?: { querySelectorAll?: (s: string) => unknown } })
      .document;
    const query = doc?.querySelectorAll;
    if (doc === undefined || typeof query !== 'function') {
      throw new MotionParamError('LM149');
    }
    source = query.call(doc, target);
  }
  // Валидная прямая цель побеждает случайное/hostile поле length.
  if (isElementLike(source)) return [source];
  const snapshot = collectBoundedArrayLike(source);
  if (!snapshot.every(isElementLike)) throw new MotionParamError('LM147');
  return snapshot as AnimatableElement[];
}

// ─── Группировка спецификаций ────────────────────────────────────────────────

function groupSpecs(specs: readonly ChannelSpec[]): Map<GroupKey, ChannelSpec[]> {
  const groups = new Map<GroupKey, ChannelSpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec._group);
    // Map создаётся здесь и хранит только непустые массивы.
    if (list) list.push(spec);
    else groups.set(spec._group, [spec]);
  }
  return groups;
}

// ─── Снап (единая reduced-политика пакета: мгновенный финал, без кадров) ─────

function writeSnap(el: AnimatableElement, group: GroupKey, bound: BoundGroup): void {
  if (group === 'transform') {
    const state = bound._transform!;
    for (const ch of bound._numeric) state[ch._key] = ch._to;
    el.style.setProperty('transform', buildTransform(state));
  } else if (bound._css !== undefined) {
    bound._css._css = cssAt(bound._css, 1);
    el.style.setProperty(group, String(bound._css._css));
  } else {
    el.style.setProperty(group, String(bound._numeric[0]!._to));
  }
}

/** Реестр получает target только после успешного style+cleanup старого owner. */
function commitSnap(
  rec: ReturnType<typeof groupRecord>,
  bound: BoundGroup,
): void {
  if (bound._css !== undefined) {
    rec._cssValue = bound._css._css;
  }
  for (const ch of bound._numeric) rec._numeric.set(ch._key, { _value: ch._to, _velocity: 0 });
}

/**
 * Полностью прочитанная группа. Tuple остаётся внутри plan/read→commit границы,
 * поэтому package не платит за повторные runtime property-имена каждого entry.
 */
type PlannedGroup = readonly [
  el: AnimatableElement,
  group: GroupKey,
  record: ReturnType<typeof groupRecord>,
  bound: BoundGroup,
  delayMs: number,
  /** Tier 3 — reduced, undefined — main, tuple — compositor. */
  execution: SpringExecutionArtifactTuple | Extract<CompositorTierCode, 3> | undefined,
];

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
  // 1. Options — первая граница: остальные входы могут быть hostile getters.
  options = requireAnimateOptions(options);
  // Остальная валидация — вся ДО побочных эффектов (ноль записей при броске).
  const mode = resolveMode(options);
  const baseDelay = resolveDelay(options.delay);
  const staggerInput = options.stagger;
  if (typeof staggerInput === 'number') resolveDelay(staggerInput);
  const specs = parseProps(requireAnimateProps(props));
  const els = resolveTargets(target);
  let targetDelays: number[] | undefined;
  if (staggerInput !== undefined) {
    targetDelays = typeof staggerInput === 'number'
      ? scheduleStagger(els.length, true, staggerInput)
      : scheduleStagger(
        els.length,
        true,
        staggerInput.gap,
        staggerInput.from,
        staggerInput.easing,
        staggerInput.grid?.columns,
        staggerInput.reducedMotion,
      );
    // scheduleStagger сигнализирует нечисловой/переполненный offset через NaN;
    // сумма двух конечных чисел всё ещё может overflow. Сворачиваем base в
    // принадлежащий фасаду буфер до plan/read и любого host-effect.
    for (let i = 0; i < targetDelays.length; i++) {
      targetDelays[i] = resolveDelay(baseDelay + targetDelays[i]!);
    }
  }

  // Accessibility policy — один snapshot на aggregate. Он сохраняет единый
  // plan и не читает hostile capability целей, когда движение запрещено.
  const reduced = els.length > 0 && prefersReduced(options.matchMedia ??
    (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia);
  const now = options.now ?? defaultNow;
  const setTimer = options.setTimer ?? defaultSetTimer;
  // 2. Фаза plan/read: читаем и привязываем ВСЕ цели до первой мутации.
  //    bindGroup снимает живой state, но не прерывает владельца. Поэтому ни
  //    поздний DOM-read, ни ошибка привязки не оставят ранние цели уже
  //    запущенными; браузер также не увидит чередование read→write→read.
  const groups = groupSpecs(specs);
  const plan: PlannedGroup[] = [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    const delayMs = targetDelays?.[i] ?? baseDelay;
    const tier = reduced
      ? 3
      : resolveCompositorTierCodeFromCapability(
        typeof (el as Partial<WaapiTarget>).animate === 'function',
        options.requestFrame,
      );
    for (const [group, list] of groups) {
      const rec = groupRecord(el, group);
      const bound = bindGroup(el, group, list, rec);
      const execution = tier === 3
        ? tier
        : tier === 0 &&
          mode._type === 'spring' &&
          (group === 'transform' || group === 'opacity')
            ? tryCompileSpringExecutionArtifactTupleUnchecked(
                mode._spring,
                dominantV0(bound._numeric),
                DEFAULT_TOLERANCE,
              )
            : undefined;
      plan.push([el, group, rec, bound, delayMs, execution]);
    }
  }

  // 3. Aggregate создаётся только после успешной plan/read-фазы:
  // невалидный вызов не оставляет abandoned Promise и не меняет fail-fast precedence.
  const units: UnitControls[] = [];
  // Дубликат цели строит successor до cancel прежнего owner: синхронный
  // start→cancel не рисуется между кадрами, зато сбой конструктора сохраняет
  // текущего владельца этой записи вместо разрушения обоих прогонов.
  let protectedOwner: object | undefined;
  let mainBatch: SurfaceBatch | undefined;
  const total = plan.length;
  let done = 0;
  let natural = 0;
  let setupDone = false;
  let resolveFinished!: () => void;
  // Наружу виден один lifecycle, поэтому один aggregate Promise заменяет N
  // скрытых Unit-deferred и не превращает массовый start в GC-hot-path.
  const maybeComplete = (): void => {
    if (!setupDone || done !== total) return;
    setupDone = false; // та же защёлка гасит повторную terminal-отчётность
    mainBatch = undefined;
    // Старые per-unit Promise ставили aggregate-resolution на следующую
    // микрозадачу. Сохраняем этот порядок без N deferred: Promise
    // завершится даже если onComplete бросит.
    queueMicrotask(resolveFinished);
    if (natural === total) options.onComplete?.();
  };
  const report = (nat: boolean): void => {
    done++;
    if (nat) natural++;
    maybeComplete();
  };
  // Чистый compositor/reduced не создаёт main-state. WAAPI handoff и обычные
  // main slots одного aggregate делят kernel и исходный plan capacity.
  const getMainBatch = (): SurfaceBatch =>
    mainBatch ??= surfaceBatchFor(options.requestFrame);

  // 4. Фаза commit в исходном target-major порядке. Владелец берётся из
  //    record ЗДЕСЬ, а не сохраняется в плане: повтор цели в списке обязан
  //    прервать юнит, созданный предыдущей записью того же commit.
  try {
    for (const [el, group, rec, bound, delayMs, execution] of plan) {
      const previous = rec._owner;
      if (rec._transition) throw new MotionParamError('LM157');
      rec._transition = true;
      if (execution === 3) {
        try {
          if (previous) previous._supersede(() => writeSnap(el, group, bound));
          else writeSnap(el, group, bound);
        } catch (error) {
          protectedOwner = previous;
          releaseTransition(rec, previous);
          throw error;
        }
        commitSnap(rec, bound);
        rec._transition = false;
        report(true);
        continue;
      }
      let unit: WaapiUnit | MainUnit;
      try {
        // Compositor execution строится только из spring-mode в plan-фазе, поэтому второй
        // runtime-discriminant здесь был бы дублированием того же решения.
        if (execution) {
          unit = new WaapiUnit({
            _el: el as WaapiTarget,
            _group: group,
            _record: rec,
            _numeric: bound._numeric,
            _residuals: bound._residuals,
            _transform: bound._transform,
            _spring: (mode as Extract<MotionMode, { _type: 'spring' }>)._spring,
            _delayMs: delayMs,
            _now: now,
            _setTimer: setTimer,
            _getBatch: getMainBatch,
            _onDone: report,
            _artifact: execution,
          });
        } else {
          unit = new MainUnit({
            _el: el,
            _group: group,
            _record: rec,
            _bound: bound,
            _mode: mode,
            _delayMs: delayMs,
            _batch: getMainBatch(),
            _onDone: report,
          });
        }
      } catch (error) {
        protectedOwner = previous;
        releaseTransition(rec, previous);
        throw error;
      }
      try {
        previous?._supersede();
      } catch (error) {
        unit._rollback();
        protectedOwner = previous;
        releaseTransition(rec, previous);
        throw error;
      }
      rec._owner = unit;
      rec._transition = false;
      units.push(unit);
      // Sync timer остаётся pending, пока не опубликованы все
      // owners: иначе duplicate target успевает записать target,
      // а следующий заранее связанный effect возвращает from.
    }
    // Вторая commit-фаза: host completion видит уже целый owner graph.
    // Юнит, вытесненный поздним duplicate, к этому моменту done.
    for (const unit of units) unit._commit?.();
  } catch (error) {
    // Host-commit не должен оставить ранее созданные циклы без
    // доступных controls. Отменяем новые юниты в обратном порядке;
    // исходное host-исключение остаётся причиной.
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i] === protectedOwner) continue;
      try { units[i]!.cancel(); } catch { /* best-effort cleanup остальных */ }
    }
    throw error;
  }
  // Commit успешен: только теперь публичный deferred может стать
  // достижимым. Бросок host-а во время commit не оставит abandoned Promise.
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  setupDone = true;
  maybeComplete();

  // 5. Агрегированные контролы (пустой список целей → уже разрешённый no-op).
  const cancel = (): void => {
    for (const u of units) u.cancel();
  };
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
    cancel,
    stop: cancel,
  };
}
