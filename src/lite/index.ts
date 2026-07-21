/**
 * lite/index.ts — WAAPI-first эргономичный фасад (<5 КБ), субпуть ./lite.
 *
 * Subpath export: import { animate } from '@labpics/motion/lite'
 *
 * ЗАЧЕМ: «полный» ergonomic one-liner уровня Motion One mini под жёстким
 * <5 КБ gzip. Вся кривая исполняется НАТИВНО (Element.animate + CSS linear()):
 * ноль работы main-потока во время проигрывания, GPU-композитинг transform/
 * opacity. Пружина компилируется в linear() тем же SSOT, что ./nano; произвольная
 * JS-easing семплируется в linear(); tween-строка отдаётся платформе как есть.
 *
 * Эргономика поверх ./nano (та же доверенная платформа):
 *   • независимые оси x/y/scale/rotate/skew — компонуются в один `transform`
 *     (для to-only WAAPI сам берёт `from` из вычисленного стиля — без чтения
 *     матрицы и её декомпозиции);
 *   • пара [from, to] на любом канале (opacity/CSS/transform);
 *   • ЕДИНЫЕ агрегированные контролы группы: finished / play / pause / seek /
 *     cancel / stop / onComplete — вместо сырого Animation[] у ./nano.
 *
 * Граница (осознанно у полного ./animate, НЕ здесь): C¹-подхват скорости при
 * прерывании (перезапуск идёт с текущей позиции, скорость=0), main-thread
 * fallback для хостов без Element.animate/linear(), пакетная интерполяция цвета
 * (браузер интерполирует нативно), инжектируемые швы детерминизма и произвольные
 * N-keyframes/timeline. Каждый вызов задаёт ПОЛНЫЙ transform: неуказанные
 * transform-каналы возвращаются к identity (семантика CSS transition).
 *
 * Инварианты (наследует у пакета): SSR-safe импорт (DOM только в вызове);
 * финитность (NaN/∞ → ранний MotionParamError, в стиль не эмитятся); fail-fast
 * (вся валидация ДО первого Element.animate — при броске ноль запущенных целей);
 * reduced-motion (мгновенный финал: длительность 0, linear).
 */

import { MotionParamError } from '../errors.js';
import { springLinear, type NanoSpring } from '../nano/spring-linear.js';
import { scheduleStagger, type StaggerFrom } from '../stagger/scheduler.js';
import { buildTransform, type TransformState } from '../value/transform.js';

// ─── Публичные типы ──────────────────────────────────────────────────────────

/** Пара [from, to]: явный старт вместо to-only инференса платформы. */
export type LitePair = readonly [from: number | string, to: number | string];

/** Значение канала: цель или пара [from, to]. */
export type LitePropValue = number | string | LitePair;

/**
 * Каналы движения. Восемь transform-осей (компонуются в один `transform`):
 * x/y (px), scale/scaleX/scaleY, rotate/skewX/skewY (deg); opacity и любые
 * нативно-анимируемые CSS-свойства — как есть.
 */
export type LiteProps = Record<string, LitePropValue>;

/** Опции. spring и duration/ease взаимоисключающие. */
export interface LiteOptions {
  /** Пружина (дефолт: mass/stiffness/damping = 1/170/26). */
  readonly spring?: NanoSpring | undefined;
  /** Длительность tween (мс). Задана → режим tween. */
  readonly duration?: number | undefined;
  /** Изинг tween: CSS-строка (нативно) ИЛИ функция t∈[0,1]→прогресс (семпл в linear()). */
  readonly ease?: string | ((t: number) => number) | undefined;
  /** Задержка старта (мс, ≥ 0) — всем целям. */
  readonly delay?: number | undefined;
  /** Каскад для многих целей: число = gap (мс) или конфиг { gap, from, easing, grid }. */
  readonly stagger?: number | LiteStaggerOptions | undefined;
  /** Явный prefers-reduced-motion; иначе читается matchMedia в момент вызова. */
  readonly reducedMotion?: boolean | undefined;
  /** Вызывается один раз, когда ВСЕ цели осели естественно (не cancel). */
  readonly onComplete?: (() => void) | undefined;
}

/** Конфиг каскада (подмножество ./stagger, достаточное фасаду). */
export interface LiteStaggerOptions {
  readonly gap?: number | undefined;
  readonly from?: StaggerFrom | undefined;
  readonly easing?: ((value: number) => number) | undefined;
  readonly grid?: { readonly columns: number } | undefined;
}

/** Цель: элемент, список (Array/NodeList) или CSS-селектор (резолв в вызове). */
export type LiteTarget = Element | string | Iterable<Element> | ArrayLike<Element>;

/** Агрегированные контролы прогона группы. */
export interface LiteControls {
  /** Сами нативные Animation каждой цели (в порядке целей). */
  readonly animations: readonly Animation[];
  /** Резолвится, когда ВСЕ цели завершились (естественно или через cancel/stop). */
  readonly finished: Promise<void>;
  /** Возобновить после pause(). */
  play(): void;
  /** Заморозить в текущей позиции. */
  pause(): void;
  /** Перемотать к времени (мс) от начала. */
  seek(tMs: number): void;
  /** Остановить, сохранив текущую позу (commitStyles + cancel). */
  cancel(): void;
  /** Алиас cancel(). */
  stop(): void;
}

// ─── Каналы transform ─────────────────────────────────────────────────────────

/** Восемь осей buildTransform: значение канала — число (px или deg). */
const TRANSFORM_CHANNELS = new Set<string>([
  'x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY',
]);

// ─── Разбор значения канала ────────────────────────────────────────────────────

/** Раскладывает LitePropValue в пару [from|undefined, to]. Бросает на не-паре длины ≠2. */
function splitPair(value: LitePropValue): [from: number | string | undefined, to: number | string] {
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new MotionParamError('LM141');
    return [value[0] as number | string, value[1] as number | string];
  }
  return [undefined, value as number | string];
}

/** Финитное число или ранний бросок (transform-канал обязан быть числом). */
function finiteNumber(value: number | string | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MotionParamError('LM142');
  return value;
}

// ─── Кадр ──────────────────────────────────────────────────────────────────────

/**
 * Строит PropertyIndexedKeyframes из props. Transform-оси компонуются в один
 * `transform` (to-only → одна строка, WAAPI берёт `from` сам; при любой паре —
 * явные [fromString, toString]); opacity и CSS-свойства — по каналу, каждый
 * to-only ([to]) или парой ([from, to]).
 */
function buildFrame(props: LiteProps): Record<string, (string | number)[]> {
  const frame: Record<string, (string | number)[]> = {};
  const toState: TransformState = {};
  const fromState: TransformState = {};
  let hasTransform = false;
  let transformHasFrom = false;

  for (const key of Object.keys(props)) {
    // Сырой `transform` конфликтует с композицией осей (был бы молча перезаписан):
    // требуем шортхенды x/y/scale/rotate/skew, как полный ./animate.
    if (key === 'transform') throw new MotionParamError('LM140');
    const raw = props[key]!;
    if (TRANSFORM_CHANNELS.has(key)) {
      const [from, to] = splitPair(raw);
      (toState as Record<string, number>)[key] = finiteNumber(to);
      if (from !== undefined) {
        (fromState as Record<string, number>)[key] = finiteNumber(from);
        transformHasFrom = true;
      }
      hasTransform = true;
    } else {
      const [from, to] = splitPair(raw);
      // opacity/CSS: пара → [from, to], иначе to-only ([to]) — WAAPI берёт from сам.
      frame[key] = from === undefined ? [to] : [from, to];
    }
  }

  if (hasTransform) {
    const toString = buildTransform(toState);
    // Пара хотя бы на одной оси → явный from-кадр целиком (to-only оси идут от
    // identity в fromState — задокументированная граница смешения пары и to-only).
    frame['transform'] = transformHasFrom
      ? [buildTransform(fromState), toString]
      : [toString];
  }
  return frame;
}

// ─── Тайминг ─────────────────────────────────────────────────────────────────

const SAMPLE_COUNT = 20;

/** Семплирует произвольную JS-easing в CSS linear()-строку (равномерная сетка). */
function easeToLinear(ease: (t: number) => number): string {
  let out = 'linear(';
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    const p = ease(t);
    out += (i ? ',' : '') + Math.round((Number.isFinite(p) ? p : t) * 1e4) / 1e4;
  }
  return out + ')';
}

/** Разрешает [durationMs, easing] из режима (spring по умолчанию или tween). */
function resolveTiming(options: LiteOptions): [number, string] {
  const hasSpring = options.spring !== undefined;
  const hasTween = options.duration !== undefined || options.ease !== undefined;
  if (hasSpring && hasTween) throw new MotionParamError('LM136');
  if (hasTween) {
    const duration = options.duration ?? 200;
    if (!Number.isFinite(duration) || duration <= 0) throw new MotionParamError('LM137');
    const ease = options.ease;
    if (ease === undefined) return [duration, 'ease'];
    if (typeof ease === 'string') return [duration, ease];
    if (typeof ease !== 'function') throw new MotionParamError('LM138');
    return [duration, easeToLinear(ease)];
  }
  return springLinear(options.spring);
}

// ─── Опции и цели ──────────────────────────────────────────────────────────────

function requireNonNegative(value: number | undefined): number {
  const v = value ?? 0;
  if (!Number.isFinite(v) || v < 0) throw new MotionParamError('LM139');
  return v;
}

function isElementLike(t: unknown): t is Element {
  return typeof t === 'object' && t !== null && typeof (t as { animate?: unknown }).animate === 'function';
}

function resolveTargets(target: LiteTarget): Element[] {
  let source: unknown = target;
  if (typeof target === 'string') {
    const doc = (globalThis as { document?: { querySelectorAll?: (s: string) => ArrayLike<Element> } }).document;
    if (doc === undefined || typeof doc.querySelectorAll !== 'function') {
      throw new MotionParamError('LM149');
    }
    source = doc.querySelectorAll(target);
  }
  if (isElementLike(source)) return [source];
  // Не-контейнер (null/примитив) → каталогизированный LM146 вместо голого
  // TypeError из Array.from; объект без length/итератора даёт пустой набор.
  if (typeof source !== 'object' || source === null) throw new MotionParamError('LM146');
  const list = Array.from(source as ArrayLike<Element>);
  for (const el of list) if (!isElementLike(el)) throw new MotionParamError('LM147');
  return list;
}

function resolveReduced(options: LiteOptions): boolean {
  if (options.reducedMotion !== undefined) return options.reducedMotion === true;
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === 'function' && mm('(prefers-reduced-motion: reduce)').matches;
}

function resolveDelays(count: number, baseDelay: number, stagger: LiteOptions['stagger'], reduced: boolean): number[] {
  if (stagger === undefined) return new Array<number>(count).fill(baseDelay);
  const offsets = typeof stagger === 'number'
    ? scheduleStagger(count, true, stagger, undefined, undefined, undefined, reduced)
    : scheduleStagger(count, true, stagger.gap, stagger.from, stagger.easing, stagger.grid?.columns, reduced);
  return offsets.map((offset) => requireNonNegative(baseDelay + offset));
}

// ─── animate ─────────────────────────────────────────────────────────────────

/**
 * Анимирует элемент(ы) к целям props одной строкой на нативном WAAPI.
 *
 * @param target  Element | список | CSS-селектор (резолв в момент вызова).
 * @param props   Каналы: x/y/scale/rotate/skew (transform-оси), opacity, любые
 *                CSS-свойства; значение — цель или пара [from, to].
 * @param options { spring } ИЛИ { duration, ease }; delay; stagger; reducedMotion; onComplete.
 * @returns Контролы { animations, finished, play, pause, seek, cancel, stop }.
 * @throws {MotionParamError} рано, ДО записей: не-конечные числа, конфликт
 *         режимов, пара неверной длины, селектор без document.
 */
export function animate(target: LiteTarget, props: LiteProps, options: LiteOptions = {}): LiteControls {
  if (typeof options !== 'object' || options === null) throw new MotionParamError('LM156');
  if (typeof props !== 'object' || props === null) throw new MotionParamError('LM151');
  const onComplete = options.onComplete;
  if (onComplete !== undefined && typeof onComplete !== 'function') throw new MotionParamError('LM156');

  // Вся валидация ДО первого Element.animate (fail-fast, ноль запущенных при броске).
  const baseDelay = requireNonNegative(options.delay);
  const reduced = resolveReduced(options);
  const [duration, easing] = resolveTiming(options);
  const frame = buildFrame(props);
  const els = resolveTargets(target);
  const delays = resolveDelays(els.length, baseDelay, options.stagger, reduced);

  // WAAPI принимает (string|number)[]-массивы напрямую; DOM-тип их излишне сужает
  // до string[] | (number|null)[], поэтому один честный cast на границе вызова.
  const keyframes = frame as PropertyIndexedKeyframes;
  const animations = els.map((el, index) => el.animate(keyframes, {
    duration: reduced ? 0 : duration,
    easing: reduced ? 'linear' : easing,
    delay: reduced ? 0 : delays[index]!,
    fill: 'both',
  }));

  // Единый агрегированный finished: каждая цель на finish фиксирует позу
  // (commitStyles) и уходит; onComplete — один раз, только если ВСЕ естественно.
  // settledSet гарантирует ровно один отчёт на цель: естественный finish и
  // последующий stop() одной цели не удваивают счётчик.
  const settledSet = new Set<Animation>();
  let natural = 0;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const report = (animation: Animation, nat: boolean): void => {
    if (settledSet.has(animation)) return;
    settledSet.add(animation);
    if (nat) natural++;
    if (settledSet.size === animations.length) {
      resolveFinished();
      if (natural === animations.length) {
        try { onComplete?.(); } catch (error) {
          (globalThis as { reportError?: (reason: unknown) => void }).reportError?.(error);
        }
      }
    }
  };
  for (const animation of animations) {
    animation.finished.catch(() => { /* cancel отражается через settledSet ниже */ });
    animation.addEventListener('finish', () => {
      try { animation.commitStyles(); animation.cancel(); } catch { /* fill сохраняет финал */ }
      report(animation, true);
    });
  }
  if (animations.length === 0) resolveFinished();

  const stopEach = (): void => {
    for (const animation of animations) {
      if (settledSet.has(animation)) continue;
      try { animation.commitStyles(); } catch { /* нет commitStyles — fill держит позу */ }
      try { animation.cancel(); } catch { /* уже терминализирована */ }
      report(animation, false);
    }
  };

  return {
    animations,
    finished,
    play(): void { for (const a of animations) a.play(); },
    pause(): void { for (const a of animations) a.pause(); },
    seek(tMs: number): void {
      if (!Number.isFinite(tMs)) return;
      for (const a of animations) a.currentTime = Math.max(0, tMs);
    },
    cancel: stopEach,
    stop: stopEach,
  };
}
