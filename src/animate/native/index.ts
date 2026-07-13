/**
 * Узкоспециализированная DOM-пружина: явные значения → один прогон WAAPI.
 *
 * Граница намеренно узкая: только transform/opacity и WAAPI. Chromium/Firefox
 * требуют CSS linear(); WebKit получает явные адаптивные ключевые кадры.
 * Если возможностей среды нет, функция падает синхронно — скрытого запасного
 * rAF-пути здесь нет; универсальный путь остаётся в `../index`.
 */

import { compileRestingSpringRuntimeCurveUnchecked } from '../../compositor/execution.js';
import { MotionParamError, type MotionParamErrorCode } from '../../errors.js';
import { type SpringParams, validateSpringParams } from '../../spring.js';
import {
  MAX_ANIMATE_TARGETS,
  requireAnimateOptions,
  requireAnimateProps,
} from '../targets.js';

type Pair = readonly [number, number];
type Prop = 'x' | 'y' | 'scale' | 'rotate' | 'opacity';

export interface NativeSpringProps {
  readonly x?: Pair;
  readonly y?: Pair;
  readonly scale?: Pair;
  readonly rotate?: Pair;
  readonly opacity?: Pair;
}

export interface NativeSpringOptions {
  /** Физика пружины. По умолчанию — канонические параметры 1/170/26. */
  readonly spring?: SpringParams;
  /** Явное переопределение; иначе prefers-reduced-motion читается при вызове. */
  readonly reducedMotion?: boolean;
}

export interface NativeSpringControls {
  readonly finished: Promise<void>;
  cancel(): void;
}

export interface NativeSpringElement {
  readonly style: { setProperty(name: string, value: string): void };
  animate(
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ): unknown;
}

export type NativeSpringTarget =
  | NativeSpringElement
  | string
  | ArrayLike<NativeSpringElement>
  | readonly NativeSpringElement[];

interface NativeAnimation {
  readonly finished: PromiseLike<unknown>;
  cancel(): void;
}

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const DONE_FINISHED: Promise<void> = Object.freeze(Promise.resolve());
const DONE_CANCEL = Object.freeze(() => {});
const DONE: NativeSpringControls = Object.freeze({
  finished: DONE_FINISHED,
  cancel: DONE_CANCEL,
});
let lastCss: unknown;
let lastLinear = false;

/** @motionErrorFactory */
function failNative(code: MotionParamErrorCode): never {
  throw new MotionParamError(code);
}

function isElement(value: unknown): value is NativeSpringElement {
  return typeof (value as {
    style?: { setProperty?: unknown };
  } | null)?.style?.setProperty === 'function';
}

function resolveTargets(target: NativeSpringTarget): NativeSpringElement[] {
  let source: unknown = target;
  if (typeof target === 'string') {
    source = (globalThis as {
      document?: { querySelectorAll?: (selector: string) => ArrayLike<unknown> };
    }).document?.querySelectorAll?.(target) ?? failNative('LM149');
  }
  if (isElement(source)) return [source];
  let length = (source as { length?: number } | null)?.length as number;
  // Высокий предел сохраняет реальные DOM-списки, но отсекает OOM из hostile arraylike.
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ANIMATE_TARGETS) {
    failNative('LM146');
  }
  const result: NativeSpringElement[] = [];
  while (length--) {
    const item = (source as ArrayLike<unknown>)[result.length];
    if (!isElement(item)) failNative('LM147');
    result.push(item);
  }
  return result;
}

function parseProps(input: NativeSpringProps): Partial<Record<Prop, Pair>> {
  const parsed: Partial<Record<Prop, Pair>> = {};
  const keys = Object.keys(input);
  if (keys.length === 0) failNative('LM152');
  for (const key of keys) {
    if (key !== 'x' && key !== 'y' && key !== 'scale' && key !== 'rotate' && key !== 'opacity') {
      failNative('LM145');
    }
    const pair = (input as unknown as Record<string, unknown>)[key];
    if (!Array.isArray(pair) || pair.length !== 2) failNative('LM141');
    const from: unknown = pair[0];
    if (!Number.isFinite(from)) failNative('LM142');
    const to: unknown = pair[1];
    if (!Number.isFinite(to)) failNative('LM142');
    parsed[key as Prop] = [from as number, to as number];
  }
  return parsed;
}

function valueAt(pair: Pair, progress: number): number {
  if (progress === 0 || progress === 1) return pair[progress];
  const value = (1 - progress) * pair[0] + progress * pair[1];
  // На экстремальных конечных входах overshoot может быть непредставим в IEEE-754.
  return Number.isFinite(value) ? value : pair[1];
}

function frameAt(
  props: Partial<Record<Prop, Pair>>,
  progress: number,
): Record<string, string | number> {
  const frame: Record<string, string | number> = {};
  let transform = '';
  let pair = props.x;
  if (pair) transform = `translateX(${valueAt(pair, progress)}px)`;
  pair = props.y;
  if (pair) transform += (transform ? ' ' : '') + `translateY(${valueAt(pair, progress)}px)`;
  pair = props.scale;
  if (pair) transform += (transform ? ' ' : '') + `scale(${valueAt(pair, progress)})`;
  pair = props.rotate;
  if (pair) transform += (transform ? ' ' : '') + `rotate(${valueAt(pair, progress)}deg)`;
  if (transform) frame['transform'] = transform;
  pair = props.opacity;
  if (pair) frame['opacity'] = valueAt(pair, progress);
  return frame;
}

function prefersReduced(explicit: boolean | undefined): boolean {
  try {
    // Вызов через globalThis сохраняет обязательный receiver Safari host-метода.
    return explicit ?? ((globalThis as {
      matchMedia?: (query: string) => { matches: boolean };
    }).matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
  } catch {
    return false;
  }
}

function supportsLinear(): boolean {
  const css = (globalThis as {
    CSS?: { supports?: (property: string, value: string) => boolean };
  }).CSS;
  if (css === lastCss) return lastLinear;
  lastCss = css;
  try {
    return lastLinear = css?.supports?.(
      'animation-timing-function',
      'linear(0, 1)',
    ) === true;
  } catch {
    return lastLinear = false;
  }
}

/**
 * Компилирует одну пружинную кривую и запускает одну Animation на каждую цель.
 * Все свойства одной цели объединяются в общие ключевые кадры, поэтому
 * transform и opacity не создают конкурирующие временные шкалы браузера.
 */
export function springTo(
  target: NativeSpringTarget,
  props: NativeSpringProps,
  options: NativeSpringOptions = {},
): NativeSpringControls {
  // Options — первая граница до чтения потенциально hostile target/props.
  options = requireAnimateOptions(options);
  // Snapshot закрывает caller-mutation после однократной валидирующей границы.
  const spring = { ...(options.spring ?? DEFAULT_SPRING) };
  validateSpringParams(spring);
  const values = parseProps(requireAnimateProps(props));
  const targets = resolveTargets(target);
  const finalFrame = frameAt(values, 1);

  if (prefersReduced(options.reducedMotion)) {
    // Только собственные ключи: загрязнённый Object.prototype не является CSS.
    const names = Object.keys(finalFrame);
    for (const element of targets) {
      for (const name of names) {
        element.style.setProperty(name, String(finalFrame[name]));
      }
    }
    return DONE;
  }

  if (targets.length === 0) return DONE;
  for (const element of targets) {
    if (typeof element.animate !== 'function') failNative('LM153');
  }

  // Runtime-план — единый SSOT выбора custom linear() либо явных WebKit-кадров.
  // Runtime-plan уже имеет ровно WAAPI timing-shape; только
  // внутренние samples не должны утечь в hostile/polyfill host.
  const { samples, ...timing } = compileRestingSpringRuntimeCurveUnchecked({ spring });
  if (samples === undefined && !supportsLinear()) failNative('LM154');
  let keyframes: Record<string, string | number>[];
  if (samples === undefined) {
    keyframes = [frameAt(values, 0), finalFrame];
  } else {
    keyframes = new Array(samples.length / 2);
    for (let i = 0; i < keyframes.length; i++) {
      keyframes[i] = frameAt(values, samples[i * 2 + 1]!);
      keyframes[i]!['offset'] = samples[i * 2]! / 100;
    }
  }
  if (targets.length > 1) {
    // Один immutable-план не даёт hostile/polyfill первой цели изменить
    // семантику следующих без O(K × targets) копий и давления на GC.
    for (const frame of keyframes) Object.freeze(frame);
    Object.freeze(keyframes);
    Object.freeze(timing);
  }
  const cancellations: Array<() => void> = [];
  const completions: PromiseLike<unknown>[] = [];
  try {
    for (const element of targets) {
      // Узкая WebIDL-граница не отдаёт подменной реализации доступ к узлам кэша.
      const animation = element.animate(keyframes, timing) as Partial<NativeAnimation> | null;
      const cancel = animation?.cancel;
      if (typeof cancel !== 'function') failNative('LM155');
      // Cancel регистрируется до чтения finished: бросающий host-getter не
      // оставит уже запущенную цель вне rollback-транзакции.
      cancellations.push(() => cancel.call(animation));
      const completion = animation!.finished;
      if (typeof completion?.then !== 'function') failNative('LM155');
      // allSettled сам нормализует thenable; отдельный
      // Promise на цель дублировал бы ту же операцию.
      completions.push(completion);
    }
  } catch (error) {
    void Promise.allSettled(completions);
    cancelAll(cancellations);
    throw error;
  }

  // Host finished может навсегда остаться pending после cancel у polyfill.
  // Публичный lifecycle поэтому имеет собственный terminal deferred, а host-
  // агрегация безопасно дочищает effects в фоне, если всё же завершится.
  let done = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const finish = (): void => {
    if (done) return;
    done = true;
    resolveFinished();
  };
  void Promise.allSettled(completions).then((results) => {
    if (done) return;
    // Только нетронутый набор fulfilled-effect можно заменить точным inline
    // target. Cancel/rollback/rejection не имеют права дорисовывать финал.
    if (
      cancellations.length !== targets.length ||
      results.some((result) => result.status === 'rejected')
    ) {
      cancelAll(cancellations);
      finish();
      return;
    }
    let cancel: (() => void) | undefined;
    // Single-target polyfill мог мутировать отданный keyframe: точная цель
    // пересобирается из закрытого validated snapshot, а не доверяет host-объекту.
    const targetFrame = frameAt(values, 1);
    const names = Object.keys(targetFrame);
    // Pop до host-вызовов закрывает реентрантный cancel; отказ одной цели не
    // мешает освободить остальные. Без полного inline кадра effect сохраняется.
    while ((cancel = cancellations.pop()) !== undefined) {
      const element = targets[cancellations.length]!;
      try {
        for (const name of names) {
          element.style.setProperty(name, String(targetFrame[name]));
        }
      } catch {
        continue;
      }
      try { cancel(); } catch { /* host-effect уже логически освобождён */ }
    }
    finish();
  });

  return {
    finished,
    cancel(): void {
      if (done) return;
      cancelAll(cancellations);
      finish();
    },
  };
}

function cancelAll(cancellations: Array<() => void>): void {
  let cancel: (() => void) | undefined;
  // Pop до host-вызова закрывает реентрантный cancel без отдельного latch.
  while ((cancel = cancellations.pop()) !== undefined) {
    try { cancel(); } catch { /* одна цель не блокирует остальные */ }
  }
}
