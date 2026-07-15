/**
 * animate/index.ts — одно-строчный DOM-фасад (subpath ./animate),
 * WAAPI-first strict (срез R3b rebuild).
 *
 * Subpath export: import { animate } from '@labpics/motion/animate'
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ БАЗЫ (решение владельца, R3b):
 *   - Базовый граф = планировщик (compositor-plan) + юнит (compositor-unit) +
 *     компилятор кривых (linear-compile). rAF-движок в базу НЕ входит.
 *   - Среда без WAAPI (и любая группа, не представимая синхронной кривой:
 *     разошедшиеся v0, перебор бюджета сетки, нечисловая пара без linear())
 *     получает ВАЛИДИРОВАННЫЙ СНАП к финалу — та же семантика, что политика
 *     reduced-motion: мгновенный финал без кадров, finished резолвится,
 *     onComplete срабатывает. Это документированный контракт деградации
 *     (дисциплина native), а не скрытый запасной путь.
 *   - Живой fallback — КОМПОЗИРУЕМЫЙ модуль (animate/live): регистрируется
 *     опцией `engine`; база не несёт ни байта его реализации (тип стирается).
 *     Цветовая C¹-непрерывность css-групп — второй композируемый модуль
 *     (animate/format-css) через опцию `formatCssAt`; без него css
 *     интерполирует браузер, а прерывание рестартует по политике R3a (C⁰,
 *     from = цель прерванного прогона). Числовые группы C¹ всегда.
 *   - WebKit-хедж явных кадров сознательно снят в базе: linear() исполняется
 *     как есть (поддержка Baseline 12.2023); explicit-кадры остаются для
 *     сред без linear() (числовые группы). Возврат хеджа — компонуемый слой.
 *
 * Маршрутизация (решение на вызов): reduced → снап-план; WAAPI + представимая
 * кривая → Element.animate через юнит R2 (ноль работы main-потока); иначе →
 * engine-опция либо снап. Повторный animate на том же (el, group) — прерывание
 * с C¹-подхватом из аналитического снимка владельца (канон MotionValue).
 *
 * Инварианты (наследуют ядро): SSR-safe импорт (DOM только в вызове, селектор
 * резолвится в момент вызова); финитность (NaN/∞ → ранний MotionParamError);
 * детерминизм (время только через инжектируемые now/setTimer; физический старт
 * юнитов — один queueMicrotask на вызов, не rAF); LM-коды границ целей,
 * options и режима остаются здесь, каналы валидирует планировщик.
 */

import { type SetTimerFn } from '../compositor/core.js';
import { prefersReduced, supportsLinearEasing } from '../compositor/detect.js';
import { MotionParamError } from '../errors.js';
import {
  DEFAULT_DURATION_MS,
  DEFAULT_SPRING,
  STANDARD_EASING,
} from '../internal/motion-defaults.js';
import { type SpringParams, validateSpringParams } from '../spring.js';
import type { StaggerOptions } from '../stagger/index.js';
import { scheduleStagger } from '../stagger/scheduler.js';
import {
  buildCompositorPlan,
  parsePlanProps,
  type FormatCssAt,
  type PlanGroupOwner,
  type PlanMode,
  type PlannedLiveGroup,
  type PlanTarget,
} from './compositor-plan.js';
import {
  createCompositorUnit,
  type AbortSignalLike,
  type ProgressSnapshot,
} from './compositor-unit.js';
import {
  collectBoundedArrayLike,
  requireAnimateOptions,
  requireAnimateProps,
} from './targets.js';

// ─── Публичные типы ──────────────────────────────────────────────────────────

/** Duck-цель фасада: Element подходит; SSR-объекты с тем же контрактом тоже. */
export type AnimatableElement = PlanTarget;

export type AnimateTarget =
  | AnimatableElement
  | string
  | ArrayLike<AnimatableElement>
  | readonly AnimatableElement[];

export type AnimateProps = Record<string, unknown>;

/** Кадровый шов живого движка (тип живёт здесь, вес — в animate/live). */
export type RequestFrameFn = (cb: (ts?: number) => void) => number;

/** Контекст, который фасад отдаёт композируемому живому движку. */
export interface AnimateEngineContext {
  readonly mode: PlanMode;
  readonly now: () => number;
  readonly setTimer: SetTimerFn;
  readonly requestFrame: RequestFrameFn | undefined;
  readonly formatCssAt: FormatCssAt | undefined;
}

/** Ран живого движка: контролы + владение в терминах юнита R2. */
export interface AnimateEngineRun extends PlanGroupOwner {
  readonly finished: Promise<void>;
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  cancel(): void;
}

/**
 * Композируемый живой движок: исполняет группы, не представимые синхронной
 * WAAPI-кривой. Регистрация — опцией `engine` (tree-shakeable: база не несёт
 * ни байта реализации). Эталонная реализация — animate/live.
 */
export type AnimateEngine = (
  group: PlannedLiveGroup,
  context: AnimateEngineContext,
) => AnimateEngineRun;

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
  /** Шов reduced-motion. Дефолт: globalThis.matchMedia (если среда умеет). */
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  /** Часы (мс). Дефолт: performance.now / Date.now. */
  readonly now?: (() => number) | undefined;
  /** Таймер завершения юнитов. Дефолт: setTimeout/clearTimeout. */
  readonly setTimer?: SetTimerFn | undefined;
  /** Живой движок для непредставимых групп (animate/live). Без него — снап. */
  readonly engine?: AnimateEngine | undefined;
  /** Кадровый шов живого движка (детерминизм тестов; базе не нужен). */
  readonly requestFrame?: RequestFrameFn | undefined;
  /** C¹-шов css-групп (animate/format-css). Без него — политика C⁰ R3a. */
  readonly formatCssAt?: FormatCssAt | undefined;
  /** Прерывание всего вызова: abort = cancel агрегата. */
  readonly signal?: AbortSignalLike | undefined;
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

/** Общий интерфейс запущенных ранов (юнит R2 / живой движок) для fan-out. */
interface RunControls {
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  cancel(): void;
  _snapshot?(): ProgressSnapshot;
}

interface StartedRun {
  run: RunControls;
  readonly settle: (
    owner: PlanGroupOwner,
    natural: boolean,
    snapshot?: ProgressSnapshot,
  ) => void;
  owner: PlanGroupOwner;
  /** Прерывания фасада (cancel/stop/abort) — ненатуральный исход engine-ранов. */
  interrupted: boolean;
  /** Снимок позы, снятый фасадом ДО cancel — терминальная правда реестра. */
  pendingSnapshot: ProgressSnapshot | undefined;
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

function resolveMode(options: AnimateOptions): PlanMode {
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
    return { kind: 'tween', durationMs, ease };
  }
  // Snapshot закрывает caller-mutation после однократного чтения и валидации.
  const source = input ?? DEFAULT_SPRING;
  const spring = {
    mass: source.mass,
    stiffness: source.stiffness,
    damping: source.damping,
  };
  validateSpringParams(spring);
  return { kind: 'spring', spring };
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

// ─── animate ─────────────────────────────────────────────────────────────────

/**
 * Анимирует элемент(ы) к целям props одной строкой.
 *
 * @param target  Element | список | CSS-селектор (резолв в момент вызова).
 * @param props   Каналы: x/y/scale/rotate/… (шортхенды transform), opacity,
 *                любые CSS-свойства; значение — цель или пара [from, to].
 * @param options { spring } ИЛИ { duration, ease }; delay; stagger; onComplete;
 *                engine/formatCssAt — композируемые слои; signal.
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
  // Валидация — вся ДО побочных эффектов (ноль записей при броске).
  const mode = resolveMode(options);
  const baseDelay = resolveDelay(options.delay);
  const staggerInput = options.stagger;
  if (typeof staggerInput === 'number') resolveDelay(staggerInput);
  const signal = options.signal;
  if (
    signal !== undefined &&
    (typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new MotionParamError('LM156');
  }
  // Канон порядка: props-граница (LM151, LM140–144) до чтения hostile целей.
  const specs = parsePlanProps(requireAnimateProps(props));
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
    // scheduleStagger сигнализирует нечисловой offset через NaN; сумма двух
    // конечных чисел всё ещё может overflow — сворачиваем до любых эффектов.
    for (let i = 0; i < targetDelays.length; i++) {
      targetDelays[i] = resolveDelay(baseDelay + targetDelays[i]!);
    }
  }

  // Accessibility policy — один snapshot на aggregate (канон фасада).
  const reduced = els.length > 0 && prefersReduced(options.matchMedia ??
    (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia);
  const now = options.now ?? defaultNow;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const engine = options.engine;
  const formatCssAt = options.formatCssAt;

  // 2. Фаза plan/read: планировщик читает и привязывает ВСЕ цели до первой
  //    мутации (реестр, снимки владельцев, style-read холодного from).
  const { plans, snaps, live } = buildCompositorPlan({
    targets: els,
    props,
    specs,
    mode,
    delayMs: baseDelay,
    targetDelays,
    seams: { now, setTimer },
    // Одна проба среды на вызов; без linear() числовые группы едут
    // explicit-кадрами, символьные — в engine либо снап (см. контракт).
    capability: { linearSupported: supportsLinearEasing() },
    reducedMotion: reduced,
    formatCssAt,
    // signal обслуживается агрегатом: один слушатель на вызов, а не N.
  });

  // 3. Aggregate-состояние создаётся после успешной plan-фазы: невалидный
  //    вызов не оставляет abandoned Promise и не меняет fail-fast precedence.
  const total = plans.length + snaps.length + live.length;
  let done = 0;
  let natural = 0;
  let setupDone = false;
  let resolveFinished!: () => void;
  const runs: StartedRun[] = [];
  const cancelAll = (): void => {
    for (const started of runs) {
      if (started.interrupted) continue;
      started.interrupted = true;
      // Снимок ДО cancel: терминальная запись реестра — поза остановки;
      // ран после done отдаёт финальную позицию, и снимок был бы ложным.
      started.pendingSnapshot = started.run._snapshot?.();
      started.run.cancel();
    }
  };
  const maybeComplete = (): void => {
    if (!setupDone || done !== total) return;
    setupDone = false; // защёлка гасит повторную terminal-отчётность
    if (signal !== undefined) {
      try {
        signal.removeEventListener('abort', cancelAll);
      } catch {
        /* hostile signal не блокирует терминализацию */
      }
    }
    // Aggregate-resolution остаётся на следующей микрозадаче (канон фасада);
    // Promise завершится, даже если onComplete бросит.
    queueMicrotask(resolveFinished);
    if (natural === total) options.onComplete?.();
  };
  const report = (nat: boolean): void => {
    done++;
    if (nat) natural++;
    maybeComplete();
  };
  /** Engine-раны слушаются через finished (у них свой Promise per-run). */
  const wireEngineCompletion = (started: StartedRun, run: AnimateEngineRun): void => {
    run.finished.then(
      () => {
        // Натуральность engine-рана выводит агрегат: ненатуральные исходы
        // идут только через фасадные пути (cancel/stop/abort) либо через
        // supersede дубликата, который уже записал реестр в publish.
        const nat = !started.interrupted;
        started.settle(started.owner, nat, started.pendingSnapshot);
        report(nat);
      },
      () => {
        started.settle(started.owner, false, started.pendingSnapshot);
        report(false);
      },
    );
  };

  // 4. Фаза commit в исходном target-major порядке. Дубликат цели в одном
  //    вызове прерывает ран, созданный предыдущей записью того же commit
  //    (publish-хук выполняет supersede с терминальной записью его снимка).
  try {
    for (const snap of snaps) {
      snap.commit();
      report(true);
    }
    for (const entry of plans) {
      entry.begin();
      const started: StartedRun = {
        run: undefined as unknown as RunControls,
        settle: (owner, nat, snapshot) => entry.settle(owner, nat, snapshot),
        owner: undefined as unknown as PlanGroupOwner,
        interrupted: false,
        pendingSnapshot: undefined,
      };
      let unit: ReturnType<typeof createCompositorUnit>;
      try {
        // Канал onDone вместо unit.finished: aggregate не платит Promise-
        // аллокацией на юнит (контракт O(1) finished на N целей), а
        // натуральность отдаёт сам юнит (complete против cancel/supersede).
        unit = createCompositorUnit(entry.plan, (nat, failure) => {
          started.settle(started.owner, nat && failure === undefined, started.pendingSnapshot);
          report(nat && failure === undefined);
        });
      } catch (error) {
        entry.rollback();
        throw error;
      }
      if (unit === undefined) {
        // Планировщик уже отфильтровал непредставимое; защитная ветвь на
        // расхождение capability — честный снап вместо тихой потери группы.
        entry.rollback();
        report(true);
        continue;
      }
      started.run = unit;
      started.owner = unit;
      entry.publish(unit);
      runs.push(started);
    }
    for (const entry of live) {
      if (engine === undefined) {
        // Контракт базы: непредставимая синхронной кривой группа получает
        // валидированный снап к финалу (единая политика с reduced).
        entry.snap();
        report(true);
        continue;
      }
      entry.begin();
      let run: AnimateEngineRun;
      try {
        run = engine(entry, {
          mode,
          now,
          setTimer,
          requestFrame: options.requestFrame,
          formatCssAt,
        });
      } catch (error) {
        entry.rollback();
        throw error;
      }
      entry.publish(run);
      const started: StartedRun = {
        run,
        settle: (owner, nat, snapshot) => entry.settle(owner, nat, snapshot),
        owner: run,
        interrupted: false,
        pendingSnapshot: undefined,
      };
      runs.push(started);
      wireEngineCompletion(started, run);
    }
  } catch (error) {
    // Сбой commit не оставляет ранее созданные раны без controls: отменяем
    // в обратном порядке; исходное исключение остаётся причиной.
    for (let i = runs.length - 1; i >= 0; i--) {
      try {
        runs[i]!.interrupted = true;
        runs[i]!.run.cancel();
      } catch {
        /* best-effort cleanup остальных */
      }
    }
    throw error;
  }

  // 5. Публичный deferred достижим только после успешного commit.
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  setupDone = true;
  maybeComplete();

  if (signal !== undefined) {
    if (signal.aborted === true) cancelAll();
    else signal.addEventListener('abort', cancelAll, { once: true });
  }

  // 6. Агрегированные контролы (пустой список целей → уже разрешённый no-op).
  return {
    finished,
    play(): void {
      for (const started of runs) started.run.play();
    },
    pause(): void {
      for (const started of runs) started.run.pause();
    },
    seek(tMs: number): void {
      for (const started of runs) started.run.seek(tMs);
    },
    cancel: cancelAll,
    stop: cancelAll,
  };
}
