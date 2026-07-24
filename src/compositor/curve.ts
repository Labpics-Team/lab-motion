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
import { settleTimeUpperBound, type SpringParams } from '../spring.js';
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
  buildRestingSpringNodesWithHorizon,
  tryBuildSpringNodes,
  type SpringNode,
} from './segmenter.js';

// SSOT дефолтного бюджета — segmenter.ts (колено горизонт-закона #223);
// здесь сохраняется исторический публичный путь импорта.
export { DEFAULT_TOLERANCE } from './segmenter.js';

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
  omega2: number,
  dampingPerMass: number,
  tolerance: number,
  artifact: SpringExecutionArtifactTuple,
];

// Native v0=0 не платит за generic hash-map/cache; линейный hit точен и ничего
// не аллоцирует.
const restingCache: RestingEntry[] = [];

/**
 * Sentinel «эта пружина доказанно НЕ компилируется» — тот же LRU, тот же ключ.
 *
 * ЗАЧЕМ (ревью #246): с #228 предикат компилируемости — сама попытка построения
 * адаптивной сетки, и на over-cap она честно доходит до физического потолка
 * BASE_GRID_MAX (4096 узлов = 4096 вызовов солвера ≈ 0.6 мс). Прежняя O(1)
 * формула global worst-case была ДЕШЕВЛЕ, но НЕСОСТОЯТЕЛЬНА как отказ: она
 * отвергала пружины, которые адаптивная сетка компилирует (именно это #228 и
 * исправил). Звать её обратно как «предфильтр» нельзя — вернутся ложные отказы.
 *
 * Поэтому дешевеет не первый отказ, а ПОВТОРНЫЙ: over-cap возникает на живом
 * жесте (быстрый fling переносит скорость), где animate()/retarget зовут
 * компиляцию каждый кадр с ТЕМ ЖЕ ключом. Sentinel делает второй и все
 * последующие отказы O(1) — теряется максимум один кадр на уникальную пружину,
 * а не каждый. Пин: test/compositor-overcap-memo.test.ts.
 *
 * Пустой tuple — не значение, а ИДЕНТИЧНОСТЬ: наружу он не выходит никогда
 * (сравнение по ссылке гасит его в undefined), поэтому поля ему не нужны, и
 * стоит он в бандле считанные байты — продуктовые пороги трогать не пришлось.
 */
const OVER_CAP = [] as unknown as SpringExecutionArtifactTuple;

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
  // Raw-кривая доказанно занимает ≤7/8 tolerance (#228: сетка ≤ tol/2 + RDP
  // 3tol/8). Оставшийся 1/8 делим поровну:
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
    // Разделитель префиксом — та же байт-в-байт строка, что прежний суффикс
    // после каждого не-последнего стопа.
    out += (i === 0 ? '' : ', ') + progress + ' ' + percent + '%';
    // Унарный + (=== Number(token) для строк) моделирует CSS parser один раз на
    // cold compile. TypedArray не совпадает по identity с caller-owned raw
    // nodes и не выходит host-коду.
    samples[i * 2] = +percent;
    samples[i * 2 + 1] = +progress;
  }
  return [out + ')', samples, durationMs];
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
  // Truthiness эквивалентен !== undefined: значение — всегда tuple-массив.
  if (!artifact) {
    // Ошибочный public compile остаётся fail-fast. undefined возможен ТОЛЬКО
    // при over-cap (tryBuildSpringNodes вернул undefined на том же чистом
    // предикате, что fitsSpringCurveBudget) — прямой LM016 идентичен прежнему
    // assertSpringCurveBudget без повторного пересчёта горизонта/сетки.
    throw new MotionParamError('LM016');
  }
  return artifact;
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
  // Scale-инвариантный exact-key (#239): артефакт — функция ТОЛЬКО битовых
  // частных ω² = k/m и c/m. Это НЕ было верно автоматически: пока ζ считался
  // как c/(2·m·ω₀), промежуточное произведение округлялось по-разному при
  // разной массе, и кэш отдавал чужой план (контрпример в
  // test/compositor-cache-mass-invariance.test.ts). Инвариантность держится
  // тем, что ВСЕ численные потребители канонизированы на те же частные —
  // тогда масс-эквивалентные тройки честно делят один слот.
  const omega2 = spring.stiffness / spring.mass;
  const dampingPerMass = spring.damping / spring.mass;
  // Единственный production-consumer: inline оставляет functional core отдельно
  // тестируемым в source, а import-cost ratchet контролирует итоговый артефакт.
  const hit = /* @__INLINE__ */ lookupSpringLinearCache(
    cache,
    omega2,
    dampingPerMass,
    v0,
    tolerance,
  );
  // Truthiness эквивалентен !== undefined: попадание — всегда tuple-массив
  // (в том числе sentinel over-cap, который гасится общим возвратом ниже).
  let artifact = hit;
  if (!artifact) {
    let nodes = prebuiltNodes;
    let durationMs = prebuiltDurationMs;
    if (nodes === undefined) {
      const build = tryBuildSpringNodes(spring, v0, tolerance);
      if (build) {
        nodes = build[0];
        durationMs = build[1] * 1000;
      }
    }
    // Отрицательный результат (over-cap) стоит столько же, сколько
    // положительный, и на живом жесте повторяется каждый кадр с тем же
    // ключом — он кладётся в кэш тем же путём, что артефакт.
    artifact = nodes === undefined ? OVER_CAP : emitArtifact(
      nodes,
      tolerance,
      durationMs ?? settleTimeUpperBound(spring, v0) * 1000,
    );
    /* @__INLINE__ */ storeSpringLinearCache(
      cache,
      omega2,
      dampingPerMass,
      v0,
      tolerance,
      artifact,
    );
  }
  return artifact === OVER_CAP ? undefined : artifact;
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
  // ОДИН закон идентичности на весь файл (#239): и generic LRU, и этот
  // native-кэш ключуются частными ω²=k/m и c/m. Раньше здесь жил второй закон
  // (сырые m/k/c), из-за чего масс-эквивалентные пружины дедуплицировались на
  // одном пути и не дедуплицировались на другом — расхождение не было ни
  // запинено, ни задокументировано. Пин: test/compositor-cache-mass-invariance.
  const omega2 = spring.stiffness / spring.mass;
  const dampingPerMass = spring.damping / spring.mass;
  // Обратный поиск даёт горячим новым ключам короткий путь.
  for (let i = restingCache.length; i--;) {
    const entry = restingCache[i]!;
    if (
      entry[0] === omega2
      && entry[1] === dampingPerMass
      && entry[2] === tolerance
    ) return entry[3];
  }
  const build = buildRestingSpringNodesWithHorizon(spring, tolerance);
  const artifact = emitArtifact(build[0], tolerance, build[1] * 1000);
  restingCache.push([omega2, dampingPerMass, tolerance, artifact]);
  if (restingCache.length > RESTING_CACHE_CAPACITY) restingCache.shift();
  return artifact;
}

/** Герметичный сброс всех execution artifact-кэшей. */
export function clearSpringExecutionArtifactCacheUnchecked(): void {
  clearSpringLinearCache(sharedCache);
  restingCache.length = 0;
}
