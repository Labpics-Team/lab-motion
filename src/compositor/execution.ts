/**
 * Внутренний исполняемый план WAAPI без публичных raw diagnostics. Оба движка
 * делят serialized samples: Chromium — для snapshot строки, WebKit — ещё и как
 * явные keyframes.
 *
 * Публичный compileSpringPlan добавляет свежие nodes для инспекции. Движкам они
 * не нужны, поэтому этот внутренний путь не строит и не удерживает их на hit.
 */

import type { SpringParams } from '../spring.js';
import {
  clearSpringExecutionArtifactCacheUnchecked,
  compileSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
  type SpringExecutionArtifactTuple,
  type SpringSerializedSamples,
} from './curve.js';
import { requiresExplicitSpringKeyframes } from './detect.js';

export interface SpringExecutionPlan {
  readonly keyframes: Record<string, string | number>[];
  readonly easing: string;
  readonly duration: number;
  readonly iterations: 1;
  readonly fill: 'none' | 'forwards' | 'backwards' | 'both';
  readonly composite: 'replace' | 'add' | 'accumulate';
  /** Защищённые serialized stops текущего execution-плана. */
  readonly samples?: SpringSerializedSamples | undefined;
}

/** Сброс ограниченного исполнительного кэша — только для прямых тестов. */
export function __resetSpringExecutionCache(): void {
  clearSpringExecutionArtifactCacheUnchecked();
}

type SpringFill = 'none' | 'forwards' | 'backwards' | 'both';
type SpringComposite = 'replace' | 'add' | 'accumulate';
type SpringFormat = ((v: number) => string | number) | undefined;

function endpointKeyframes(
  property: string,
  from: number,
  to: number,
  format: SpringFormat,
): Record<string, string | number>[] {
  return [
    {
      offset: 0,
      [property]: format == null ? from : format(from),
    },
    {
      offset: 1,
      [property]: format == null ? to : format(to),
    },
  ];
}

function explicitKeyframes(
  property: string,
  from: number,
  to: number,
  format: SpringFormat,
  samples: SpringSerializedSamples,
): Record<string, string | number>[] {
  const count = samples.length / 2;
  const frames = new Array<Record<string, string | number>>(count);
  const last = count - 1;
  for (let i = 0; i <= last; i++) {
    const offset = samples[i * 2]! / 100;
    const progress = samples[i * 2 + 1]!;
    // Края присваиваются напрямую: даже устойчивая взвешенная формула на p=1
    // может потерять младшие биты исходного конечного значения.
    const raw = i === 0
        ? from
      : i === last
        ? to
        : (1 - progress) * from + progress * to;
    // Для p∈[0,1] взвешенная форма остаётся конечной даже когда `to-from`
    // переполняется. Нефинитность здесь возможна только у реального overshoot,
    // вышедшего за представимый диапазон; CSS-safe политика снапает его в цель.
    const value = Number.isFinite(raw) ? raw : to;
    frames[i] = {
      offset: i === 0 ? 0 : i === last ? 1 : offset,
      [property]: format == null ? value : format(value),
    };
  }
  return frames;
}

export interface SpringExecutionOptions {
  readonly spring: SpringParams;
  readonly property: string;
  readonly from: number;
  readonly to: number;
  readonly v0?: number;
  readonly tolerance?: number;
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both';
  readonly composite?: 'replace' | 'add' | 'accumulate';
  readonly format?: (v: number) => string | number;
}

/**
 * Компактный production-план: public-shaped object создаёт только совместимый
 * wrapper. Позиции фиксированы и не покидают внутреннюю границу execution.
 */
export type SpringRuntimeExecutionTuple = [
  keyframes: Record<string, string | number>[],
  easing: string,
  duration: number,
  fill: SpringFill,
  composite: SpringComposite,
  samples: SpringSerializedSamples,
];

/** Positional fast-seam после однократной public-boundary валидации. */
export function compileSpringRuntimeExecutionTupleUnchecked(
  spring: SpringParams,
  property: string,
  from: number,
  to: number,
  v0: number,
  tolerance: number,
  fill: SpringFill | undefined,
  composite: SpringComposite | undefined,
  format: SpringFormat,
  precompiled?: SpringExecutionArtifactTuple,
): SpringRuntimeExecutionTuple {
  const artifact = precompiled ?? compileSpringExecutionArtifactTupleUnchecked(
    spring,
    v0,
    tolerance,
  );
  const explicit = requiresExplicitSpringKeyframes();
  const easing = explicit ? 'linear' : artifact[0];
  const samples = artifact[1];
  return [
    explicit
      ? explicitKeyframes(property, from, to, format, samples)
      : endpointKeyframes(property, from, to, format),
    easing,
    artifact[2],
    fill ?? 'both',
    composite ?? 'replace',
    samples,
  ];
}

/**
 * Исполняемый путь выбирает форму плана по реальному движку:
 * Chromium/Firefox сохраняют двухточечный CSS linear() и ранний строковый
 * попадание в bounded cache; WebKit получает адаптивные явные кадры с обычным `linear`,
 * который продолжает исполняться при блокировке главного потока.
 */
export function compileSpringRuntimeExecutionPlanUnchecked(
  options: SpringExecutionOptions,
): SpringExecutionPlan & { readonly samples: SpringSerializedSamples } {
  const tuple = compileSpringRuntimeExecutionTupleUnchecked(
    options.spring,
    options.property,
    options.from,
    options.to,
    options.v0 ?? 0,
    options.tolerance ?? DEFAULT_TOLERANCE,
    options.fill,
    options.composite,
    options.format,
  );
  return {
    keyframes: tuple[0],
    easing: tuple[1],
    duration: tuple[2],
    iterations: 1,
    fill: tuple[3],
    composite: tuple[4],
    samples: tuple[5],
  };
}
