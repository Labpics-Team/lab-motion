/** Законы Surface-стенда: одна топология, один измеряемый вызов и fail-closed evidence. */
import assert from 'node:assert/strict';
import { pairedClusterBootstrap } from '../bench/compare/methodology.mjs';

export const SURFACE_PAIR_POLICY = Object.freeze({
  clusters: 64,
  warmupBursts: 128,
  bootstrapIterations: 10_000,
  seed: 20260912,
  p95Limit: 1.05,
  workerTimeoutMs: 120_000,
});

export const SURFACE_CALIBRATION_IDS = Object.freeze([
  'ordinary/warm/consume', 'ordinary/miss/consume', 'reject/warm/return', 'batch/warm/consume',
]);

const cases = Object.freeze({
  ordinary: { stiffness: 170, damping: 26, widths: [240, 360], targets: 1 },
  batch: { stiffness: 170, damping: 26, widths: [240, 360], targets: 8 },
  under: { stiffness: 170, damping: 9, widths: [240, 360], targets: 1 },
  over: { stiffness: 100, damping: 40, widths: [240, 360], targets: 1 },
  big: { stiffness: 170, damping: 26, widths: [1, 4096], targets: 1 },
  degenerate: { stiffness: 170, damping: 26, widths: [240, 240], targets: 1 },
  reject: { stiffness: 170, damping: 26, widths: [1, 100000], targets: 1 },
});

export function surfaceProfiles() {
  const profiles = [];
  for (const name of [...Object.keys(cases), 'dynamic', 'irrelevant']) {
    for (const cache of ['dynamic', 'irrelevant'].includes(name) ? ['warm'] : ['warm', 'miss']) {
      for (const mode of ['return', 'consume']) {
        profiles.push({ id: `${name}/${cache}/${mode}`, name, cache, mode,
          lowered: !['reject', 'dynamic', 'irrelevant'].includes(name),
          targets: cases[name]?.targets ?? 1,
          calls: name === 'irrelevant' ? 4096 : ['batch', 'big', 'reject'].includes(name) ? 8 : 32 });
      }
    }
  }
  return profiles;
}

/** Публичный JS authoring: разные пружины дают реальные cache misses, не clear(). */
export function surfaceCode(name, index = 0) {
  assert(Number.isSafeInteger(index) && index >= 0 && index <= 512);
  if (name === 'irrelevant') return 'export const answer = 42;';
  if (name === 'dynamic') return "import {animate} from '@labpics/motion/animate'; animate(el,{width:[240,end]},{layout:'project'});";
  assert(Object.hasOwn(cases, name), 'surface bench: неизвестный сценарий');
  const c = cases[name];
  const stiffness = c.stiffness * (1 + index * 2 ** -40);
  const spring = JSON.stringify({ mass: 1, stiffness, damping: c.damping });
  return "import {animate} from '@labpics/motion/animate';\n" +
    Array.from({ length: c.targets }, (_, i) =>
      `animate(el${i},{width:${JSON.stringify(c.widths)}},{layout:'project',spring:${spring}});`).join('\n') + '\n';
}

export function surfaceInputs(profile) {
  assert(['warm', 'miss'].includes(profile.cache), 'surface bench: неизвестный cache mode');
  return Array.from({ length: profile.cache === 'miss' ? 512 : 1 }, (_, i) =>
    surfaceCode(profile.name, profile.cache === 'miss' ? i + 1 : 0));
}

/** Возврат и полное чтение code/map — разные операции, не скрытая lazy materialization. */
export function consumeSurface(result, consume) {
  if (result === undefined) return 1;
  let sum = result.code.length + result.map.mappings.length;
  if (consume) {
    for (const text of [result.code, result.map.mappings, ...result.map.sources,
      ...result.map.sourcesContent, ...result.map.names]) {
      for (let i = 0; i < text.length; i++) sum += text.charCodeAt(i);
    }
  }
  return sum;
}

/** Контроль каждого burst выполняется за пределами его временного окна. */
export function surfaceBurstVerifier(checksums) {
  assert(checksums.length === 2 && Array.from(checksums).every(values =>
    Array.isArray(values) && values.length > 0 && Array.from(values).every(Number.isFinite)));
  const cursors = [0, 0];
  return (side, actual, calls) => {
    let expected = 0;
    for (let i = 0; i < calls; i++) expected += checksums[side][cursors[side]++ % checksums[side].length];
    assert.equal(actual, expected, 'surface bench: изменился результат измеряемых вызовов');
  };
}

/** Warmup и sample обязаны прогревать один и тот же call-site, а не похожие циклы. */
export function executeSurfaceBurst(operation, calls) {
  let sink = 0;
  for (let i = 0; i < calls; i++) sink += operation();
  return sink;
}

export function pairedSurfaceOrder(cluster) {
  assert(Number.isSafeInteger(cluster) && cluster >= 0, 'surface bench: неверный cluster');
  return cluster % 2 ? [1, 0, 0, 1] : [0, 1, 1, 0];
}

export function runSurfaceCluster(operations, profile, cluster, {
  now = () => process.hrtime.bigint(),
  warmupBursts = SURFACE_PAIR_POLICY.warmupBursts,
  multipliers = [1, 1],
  verify,
} = {}) {
  assert(Array.isArray(operations) && operations.length === 2 && operations.every(op => typeof op === 'function'));
  assert(Number.isSafeInteger(profile.calls) && profile.calls > 0);
  assert(Number.isSafeInteger(warmupBursts) && warmupBursts >= 1);
  assert(verify === undefined || typeof verify === 'function');
  assert.deepEqual(multipliers.map(x => x === 1 || x === 2), [true, true]);
  // Одинаковая warmup-топология обоих участников, без GC/оптимизирующих flags.
  let sink = 0;
  const order = pairedSurfaceOrder(cluster);
  for (let burst = 0; burst < warmupBursts; burst++) {
    for (let position = 0; position < 2; position++) {
      const side = order[position];
      const calls = profile.calls * multipliers[side];
      const value = executeSurfaceBurst(operations[side], calls);
      verify?.(side, value, calls);
      sink += value;
    }
  }
  const samples = [];
  for (const side of order) {
    const started = now();
    const value = executeSurfaceBurst(operations[side], profile.calls * multipliers[side]);
    const elapsedNs = Number(now() - started);
    verify?.(side, value, profile.calls * multipliers[side]);
    sink += value;
    assert(Number.isFinite(elapsedNs) && elapsedNs > 0 && Number.isFinite(value), 'surface bench: потерян sample');
    samples.push({ side, elapsedNs, ns: elapsedNs / profile.calls, calls: profile.calls * multipliers[side] });
  }
  assert(Number.isFinite(sink));
  return { cluster, profile: profile.id, samples, sink, warmupBursts, multipliers, semantic: typeof verify === 'function' };
}

/** В стенд попадают неизменённые байты публичного entry, без приватной копии функции. */
export function surfaceProbeSource(source, ts) {
  const ast = ts.createSourceFile('compiler.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'surface bench: dist не разобран');
  function visit(node) {
    assert(!ts.isImportDeclaration(node) && !(ts.isExportDeclaration(node) && node.moduleSpecifier) &&
      !(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword),
    'surface bench: entry перестал быть самодостаточным, требуется копировать полный import graph');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const exported = ast.statements.some(n => ts.isExportDeclaration(n) && n.exportClause &&
    ts.isNamedExports(n.exportClause) && n.exportClause.elements.some(e => e.name.text === 'motionCompiler'));
  const declared = ast.statements.some(n => ts.isFunctionDeclaration(n) && n.name?.text === 'motionCompiler' &&
    n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  assert(exported || declared, 'surface bench: публичный motionCompiler отсутствует');
  return source;
}

/** Пропуск, дубликат, перестановка или NaN не превращаются в благополучную статистику. */
export function surfaceClusterEvidence(records, profile, count, multipliers = [1, 1]) {
  assert.equal(records.length, count, 'surface bench: неполные clusters');
  const variants = [[], []];
  for (let cluster = 0; cluster < count; cluster++) {
    const record = records[cluster];
    assert.equal(record.cluster, cluster, 'surface bench: нарушен порядок clusters');
    assert.equal(record.profile, profile.id);
    assert.equal(record.semantic, true, 'surface bench: результаты burst не проверены');
    assert.equal(record.warmupBursts, SURFACE_PAIR_POLICY.warmupBursts);
    assert.deepEqual(record.multipliers, multipliers);
    assert(Number.isFinite(record.sink));
    assert.equal(record.samples.length, 4);
    const order = pairedSurfaceOrder(cluster);
    const samples = [[], []];
    for (let position = 0; position < 4; position++) {
      const sample = record.samples[position];
      assert.equal(sample.side, order[position], 'surface bench: нарушен ABBA/BAAB');
      assert.equal(sample.calls, profile.calls * multipliers[sample.side]);
      assert(Number.isFinite(sample.elapsedNs) && sample.elapsedNs > 0);
      assert.equal(sample.ns, sample.elapsedNs / profile.calls);
      samples[sample.side].push(sample.ns);
    }
    for (let side = 0; side < 2; side++) variants[side].push({ run: cluster, samples: samples[side], semantic: true });
  }
  return variants;
}

export function summarizeSurfacePair(records, profile, multipliers = [1, 1]) {
  const [base, candidate] = surfaceClusterEvidence(records, profile, SURFACE_PAIR_POLICY.clusters, multipliers);
  return pairedClusterBootstrap(candidate, base, { seed: SURFACE_PAIR_POLICY.seed, iterations: SURFACE_PAIR_POLICY.bootstrapIterations });
}

function finiteStatistic(stat) {
  return stat?.semantic === true && [stat.p50, stat.p95].every(q => q &&
    ['low', 'high', 'ratio'].every(k => Number.isFinite(q[k]) && q[k] > 0) && q.low <= q.high);
}

export function surfaceCalibrationAdmitted(equalities, positive) {
  return Array.isArray(equalities) && equalities.length === 4 && Array.from(equalities).every(stat => finiteStatistic(stat) &&
    stat.p50.low <= 1 && stat.p50.high >= 1 && stat.p95.low <= 1 && stat.p95.high >= 1 &&
    stat.p95.high <= SURFACE_PAIR_POLICY.p95Limit) && finiteStatistic(positive) && positive.p50.low > 1.5;
}

/** Один закон verdict для живого запуска и независимого пересчёта raw. */
export function surfaceVerdict(rows, calibrated, calibrateOnly) {
  assert.equal(typeof calibrated, 'boolean');
  assert.equal(typeof calibrateOnly, 'boolean');
  const candidate = rows.filter(row => row.comparison === 'candidate');
  if (!calibrated) {
    assert.equal(candidate.length, 0, 'surface bench: кандидат измерялся до калибровки');
    return { status: 'UNPROVEN', reason: 'baseline-only calibration failed; candidate timing samples=0' };
  }
  if (calibrateOnly) {
    assert.equal(candidate.length, 0);
    return { status: 'CALIBRATED', reason: 'baseline-only; candidate not measured' };
  }
  assert.deepEqual(candidate.map(row => row.profile), surfaceProfiles().map(p => p.id));
  assert(candidate.every(row => finiteStatistic(row.stats)), 'surface bench: неполная статистика');
  const unresolved = candidate.filter(row => row.stats.p95.high > SURFACE_PAIR_POLICY.p95Limit).map(row => row.profile);
  return { status: unresolved.length === 0 ? 'LATENCY_ADMISSION' : 'UNPROVEN', unresolved,
    scope: 'Node fixed-burst public compiler distributions; not browser or whole-application startup' };
}
