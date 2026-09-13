import { readFileSync, writeFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const write = (path, content) => writeFileSync(path, content);

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`missing ${label}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`duplicate ${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

const segmenterPath = 'src/compositor/segmenter.ts';
let segmenter = read(segmenterPath);
if (!segmenter.includes('export type SpringCurveGrid')) {
  const densityMarker = '// ─── Плотность базовой сетки';
  const densityAt = segmenter.indexOf(densityMarker);
  if (densityAt < 0) throw new Error('missing segmenter density marker');
  const curveType = `/** Компактный внутренний результат grid+RDP без materialization узлов. */\nexport type SpringCurveGrid = readonly [\n  xs: readonly number[],\n  ys: readonly number[],\n  kept: readonly number[],\n  horizon: number,\n];\n\n`;
  segmenter = segmenter.slice(0, densityAt) + curveType + segmenter.slice(densityAt);

  const tailMarker = '/** Nodes и канонический horizon вычисляются одной границей. */';
  const tailAt = segmenter.indexOf(tailMarker);
  if (tailAt < 0) throw new Error('missing segmenter tail marker');
  const tail = `/** Nodes и канонический horizon вычисляются одной границей. */
export function buildSpringNodesWithHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] {
  const settle = springCompileHorizon(params, v0, tolerance);
  const curve = buildSpringCurveAtHorizon(
    params,
    v0,
    tolerance,
    settle,
    baseGridSize(params, settle, tolerance, v0),
  );
  return [materializeSpringNodes(curve), curve[3]];
}

function materializeSpringNodes(curve: SpringCurveGrid): SpringNode[] {
  const [xs, ys, kept] = curve;
  return kept.map((k, n): SpringNode => ({
    progress: n === kept.length - 1 ? 1 : ys[k]!,
    percent: xs[k]! * 100,
  }));
}

/**
 * Production compile-as-preflight сохраняет уже существующие grid/RDP-массивы
 * до сериализации и не строит промежуточные SpringNode-объекты.
 */
export function tryBuildSpringCurve(
  params: SpringParams,
  v0: number,
  tolerance: number,
): SpringCurveGrid | undefined {
  const settle = springCompileHorizon(params, v0, tolerance);
  const intervals = requiredGridSize(params, settle, tolerance, v0);
  if (!Number.isSafeInteger(intervals) || intervals > BASE_GRID_MAX) return undefined;
  return buildSpringCurveAtHorizon(params, v0, tolerance, settle, intervals);
}

/** Совместимый диагностический seam; production execution его не вызывает. */
export function tryBuildSpringNodes(
  params: SpringParams,
  v0: number,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] | undefined {
  const curve = tryBuildSpringCurve(params, v0, tolerance);
  return curve === undefined ? undefined : [materializeSpringNodes(curve), curve[3]];
}

/** Specialized v0=0 compact grid + тот же horizon для native artifact. */
export function buildRestingSpringCurve(
  params: SpringParams,
  tolerance: number,
): SpringCurveGrid {
  const settle = springCompileHorizon(params, 0, tolerance);
  return buildSpringCurveAtHorizon(
    params,
    0,
    tolerance,
    settle,
    baseGridSize(params, settle, tolerance),
  );
}

/** Совместимый диагностический v0=0 seam. */
export function buildRestingSpringNodesWithHorizon(
  params: SpringParams,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] {
  const curve = buildRestingSpringCurve(params, tolerance);
  return [materializeSpringNodes(curve), curve[3]];
}

function buildSpringCurveAtHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
  settle: number,
  intervals: number,
): SpringCurveGrid {
  // Валидный набор params всегда оседает в бюджет (гарантия validateSpringForFrameLoop),
  // так что settle конечно; на всякий случай — деградация к малой ненулевой шкале.
  const T = Number.isFinite(settle) && settle > 0 ? settle : 1;

  // Half-step tangent anchor выводится из того же energy-bound: при h=1/(2N)
  // ошибка касательной ≤M·h²/2≤tol/4. На соседней половине exact-хорда
  // добавляет ≤tol/16, итого ≤5tol/16. Первый slope физически равен v0;
  // anchor обязан пережить RDP, иначе эта граничная производная исчезнет.
  const count = intervals + 2;
  const xs = new Array<number>(count);
  const ys = new Array<number>(count);
  // Инварианты пружины (omega0/zeta/omegaD/A/B) петле-инвариантны на всей сетке
  // (params/v0 фиксированы) → считаем их ОДИН раз фабрикой, а не на каждый узел.
  // Значение бит-в-бит равно solveSpring(...).value (см. makeSpringValueSampler).
  const sampleValue = makeSpringValueSampler(params, v0);
  xs[0] = ys[0] = 0;
  const tangentTau = 0.5 / intervals;
  xs[1] = tangentTau;
  // Считаем через тот же percent→offset, который использует WebKit execution:
  // после shortest-roundtrip CSS и keyframes делят один физический slope.
  ys[1] = v0 * ((tangentTau * 100) / 100 * T);
  for (let i = 1; i <= intervals; i++) {
    const tau = i / intervals; // ∈ [0, 1]
    const index = i + 1;
    xs[index] = tau;
    // Финитный страж (не-конечное → цель 1, зеркалит motion-value; для валидных
    // params не срабатывает — покрыто finiteness-fuzz; инвариант «в CSS никогда
    // не NaN/∞») заинлайнен в цикл — минус кадр вызова на КАЖДЫЙ узел сетки
    // (доминирующий путь cold-compile). Тот же Number.isFinite(v)?v:1, бит-в-бит.
    const v = sampleValue(tau * T);
    ys[index] = Number.isFinite(v) ? v : 1;
  }

  // eps = tolerance/2: вторая половина бюджета — под дискретизацию базовой сетки
  // (baseGridSize её и гарантирует ≤ tol/2) ⇒ суммарная реконструкция ≤ tolerance.
  const kept = douglasPeuckerVertical(xs, ys, tolerance / 2, 1);
  return [xs, ys, kept, settle];
}`;
  segmenter = segmenter.slice(0, tailAt) + tail;
  write(segmenterPath, segmenter);
}

const curvePath = 'src/compositor/curve.ts';
let curve = read(curvePath);
if (!curve.includes('tryBuildSpringCurve')) {
  curve = replaceOnce(
    curve,
    "import { settleTimeUpperBound, type SpringParams } from '../spring.js';",
    "import { type SpringParams } from '../spring.js';",
    'curve spring import',
  );
  curve = replaceOnce(
    curve,
    `import {\n  assertSpringCurveBudget,\n  buildRestingSpringNodesWithHorizon,\n  tryBuildSpringNodes,\n  type SpringNode,\n} from './segmenter.js';`,
    `import {\n  assertSpringCurveBudget,\n  buildRestingSpringCurve,\n  tryBuildSpringCurve,\n  type SpringCurveGrid,\n} from './segmenter.js';`,
    'curve segmenter import',
  );
  const emitterAt = curve.indexOf('function emitArtifact(');
  if (emitterAt < 0) throw new Error('missing curve emitter');
  const tail = `function emitArtifact(
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
`;
  curve = curve.slice(0, emitterAt) + tail;
  write(curvePath, curve);
}

const genericMockFiles = [
  'test/animate-spring-cache.test.ts',
  'test/compositor-compile-work.test.ts',
  'test/compositor-webkit-execution.test.ts',
  'test/compositor-serialized-execution.test.ts',
];
for (const path of genericMockFiles) {
  let source = read(path);
  if (source.includes('tryBuildSpringNodes')) {
    source = source.replaceAll('tryBuildSpringNodes', 'tryBuildSpringCurve');
    write(path, source);
  }
}

const serializedPath = 'test/compositor-serialized-execution.test.ts';
let serialized = read(serializedPath);
if (serialized.includes('buildRestingSpringNodesWithHorizon')) {
  serialized = serialized.replaceAll('buildRestingSpringNodesWithHorizon', 'buildRestingSpringCurve');
  write(serializedPath, serialized);
}

console.log('compact RDP candidate applied');
