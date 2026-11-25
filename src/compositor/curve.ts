/**
 * Внутренний компилятор spring → CSS linear().
 *
 * Generic-путь хранит artifact в exact-key LRU; узкий native v0=0
 * использует ограниченный список без веса generic Map в своём bundle-графе.
 * Оба пути вызывают один emitter: Chromium исполняет CSS linear()-строку,
 * WebKit строит кадры из тех же numeric stops. Абсолютное квантование ключа
 * запрещено: у малых валидных m/k/c оно меняло физику сильнее tolerance.
 */

import { MotionParamError } from '../errors.js';
import type { SpringParams } from '../spring.js';
import {
  DEFAULT_CACHE_CAPACITY,
  clearSpringLinearCache,
  createSpringLinearCacheState,
  lookupSpringLinearCache,
  storeSpringLinearCache,
  type SpringLinearCache,
} from './cache.js';
import { roundShortest } from './format.js';
import {
  assertSpringCurveBudget,
  buildRestingSpringNodesWithHorizon,
  tryBuildSpringNodes,
} from './segmenter.js';

export const DEFAULT_TOLERANCE: number = 1 / 400;

/** Чередование [percent, progress, ...]; percent — точное число CSS-токена в [0,100]. */
export type SpringSerializedSamples = Float64Array;

/** Защищённый SSOT фактически исполняемой кривой. */
export interface SpringExecutionArtifact {
  readonly easing: string;
  readonly samples: SpringSerializedSamples;
}

/**
 * Внутреннее значение кэша без строковых runtime-полей. Четвёртый слот лениво
 * удерживает совместимый named-facade только если прямой диагностический seam
 * действительно вызван; production execution его не создаёт.
 */
export type SpringExecutionArtifactTuple = [
  easing: string,
  samples: SpringSerializedSamples,
  durationMs: number,
  facade?: SpringExecutionArtifact,
];

/**
 * Generic bounded cache на realm; default — build-константа, поэтому inline
 * складывает cold capacity-parser вне consumer-графа animate.
 */
const sharedCache = /* @__INLINE__ */ createSpringLinearCacheState<SpringExecutionArtifactTuple>(
  DEFAULT_CACHE_CAPACITY,
);

// Малая ёмкость — часть bundle/retention-контракта узкого native subpath;
// граница и FIFO-вытеснение защищены identity-тестом.
const RESTING_CACHE_CAPACITY = 8;

type RestingEntry = [
  mass: number,
  stiffness: number,
  damping: number,
  tolerance: number,
  artifact: SpringExecutionArtifactTuple,
];

// Native v0=0 не платит за generic hash-map/cache; линейный hit точен и ничего
// не аллоцирует.
const restingCache: RestingEntry[] = [];

export function validateTolerance(tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1) {
    throw new MotionParamError('LM014');
  }
}

function emitArtifact(
  samples: SpringSerializedSamples,
  tolerance: number,
  durationMs: number,
): SpringExecutionArtifactTuple {
  // Raw-кривая доказанно занимает ≤13/16 tolerance. Ещё 1/8 делим поровну:
  // округление progress ≤tol/16 и сдвиг времени ≤tol/16. Для кусочно-
  // линейной функции с максимальным наклоном L
  // time-rounding эквивалентен монотонной перепараметризации и даёт ошибку
  // ≤L·max|Δpercent|. minGap не позволяет соседним stops схлопнуться.
  let maxSlope = 0;
  let minGap = 100;
  for (let i = 2; i < samples.length; i += 2) {
    const gap = samples[i]! - samples[i - 2]!;
    const slope = Math.abs((samples[i + 1]! - samples[i - 1]!) / gap);
    if (slope > maxSlope) maxSlope = slope;
    if (gap < minGap) minGap = gap;
  }
  const progressDigits = Math.max(4, Math.ceil(Math.log10(8 / tolerance)));
  const percentDigits = Math.max(
    3,
    Math.ceil(Math.log10(8 * maxSlope / tolerance)),
    Math.ceil(Math.log10(2 / minGap)),
  );
  let out = 'linear(';
  for (let i = 0; i < samples.length; i += 2) {
    // Первый interior-stop — защищённая физическая касательная. Обычное
    // округление 4/3 меняло её slope на десятки процентов; shortest roundtrip
    // сохраняет оба double и тем самым v0 до машинной точности.
    const progress = i === 2 || progressDigits > 100
      ? String(samples[i + 1]!)
      : roundShortest(samples[i + 1]!, progressDigits);
    const percent = i === 2 || percentDigits > 100
        ? String(samples[i]!)
        : roundShortest(samples[i]!, percentDigits);
    out += (i === 0 ? '' : ', ') + progress + ' ' + percent + '%';
    // Number(token) моделирует CSS parser один раз на cold compile. TypedArray
    // до эмиссии принадлежит компилятору; затем тот же буфер становится
    // защищённой частью внутреннего artifact, без передачи raw-узлов наружу.
    samples[i] = +percent;
    samples[i + 1] = +progress;
  }
  return [out + ')', samples, durationMs];
}

/**
 * Валидированная кривая → единый execution artifact. На hit возвращается тот же
 * защищённый объект до построения grid/RDP.
 */
export function compileSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> = sharedCache,
): SpringExecutionArtifactTuple {
  const artifact = tryCompileSpringExecutionArtifactTupleUnchecked(
    spring,
    v0,
    tolerance,
    cache,
  );
  if (!artifact) {
    // Ошибочный public compile остаётся fail-fast; production preflight читает
    // undefined и выбирает live до смены владельца.
    assertSpringCurveBudget(spring, v0, tolerance);
  }
  return artifact!;
}

/**
 * Cache hit returns the exact artifact. On a safe miss, defer requests only
 * the canonical horizon; immediate compilation materializes and caches stops.
 * Over-cap returns before grid/RDP.
 */
/** Validated cold request, never inserted into the artifact cache. */
export type SpringExecutionRequest = readonly [easing: undefined, normalizedVelocity: number, durationMs: number, tolerance: number];
export function tryCompileSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams, v0: number, tolerance: number,
  cache?: SpringLinearCache<SpringExecutionArtifactTuple>, defer?: false,
): SpringExecutionArtifactTuple | undefined;
export function tryCompileSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams, v0: number, tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> | undefined, defer: true,
): SpringExecutionArtifactTuple | SpringExecutionRequest | undefined;
export function tryCompileSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> = sharedCache,
  defer?: boolean,
): SpringExecutionArtifactTuple | SpringExecutionRequest | undefined {
  const { mass, stiffness, damping } = spring;
  // Единственный production-consumer: inline оставляет functional core отдельно
  // тестируемым в source, а import-cost ratchet контролирует итоговый артефакт.
  const hit = /* @__INLINE__ */ lookupSpringLinearCache(
    cache,
    mass,
    stiffness,
    damping,
    v0,
    tolerance,
  );
  if (hit) return hit;
  const build = tryBuildSpringNodes(spring, v0, tolerance, defer);
  if (!build) return;
  if (!build[0]) return [undefined, v0, build[1] * 1000, tolerance];
  const artifact = emitArtifact(build[0], tolerance, build[1] * 1000);
  /* @__INLINE__ */ storeSpringLinearCache(
    cache,
    mass,
    stiffness,
    damping,
    v0,
    tolerance,
    artifact,
  );
  return artifact;
}

/**
 * Совместимый named-seam для прямой диагностики. Facade создаётся максимум один
 * раз на cache entry; production-пути используют tuple и не платят аллокацией.
 */
export function compileSpringExecutionArtifactUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> = sharedCache,
): SpringExecutionArtifact {
  const artifact = compileSpringExecutionArtifactTupleUnchecked(
    spring,
    v0,
    tolerance,
    cache,
  );
  return artifact[3] ??= { easing: artifact[0], samples: artifact[1] };
}

/** Совместимый строковый seam публичного compileSpringLinear. */
export function compileSpringEasingUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> = sharedCache,
): string {
  return compileSpringExecutionArtifactTupleUnchecked(
    spring,
    v0,
    tolerance,
    cache,
  )[0];
}

/** v0=0 artifact без generic velocity-envelope в native-графе. */
export function compileRestingSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams,
  tolerance: number,
): SpringExecutionArtifactTuple {
  const { mass, stiffness, damping } = spring;
  // Обратный поиск даёт горячим новым ключам короткий путь.
  for (let i = restingCache.length; i--;) {
    const entry = restingCache[i]!;
    if (
      entry[0] === mass
      && entry[1] === stiffness
      && entry[2] === damping
      && entry[3] === tolerance
    ) return entry[4];
  }
  const build = buildRestingSpringNodesWithHorizon(spring, tolerance);
  const artifact = emitArtifact(build[0], tolerance, build[1] * 1000);
  restingCache.push([mass, stiffness, damping, tolerance, artifact]);
  if (restingCache.length > RESTING_CACHE_CAPACITY) restingCache.shift();
  return artifact;
}

/** Герметичный сброс всех execution artifact-кэшей. */
export function clearSpringExecutionArtifactCacheUnchecked(): void {
  clearSpringLinearCache(sharedCache);
  restingCache.length = 0;
}
