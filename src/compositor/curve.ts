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
import { type SpringParams } from '../spring.js';
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
  buildRestingSpringCurve,
  tryBuildSpringCurve,
  type SpringCurveGrid,
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
  curve: SpringCurveGrid,
  tolerance: number,
): SpringExecutionArtifactTuple {
  const [xs, ys, kept, horizon] = curve;
  const last = kept.length - 1;
  // Raw-кривая доказанно занимает ≤13/16 tolerance. Ещё 1/8 делим поровну:
  // округление progress ≤tol/16 и сдвиг времени ≤tol/16. Для кусочно-
  // линейной функции с максимальным наклоном L
  // time-rounding эквивалентен монотонной перепараметризации и даёт ошибку
  // ≤L·max|Δpercent|. minGap не позволяет соседним stops схлопнуться.
  let maxSlope = 0;
  let minGap = 100;
  let previousPercent = xs[kept[0]!]! * 100;
  let previousProgress = ys[kept[0]!]!;
  for (let i = 1; i <= last; i++) {
    const k = kept[i]!;
    const progress = i === last ? 1 : ys[k]!;
    const percent = xs[k]! * 100;
    const gap = percent - previousPercent;
    const slope = Math.abs((progress - previousProgress) / gap);
    if (slope > maxSlope) maxSlope = slope;
    if (gap < minGap) minGap = gap;
    previousPercent = percent;
    previousProgress = progress;
  }
  const progressDigits = Math.max(4, Math.ceil(Math.log10(8 / tolerance)));
  const percentDigits = Math.max(
    3,
    Math.ceil(Math.log10(8 * maxSlope / tolerance)),
    Math.ceil(Math.log10(2 / minGap)),
  );
  const samples = new Float64Array(kept.length * 2);
  let out = 'linear(';
  for (let i = 0; i <= last; i++) {
    const k = kept[i]!;
    const rawProgress = i === last ? 1 : ys[k]!;
    const rawPercent = xs[k]! * 100;
    // Первый interior-stop — защищённая физическая касательная. Обычное
    // округление 4/3 меняло её slope на десятки процентов; shortest roundtrip
    // сохраняет оба double и тем самым v0 до машинной точности.
    const progress = i === 1 || progressDigits > 100
      ? String(rawProgress)
      : roundShortest(rawProgress, progressDigits);
    const percent = i === 1 || percentDigits > 100
        ? String(rawPercent)
        : roundShortest(rawPercent, percentDigits);
    out += (i === 0 ? '' : ', ') + progress + ' ' + percent + '%';
    // Number(token) моделирует CSS parser один раз на cold compile. TypedArray
    // не совпадает по identity с grid/RDP state и не выходит host-коду.
    samples[i * 2] = +percent;
    samples[i * 2 + 1] = +progress;
  }
  return [out + ')', samples, horizon * 1000];
}

/** Валидированная кривая → единый execution artifact. */
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
 * Compile-as-preflight: cache hit возвращается сразу; безопасный miss строит и
 * кэширует готовый artifact; over-cap заканчивается до grid/RDP.
 */
export function tryCompileSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> = sharedCache,
): SpringExecutionArtifactTuple | undefined {
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
  const curve = tryBuildSpringCurve(spring, v0, tolerance);
  if (!curve) return;
  const artifact = emitArtifact(curve, tolerance);
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
  const curve = buildRestingSpringCurve(spring, tolerance);
  const artifact = emitArtifact(curve, tolerance);
  restingCache.push([mass, stiffness, damping, tolerance, artifact]);
  if (restingCache.length > RESTING_CACHE_CAPACITY) restingCache.shift();
  return artifact;
}

/** Герметичный сброс всех execution artifact-кэшей. */
export function clearSpringExecutionArtifactCacheUnchecked(): void {
  clearSpringLinearCache(sharedCache);
  restingCache.length = 0;
}
