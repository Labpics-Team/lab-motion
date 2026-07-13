/**
 * Внутренний компилятор spring → CSS linear().
 *
 * Один exact-key LRU хранит единый исполняемый artifact: CSS linear()-строку и
 * те же разобранные numeric stops. Chromium исполняет строку, WebKit строит из
 * stops явные кадры, snapshot сэмплирует их же. Абсолютное квантование ключа
 * запрещено: у малых валидных m/k/c оно меняло физику сильнее tolerance.
 */

import { MotionParamError } from '../errors.js';
import { settleTimeUpperBound, type SpringParams } from '../spring.js';
import { SpringLinearCache, DEFAULT_CACHE_CAPACITY } from './cache.js';
import { roundShortest } from './format.js';
import {
  assertSpringCurveBudget,
  buildRestingSpringNodesWithHorizon,
  fitsSpringCurveBudget,
  tryBuildSpringNodes,
  type SpringNode,
} from './segmenter.js';

export const DEFAULT_TOLERANCE = 1 / 400;

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

/** Один ограниченный LRU на realm; публичная диагностика восстанавливается из samples. */
const sharedCache = new SpringLinearCache<SpringExecutionArtifactTuple>(DEFAULT_CACHE_CAPACITY);

export function validateTolerance(tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1) {
    throw new MotionParamError('LM014');
  }
}

function emitArtifact(
  nodes: readonly SpringNode[],
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
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const gap = b.percent - a.percent;
    const slope = Math.abs((b.progress - a.progress) / gap);
    if (slope > maxSlope) maxSlope = slope;
    if (gap < minGap) minGap = gap;
  }
  const progressDigits = Math.max(4, Math.ceil(Math.log10(8 / tolerance)));
  const percentDigits = Math.max(
    3,
    Math.ceil(Math.log10(8 * maxSlope / tolerance)),
    Math.ceil(Math.log10(2 / minGap)),
  );
  const samples = new Float64Array(nodes.length * 2);
  let out = 'linear(';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    // Первый interior-stop — защищённая физическая касательная. Обычное
    // округление 4/3 меняло её slope на десятки процентов; shortest roundtrip
    // сохраняет оба double и тем самым v0 до машинной точности.
    const progress = i === 1 || progressDigits > 100
      ? String(node.progress)
      : roundShortest(node.progress, progressDigits);
    const percent = i === 1 || percentDigits > 100
        ? String(node.percent)
        : roundShortest(node.percent, percentDigits);
    out += progress + ' ' + percent + '%';
    // Number(token) моделирует CSS parser один раз на cold compile. TypedArray
    // не совпадает по identity с caller-owned raw nodes и не выходит host-коду.
    samples[i * 2] = Number(percent);
    samples[i * 2 + 1] = Number(progress);
    if (i < nodes.length - 1) out += ', ';
  }
  return [out + ')', samples, durationMs];
}

/** Preflight ровно той exact-кривой, которую построит compile. */
export function fitsCompiledSpringCurveBudgetUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
): boolean {
  return fitsSpringCurveBudget(spring, v0, tolerance);
}

/** Fail-fast версия того же канонического preflight. */
export function assertCompiledSpringCurveBudgetUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
): void {
  assertSpringCurveBudget(spring, v0, tolerance);
}

/**
 * Валидированная кривая → единый execution artifact. На hit возвращается тот же
 * защищённый объект до построения grid/RDP; prebuiltNodes не удерживаются.
 */
export function compileSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> = sharedCache,
  prebuiltNodes?: readonly SpringNode[],
  prebuiltDurationMs?: number,
): SpringExecutionArtifactTuple {
  const artifact = tryCompileSpringExecutionArtifactTupleUnchecked(
    spring,
    v0,
    tolerance,
    cache,
    prebuiltNodes,
    prebuiltDurationMs,
  );
  if (artifact === undefined) {
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
  prebuiltNodes?: readonly SpringNode[],
  prebuiltDurationMs?: number,
): SpringExecutionArtifactTuple | undefined {
  const { mass, stiffness, damping } = spring;
  const hit = cache.lookup(mass, stiffness, damping, v0, tolerance);
  if (hit !== undefined) return hit;
  let nodes = prebuiltNodes;
  let durationMs = prebuiltDurationMs;
  if (nodes === undefined) {
    const build = tryBuildSpringNodes(spring, v0, tolerance);
    if (build === undefined) return undefined;
    nodes = build[0];
    durationMs = build[1] * 1000;
  }
  const artifact = emitArtifact(
    nodes,
    tolerance,
    durationMs ?? settleTimeUpperBound(spring, v0) * 1000,
  );
  cache.store(mass, stiffness, damping, v0, tolerance, artifact);
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
  prebuiltNodes?: readonly SpringNode[],
  prebuiltDurationMs?: number,
): SpringExecutionArtifact {
  const artifact = compileSpringExecutionArtifactTupleUnchecked(
    spring,
    v0,
    tolerance,
    cache,
    prebuiltNodes,
    prebuiltDurationMs,
  );
  return artifact[3] ??= { easing: artifact[0], samples: artifact[1] };
}

/** Совместимый строковый seam публичного compileSpringLinear. */
export function compileSpringEasingUnchecked(
  spring: SpringParams,
  v0: number,
  tolerance: number,
  cache: SpringLinearCache<SpringExecutionArtifactTuple> = sharedCache,
  prebuiltNodes?: readonly SpringNode[],
  prebuiltDurationMs?: number,
): string {
  return compileSpringExecutionArtifactTupleUnchecked(
    spring,
    v0,
    tolerance,
    cache,
    prebuiltNodes,
    prebuiltDurationMs,
  )[0];
}

/** v0=0 artifact без generic velocity-envelope в native-графе. */
export function compileRestingSpringExecutionArtifactTupleUnchecked(
  spring: SpringParams,
  tolerance: number,
): SpringExecutionArtifactTuple {
  const { mass, stiffness, damping } = spring;
  const hit = sharedCache.lookup(mass, stiffness, damping, 0, tolerance);
  if (hit !== undefined) return hit;
  const build = buildRestingSpringNodesWithHorizon(spring, tolerance);
  const artifact = emitArtifact(build[0], tolerance, build[1] * 1000);
  sharedCache.store(mass, stiffness, damping, 0, tolerance, artifact);
  return artifact;
}

/** Совместимый named-seam; production native читает tuple напрямую. */
export function compileRestingSpringExecutionArtifactUnchecked(
  spring: SpringParams,
  tolerance: number,
): SpringExecutionArtifact {
  const artifact = compileRestingSpringExecutionArtifactTupleUnchecked(spring, tolerance);
  return artifact[3] ??= { easing: artifact[0], samples: artifact[1] };
}

/** v0=0 строковый seam узкого native Chromium-пути. */
export function compileRestingSpringEasingUnchecked(
  spring: SpringParams,
  tolerance: number,
): string {
  return compileRestingSpringExecutionArtifactTupleUnchecked(spring, tolerance)[0];
}

/** Герметичный сброс единого execution artifact-LRU. */
export function clearSpringExecutionArtifactCacheUnchecked(): void {
  sharedCache.clear();
}
