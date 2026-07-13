import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { formatProvenanceMarkdown } from './provenance.mjs';
import {
  applyHolmCorrection,
  assertBalancedRunBlocks,
  assertFreezeMatrix,
  deriveTimerQuantum,
  evaluateStartSemanticEvidence,
  evaluatePerformanceClaim,
  evaluateSizeClaim,
  movementStats,
  pairedClusterBootstrap,
  scoreAgainstBaseline,
  summarizeReportSamples,
  summarizeMedianSamples,
  START_SCENARIO_MANIFEST,
} from './methodology.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const START_IDS = Object.freeze(['lab', 'motion', 'gsap', 'anime']);
const FREEZE_IDS = Object.freeze([
  'lab',
  'motion',
  'gsap',
  'anime',
  'waapi-ctl',
  'lab-spring',
  'lab-native',
  'motion-mini',
  'anime-waapi',
]);
const GROUPS = Object.freeze({
  lab: 'transform-linear-start+stagger-adapter',
  motion: 'transform-linear-start+stagger-adapter',
  gsap: 'transform-linear-start+stagger-adapter',
  anime: 'transform-linear-start+stagger-adapter',
  'waapi-ctl': 'transform-linear-waapi-control',
  'lab-spring': 'transform-spring-start-adapter',
  'lab-native': 'transform-spring-start-adapter',
  'motion-mini': 'transform-linear-native-start-adapter',
  'anime-waapi': 'transform-linear-native-start-adapter',
});
const CLAIM_METRICS = Object.freeze([
  ...Object.keys(START_SCENARIO_MANIFEST).map((scenario) => ({
    metric: `warm.${scenario}`,
    section: 'warm',
    scenario,
    rawScenario: scenario,
  })),
  ...Object.entries(START_SCENARIO_MANIFEST)
    .filter(([, config]) => config.coldMetric === 'apiReturn')
    .map(([scenario]) => ({
      metric: `cold.${scenario}`,
      section: 'cold',
      scenario,
      rawScenario: scenario,
    })),
  {
    metric: 'cold.firstVisible',
    section: 'cold',
    scenario: 's1',
    rawScenario: 'firstVisible',
  },
]);

function fail(message) {
  throw new Error(`benchmark report: ${message}`);
}

function repositoryWebUrl(packageMetadata) {
  const repository = typeof packageMetadata?.repository === 'string'
    ? packageMetadata.repository
    : packageMetadata?.repository?.url;
  const match = /^(?:git\+)?https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(repository ?? '');
  if (match === null) fail('package.repository обязан указывать точный GitHub repository');
  return `https://github.com/${match[1]}`;
}

/** Каноническое отсутствие claims связано с версией, а не с вечным статусом проекта. */
export function benchmarkNoReportStatement(packageMetadata) {
  if (
    typeof packageMetadata?.name !== 'string' || packageMetadata.name.length === 0 ||
    typeof packageMetadata?.version !== 'string' || packageMetadata.version.length === 0
  ) {
    fail('для состояния документа нужны package name/version');
  }
  return `Для \`${packageMetadata.name}@${packageMetadata.version}\` валидированного сравнительного отчёта нет; сравнительные результаты не заявлены.`;
}

/**
 * Документ может честно находиться ровно в одном состоянии: claims отсутствуют
 * либо на один immutable tag указывает один file-specific report.
 */
export function parseBenchmarkDocumentationState(document, packageMetadata) {
  if (typeof document !== 'string') fail('документ методологии обязан быть строкой');
  const noReport = benchmarkNoReportStatement(packageMetadata);
  const noReportCount = document.split(noReport).length - 1;
  const reportReferences = [...document.matchAll(
    /bench\/compare\/results\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md/g,
  )];
  const resultUrls = [...document.matchAll(
    /https:\/\/github\.com\/[^\s)]+\/(?:blob|tree)\/[^\s)]+\/bench\/compare\/results\/[^\s)]*/g,
  )];

  if (noReportCount > 0) {
    if (noReportCount !== 1 || reportReferences.length !== 0 || resultUrls.length !== 0) {
      fail('состояние без claims смешано со ссылкой на результат');
    }
    return { kind: 'none' };
  }

  if (reportReferences.length !== 1 || resultUrls.length !== 1) {
    fail('документ обязан содержать ровно одну file-specific ссылку на отчёт');
  }
  const stem = reportReferences[0][1];
  const permalink = `${repositoryWebUrl(packageMetadata)}/blob/v${packageMetadata.version}/bench/compare/results/${stem}.md`;
  if (resultUrls[0][0] !== permalink) {
    fail(`ссылка на отчёт обязана быть ${permalink}`);
  }
  return { kind: 'report', stem, permalink };
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label}: нужен SHA-256`);
}

function assertSummary(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label}: summary не пересчитывается из raw`);
}

function claimSeed(seed, id) {
  let state = seed >>> 0;
  for (let index = 0; index < id.length; index++) {
    state = Math.imul(state ^ id.charCodeAt(index), 16777619) >>> 0;
  }
  return state;
}

/** Один генератор claims обслуживает стенд, Markdown и независимую валидацию JSON. */
export function createBenchmarkClaims(
  results,
  { seed, iterations = 10_000, timerQuantumMs } = {},
) {
  if (
    !Number.isSafeInteger(seed) || seed < 0 ||
    !Number.isSafeInteger(iterations) || iterations < 100 ||
    !Number.isFinite(timerQuantumMs) || timerQuantumMs <= 0
  ) {
    fail('claims требуют seed, timer quantum и не менее 100 bootstrap iterations');
  }
  const provisional = [];
  for (const metric of CLAIM_METRICS) {
    for (const competitor of START_IDS.slice(1)) {
      const id = `${metric.metric}:${competitor}`;
      let evidence;
      try {
        evidence = pairedClusterBootstrap(
          results.lab?.raw?.[metric.section]?.[metric.rawScenario],
          results[competitor]?.raw?.[metric.section]?.[metric.rawScenario],
          { seed: claimSeed(seed, id), iterations },
        );
      } catch (error) {
        fail(`${id}: ${error?.message ?? String(error)}`);
      }
      provisional.push({
        id,
        metric: metric.metric,
        competitor,
        absoluteThresholdMs: timerQuantumMs / (
          metric.section === 'warm' ? START_SCENARIO_MANIFEST[metric.scenario].warmCalls : 1
        ),
        evidence,
      });
    }
  }
  const holm = applyHolmCorrection(provisional.map(({ id, evidence }) => ({
    id,
    pValue: evidence.pValue,
  })));
  const holmById = new Map(holm.map((entry) => [entry.id, entry]));
  const performance = provisional.map((claim) => {
    const correction = holmById.get(claim.id);
    const evaluated = evaluatePerformanceClaim(claim.evidence, {
      relativeThreshold: 0.05,
      absoluteThreshold: claim.absoluteThresholdMs,
      holmAccepted: correction.accepted,
      p95NonInferiorityMargin: 0.05,
    });
    return {
      ...claim,
      holm: {
        adjustedPValue: correction.adjustedPValue,
        accepted: correction.accepted,
      },
      relativeGain: evaluated.relativeGain,
      absoluteGainMs: evaluated.absoluteGain,
      gates: evaluated.gates,
      verdict: evaluated.verdict,
    };
  });
  const size = START_IDS.slice(1).map((competitor) => {
    const lab = {
      capabilityGroup: results.lab.group,
      gzip: results.lab.size.gz,
      brotli: results.lab.size.br,
    };
    const other = {
      capabilityGroup: results[competitor].group,
      gzip: results[competitor].size.gz,
      brotli: results[competitor].size.br,
    };
    return {
      id: `size:${competitor}`,
      competitor,
      capabilityGroup: lab.capabilityGroup,
      lab: { gzip: lab.gzip, brotli: lab.brotli },
      competitorSize: { gzip: other.gzip, brotli: other.brotli },
      ...evaluateSizeClaim(lab, other),
    };
  });
  return {
    method: {
      confidence: 0.95,
      bootstrap: 'paired-run-cluster-percentile',
      bootstrapIterations: iterations,
      seed,
      correction: 'holm',
      alpha: 0.05,
      relativeThreshold: 0.05,
      relativeThresholdProvenance: 'product-practical-significance-policy',
      absoluteThresholdBasis: 'measured-performance-now-quantum-per-timed-call',
      timerQuantumMs,
      p95NonInferiorityMargin: 0.05,
      p95NonInferiorityMarginProvenance: 'product-tail-noninferiority-policy',
    },
    performance,
    size,
  };
}

function recomputeRun(run, label) {
  if (run?.evidence === null || typeof run?.evidence !== 'object') fail(`${label}: нет freeze evidence`);
  const scored = scoreAgainstBaseline(
    run.evidence.blocked,
    run.evidence.baseline,
    run.evidence.grid,
  );
  if (Math.abs(scored.score - run.score) > 1e-12 || scored.samples !== run.samples) {
    fail(`${label}: freeze score не пересчитывается из evidence`);
  }
  if (
    !Number.isFinite(run.blockStart) ||
    !Number.isFinite(run.blockEnd) ||
    run.blockEnd - run.blockStart <= 0.16 ||
    !Number.isFinite(run.finalX) ||
    !Number.isFinite(run.baselineFinalX)
  ) {
    fail(`${label}: невалидные freeze bounds/finals`);
  }
  const windowStart = run.blockStart + 0.08;
  const windowEnd = run.blockEnd - 0.08;
  const blocked = run.evidence.blocked.filter((point) => point.t >= windowStart && point.t <= windowEnd);
  const baseline = run.evidence.baseline.filter((point) => point.t >= windowStart && point.t <= windowEnd);
  if (!isDeepStrictEqual(run.movement, movementStats(blocked))) {
    fail(`${label}: blocked movement не пересчитывается`);
  }
  if (!isDeepStrictEqual(run.baselineMovement, movementStats(baseline))) {
    fail(`${label}: baseline movement не пересчитывается`);
  }
  if (
    !Number.isSafeInteger(run.rawFrames?.baseline) ||
    !Number.isSafeInteger(run.rawFrames?.blocked) ||
    run.rawFrames.baseline < run.evidence.baseline.length ||
    run.rawFrames.blocked < run.evidence.blocked.length
  ) {
    fail(`${label}: raw frame counts не подтверждают evidence`);
  }
  const valid =
    Math.abs(run.baselineFinalX - 600) <= 2 &&
    Math.abs(run.finalX - 600) <= 2 &&
    Number.isFinite(scored.score) &&
    scored.samples >= 5 &&
    run.baselineMovement.distinctPositions >= 5 &&
    run.baselineMovement.totalAdvancement >= 10;
  if (run.valid !== valid || !valid) fail(`${label}: valid не пересчитывается`);
}

function recomputeResult(result, id, startRuns, freezeRuns) {
  const raw = result?.raw;
  if (raw === null || typeof raw !== 'object') fail(`${id}: нет raw samples`);
  const scenarioIds = Object.keys(START_SCENARIO_MANIFEST);
  const coldScenarioIds = scenarioIds.filter((scenario) => (
    START_SCENARIO_MANIFEST[scenario].coldMetric === 'apiReturn'
  ));
  if (!isDeepStrictEqual(Object.keys(raw.warm ?? {}), scenarioIds)) {
    fail(`${id}: неверная warm schema`);
  }
  if (!isDeepStrictEqual(Object.keys(raw.cold ?? {}), [...coldScenarioIds, 'firstVisible'])) {
    fail(`${id}: неверная cold schema`);
  }
  const isStart = START_IDS.includes(id);
  const expectedClusters = isStart ? startRuns : 0;
  const validateClusters = (values, samples, config, calls, label) => {
    if (!Array.isArray(values) || values.length !== expectedClusters) {
      fail(`${label}: ожидалось ${expectedClusters} run-кластеров`);
    }
    values.forEach((cluster, run) => {
      const semanticEvidence = cluster?.semanticEvidence;
      const semantic = evaluateStartSemanticEvidence(semanticEvidence, config, calls);
      if (
        cluster?.run !== run ||
        semanticEvidence?.valid !== semantic ||
        cluster.semantic !== semantic ||
        !Array.isArray(cluster.samples) ||
        cluster.samples.length !== samples ||
        cluster.samples.some((value) => !Number.isFinite(value) || value <= 0)
      ) {
        fail(`${label}: run-кластер ${run + 1} невалиден`);
      }
    });
  };
  for (const [name, clusters] of Object.entries(raw.warm)) {
    const config = START_SCENARIO_MANIFEST[name];
    validateClusters(clusters, config.warmSamples, config, config.warmCalls, `${id}.${name}`);
  }
  for (const [name, clusters] of Object.entries(raw.cold)) {
    const config = START_SCENARIO_MANIFEST[name === 'firstVisible' ? 's1' : name];
    validateClusters(clusters, 1, config, 1, `${id}.${name}`);
  }
  const flatten = (clusters) => clusters.flatMap((cluster) => cluster.samples);
  const warm = Object.fromEntries(
    Object.entries(raw.warm ?? {}).map(([name, clusters]) => [name, summarizeReportSamples(flatten(clusters))]),
  );
  const cold = Object.fromEntries(
    Object.entries(raw.cold ?? {}).map(([name, clusters]) => [name, summarizeReportSamples(flatten(clusters), { strict: true })]),
  );
  if (!Array.isArray(raw.freeze) || raw.freeze.length !== freezeRuns) {
    fail(`${id}: ожидалось ${freezeRuns} freeze runs`);
  }
  raw.freeze.forEach((run, index) => recomputeRun(run, `${id} run ${index + 1}`));
  const freeze = {
    score: summarizeMedianSamples(raw.freeze.map((run) => run.score)),
    frames: summarizeMedianSamples(raw.freeze.map((run) => run.movement.frames)),
    distinct: summarizeMedianSamples(raw.freeze.map((run) => run.movement.distinctPositions)),
    net: summarizeMedianSamples(raw.freeze.map((run) => run.movement.netAdvancement)),
    total: summarizeMedianSamples(raw.freeze.map((run) => run.movement.totalAdvancement)),
    finalX: summarizeMedianSamples(raw.freeze.map((run) => run.finalX)),
  };
  assertSummary(result.summary?.warm, warm, `${id}.warm`);
  assertSummary(result.summary?.cold, cold, `${id}.cold`);
  assertSummary(result.summary?.freeze, freeze, `${id}.freeze`);
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function renderBenchmarkEnvironment(payload) {
  const system = payload.system;
  return [
    `Дата: ${payload.generatedAt}`,
    `Ревизия: ${payload.provenance.revisionLabel}`,
    `Машина: ${system.cpu} × ${system.logicalCpus}, ${system.memoryGiB} GB RAM`,
    `ОС: ${system.osType} ${system.osRelease}; Node ${payload.provenance.environment.node}; Chromium ${payload.browser.version} (binary SHA-256 ${payload.browser.executableSha256})`,
    `Квант performance.now(): ${payload.calibration.timerQuantumMs} мс (${payload.calibration.raw.performanceNowDeltasMs.length} raw delta)`,
    `Прогонов: S1–S4 × ${payload.startOrders.length} (p50/p95), freeze × ${payload.freezeOrders.length} (p50); raw JSON`,
    `Библиотеки: ${payload.participants.freeze.map((id) => payload.results[id].version).join(', ')}`,
  ];
}

/** Канонический Markdown: валидатор и генератор не могут разойтись в цифрах. */
export function renderBenchmarkMarkdown(payload) {
  const results = payload.results;
  const ids = payload.participants.freeze;
  const startIds = payload.participants.start;
  const stem = payload.companion.markdownFile.replace(/\.md$/, '');
  const adapterHashes = Object.fromEntries(ids.map((id) => [id, {
    runtimeSha256: results[id].adapterSha256,
    sizeBundleSha256: results[id].size.sha256,
  }]));
  const summaryCell = (summary, digits = 3) => summary === null
    ? 'н/д'
    : `${summary.p50.toFixed(digits)} / ${summary.p95.toFixed(digits)}`;
  const medianCell = (summary, digits = 3) => summary === null
    ? 'н/д'
    : summary.p50.toFixed(digits);
  const table = (title, tableIds, metrics) => [
    `### ${title}`,
    '',
    `| Метрика | ${tableIds.join(' | ')} |`,
    `|---|${tableIds.map(() => '---').join('|')}|`,
    `| Версия | ${tableIds.map((id) => results[id].version).join(' | ')} |`,
    ...metrics.map(([label, render]) =>
      `| ${label} | ${tableIds.map((id) => render(results[id])).join(' | ')} |`),
    '',
  ];
  const controlFrames = results['waapi-ctl'].summary.freeze.frames.p50;
  const freezeMetrics = [
    ['Точность к own unblocked baseline, p50 %', (result) => medianCell(result.summary.freeze.score, 1)],
    ['Кадры в окне, p50 / WAAPI-control', (result) =>
      `${result.summary.freeze.frames.p50.toFixed(0)} / ${((result.summary.freeze.frames.p50 / controlFrames) * 100).toFixed(0)}%`],
    ['Distinct позиции в окне, p50', (result) => result.summary.freeze.distinct.p50.toFixed(0)],
    ['Суммарное видимое продвижение, p50 px', (result) => result.summary.freeze.total.p50.toFixed(0)],
    ['Финальная x, p50 px', (result) => result.summary.freeze.finalX.p50.toFixed(1)],
  ];
  const verdictLabel = (verdict) => verdict === 'win' ? 'победа' : 'неопределённо';
  const claimRows = payload.claims.performance.map((claim) => [
    claim.metric,
    claim.competitor,
    `${claim.evidence.p50.ratio.toFixed(3)} [${claim.evidence.p50.low.toFixed(3)}, ${claim.evidence.p50.high.toFixed(3)}]`,
    `${claim.evidence.p95.ratio.toFixed(3)} [${claim.evidence.p95.low.toFixed(3)}, ${claim.evidence.p95.high.toFixed(3)}]`,
    `${claim.absoluteGainMs.toFixed(3)} / ${claim.absoluteThresholdMs.toFixed(6)}`,
    claim.holm.adjustedPValue.toFixed(4),
    verdictLabel(claim.verdict),
  ]);
  return [
    '# Сравнительный бенчмарк — реальный прогон',
    '',
    ...renderBenchmarkEnvironment(payload).map((line) => `- ${line}`),
    '',
    ...formatProvenanceMarkdown(payload.provenance, adapterHashes).split('\n'),
    '',
    `- Raw samples: [${stem}.json](./${stem}.json).`,
    '',
    'Все runtime-адаптеры собраны одним production-minified профилем.',
    `S1–S4 публикуют \`p50 / p95\` по ${payload.startOrders.length} прогонам; freeze — только p50. p99 не публикуется: выборка меньше 100 прогонов делала бы его max.`,
    'Raw-значения и фактический round-robin порядок лежат в companion JSON.',
    '',
    '## S1–S4: linear full API',
    '',
    ...table('Warm API-return, мс', startIds, [
      ['S1: 1 элемент, батч 40 вызовов', (result) => summaryCell(result.summary.warm.s1)],
      ['S2: 100 элементов одним вызовом', (result) => summaryCell(result.summary.warm.s2)],
      ['S3: stagger 200, gap 5мс', (result) => summaryCell(result.summary.warm.s3)],
      ['S4: 1000 элементов одним вызовом', (result) => summaryCell(result.summary.warm.s4)],
    ]),
    ...table('Cold realm', startIds, [
      ['S1: start→первый видимый кадр, мс', (result) => summaryCell(result.summary.cold.firstVisible, 2)],
      ['S2: API-return 100 элементов, мс', (result) => summaryCell(result.summary.cold.s2)],
      ['S3: API-return stagger 200, мс', (result) => summaryCell(result.summary.cold.s3)],
      ['S4: API-return 1000 элементов, мс', (result) => summaryCell(result.summary.cold.s4)],
    ]),
    'Cold API-return одного элемента намеренно не публикуется: вместо него измеряется первый видимый кадр.',
    'Null/ноль любой публикуемой cold-метрики инвалидирует весь отчёт; survivor filtering и «н/д» запрещены.',
    'Cold realm означает новый JS realm с уже загруженным production-адаптером; network/module fetch и parse',
    'в эту метрику не входят и не выдаются за startup приложения.',
    '',
    '## Статистически проверяемые утверждения',
    '',
    '95% CI отношения Lab / конкурент получен paired cluster bootstrap по независимым round-robin runs.',
    'Победа требует CI целиком ниже 1, выигрыш не менее 5% и абсолютного порога, зелёную семантику,',
    `Holm-гейт всего семейства и p95 upper CI ≤ ${(1 + payload.claims.method.p95NonInferiorityMargin).toFixed(2)}. Общего рейтинга нет.`,
    'Абсолютный порог выводится из raw-кванта performance.now() и числа вызовов внутри timed batch;',
    '5% для p50 — продуктовая граница практической значимости; 5% для p95 — отдельная продуктовая',
    'non-inferiority policy. Эти значения не выдаются за статистические константы.',
    '',
    '| Метрика | Конкурент | p50 ratio, 95% CI | p95 ratio, 95% CI | Δ / порог, мс | Holm p | Verdict |',
    '|---|---|---|---|---:|---:|---|',
    ...claimRows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## S5: freeze main thread',
    '',
    ...table('Linear full API пути', startIds, freezeMetrics),
    ...table('Linear native пути и платформенный контроль', ['waapi-ctl', 'motion-mini', 'anime-waapi'], freezeMetrics),
    ...table('Lab spring-native пути', ['lab-spring', 'lab-native'], freezeMetrics),
    'Группы разделены намеренно: spring-native не ранжируется против linear-native — траектории и',
    'набор возможностей разные. Каждая blocked-траектория сравнивается симметричной ошибкой только',
    'с собственным unblocked-прогоном той же библиотеки; ранний jump и отставание штрафуются одинаково.',
    'Кадры берутся `Page.startScreencast`, позиция — пиксель-скан. В отчёт проходят только все валидные',
    'runs; survivor filtering запрещён. Полные seeded-блоки проводят каждого участника через каждую позицию.',
    'WAAPI-control обязан доказать distinct движение, иначе падает стенд. Companion JSON хранит baseline,',
    'blocked и grid каждого run, поэтому score независимо пересчитывается через `scoreAgainstBaseline`.',
    '',
    '## S6: executable import-cost адаптера',
    '',
    ...table('Одинаковый esbuild production profile', ids, [
      ['min+gzip-9, B', (result) => String(result.size.gz)],
      ['min+Brotli-11, B', (result) => String(result.size.br)],
      ['Capability-группа', (result) => result.group],
    ]),
    '| Конкурент | Точная capability-группа | gzip | Brotli | Verdict |',
    '|---|---|---:|---:|---|',
    ...payload.claims.size.map((claim) => (
      `| ${claim.competitor} | ${claim.capabilityGroup} | ${claim.lab.gzip} / ${claim.competitorSize.gzip} | ${claim.lab.brotli} / ${claim.competitorSize.brotli} | ${verdictLabel(claim.verdict)} |`
    )),
    '',
    'Size-победа допускается только внутри точной capability-группы и только при одновременном',
    'уменьшении gzip-9 и Brotli-11.',
    '',
    '## Оговорки честности',
    '',
    '- API-return не равен полной стоимости: lazy-работу отражает отдельный first-visible metric.',
    '- Нулевой/null cold API-return прерывает отчёт, а не становится «н/д» или победным нулём.',
    '- GSAP после лага не прыгает (lag smoothing), а доигрывает сдвинутый таймлайн — поэтому его',
    '  финальная позиция снимается с запасом +700мс; это поведение, а не дефект.',
    '- Headed Chromium и screencast — один браузерный контур, не универсальный рейтинг браузеров.',
    '- S6 исключает legal comments одинаково у всех и измеряет executable payload, не лицензионные файлы npm.',
    '',
    '_Файл сгенерирован bench/compare/bench.mjs; правки руками = подлог._',
    '',
  ].join('\n');
}

/** Проверяет не формат, а воспроизводимость опубликованных чисел. */
export function validateBenchmarkReportPair({
  stem,
  markdown,
  payload,
  rootPackage,
  benchmarkPackage,
  now = Date.now(),
}) {
  if (payload?.schema !== 4) fail(`schema ${String(payload?.schema)} не поддержана`);
  if (
    payload.package?.name !== rootPackage.name ||
    payload.package?.version !== rootPackage.version
  ) {
    fail('отчёт не соответствует текущему package name/version');
  }

  const generatedAt = Date.parse(payload.generatedAt);
  if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== payload.generatedAt) {
    fail('generatedAt обязан быть каноническим ISO timestamp');
  }
  if (generatedAt > now + 5 * 60_000) fail('generatedAt находится в будущем');

  const provenance = payload.provenance;
  if (provenance?.dirty !== false) fail('publish-отчёт обязан иметь dirty:false');
  if (!REVISION.test(provenance.revision ?? '')) fail('некорректный commit revision');
  if (
    provenance.shortRevision !== provenance.revision.slice(0, 12) ||
    provenance.revisionLabel !== provenance.shortRevision
  ) {
    fail('revision label не выводится из commit');
  }
  assertSha(provenance.worktreeSha256, 'worktree');
  assertSha(provenance.distRuntime?.sha256, 'dist runtime');
  if (!Number.isSafeInteger(provenance.distRuntime?.files) || provenance.distRuntime.files <= 0) {
    fail('dist runtime не содержит файлов');
  }
  const expectedStem = `${payload.generatedAt.slice(0, 10)}-${provenance.revisionLabel}-${provenance.distRuntime.sha256.slice(0, 12)}`;
  if (stem !== expectedStem) fail(`имя отчёта должно быть ${expectedStem}`);
  if (payload.companion?.markdownFile !== `${stem}.md`) fail('неверное имя Markdown companion');
  assertSha(payload.companion?.markdownSha256, 'Markdown companion');
  if (sha256Text(markdown) !== payload.companion.markdownSha256) {
    fail('Markdown companion SHA-256 не совпадает');
  }
  if (markdown !== renderBenchmarkMarkdown(payload)) {
    fail('Markdown не является каноническим rendering companion JSON');
  }
  if (!markdown.includes(`[${stem}.json](./${stem}.json)`)) fail('Markdown не ссылается на companion JSON');
  if (!markdown.includes(`- Дата: ${payload.generatedAt}`)) fail('Markdown подменяет дату JSON');
  if (!markdown.includes('_Файл сгенерирован bench/compare/bench.mjs; правки руками = подлог._')) {
    fail('Markdown не имеет маркера генератора');
  }
  if (!markdown.includes('p99 не публикуется')) fail('Markdown выдаёт малую выборку за p99');

  const inputs = provenance.inputs;
  for (const name of [
    'root/package.json',
    'root/pnpm-lock.yaml',
    'bench/package.json',
    'bench/pnpm-lock.yaml',
    'bench/bench.mjs',
    'bench/methodology.mjs',
    'bench/provenance.mjs',
    'bench/report-contract.mjs',
  ]) {
    assertSha(inputs?.[name], `input ${name}`);
  }
  const environment = provenance.environment;
  if (!/^v24\./.test(environment?.node ?? '')) fail('publish-отчёт требует Node 24');
  const expectedPnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(rootPackage.packageManager ?? '')?.[1];
  if (environment?.pnpm !== expectedPnpm || benchmarkPackage.packageManager !== rootPackage.packageManager) {
    fail('pnpm toolchain не совпадает с packageManager');
  }
  const system = payload.system;
  if (
    typeof system?.cpu !== 'string' || system.cpu.length === 0 ||
    !Number.isSafeInteger(system.logicalCpus) || system.logicalCpus <= 0 ||
    !Number.isSafeInteger(system.memoryGiB) || system.memoryGiB <= 0 ||
    typeof system.osType !== 'string' || system.osType.length === 0 ||
    typeof system.osRelease !== 'string' || system.osRelease.length === 0
  ) {
    fail('невалидная structured system environment');
  }
  if (!isDeepStrictEqual(payload.environment, renderBenchmarkEnvironment(payload))) {
    fail('display environment не выводится из structured provenance');
  }
  assertSha(environment?.nodeExecutableSha256, 'Node executable');
  for (const [name, version] of Object.entries(benchmarkPackage.devDependencies ?? {})) {
    const installed = environment?.packages?.[name];
    if (installed?.version !== version || !Number.isSafeInteger(installed.files) || installed.files <= 0) {
      fail(`${name}: не зафиксированы версия и дерево фактической установки`);
    }
    assertSha(installed.sha256, `${name} package tree`);
  }
  if (payload.browser?.name !== 'chromium' || typeof payload.browser.version !== 'string') {
    fail('не зафиксирован Chromium runtime');
  }
  if (!/^\d+$/.test(payload.browser.revision ?? '') || !Number.isSafeInteger(payload.browser.files) || payload.browser.files <= 0) {
    fail('не зафиксирован Chromium runtime tree');
  }
  assertSha(payload.browser.executableSha256, 'Chromium executable');
  assertSha(payload.browser.treeSha256, 'Chromium runtime tree');
  const calibrationDeltas = payload.calibration?.raw?.performanceNowDeltasMs;
  const timerQuantumMs = deriveTimerQuantum(calibrationDeltas);
  if (payload.calibration?.timerQuantumMs !== timerQuantumMs) {
    fail('timer quantum не пересчитывается из raw calibration');
  }
  if (!isDeepStrictEqual(payload.scenarioManifest, START_SCENARIO_MANIFEST)) {
    fail('scenario manifest не совпадает с канонической топологией');
  }

  if (!isDeepStrictEqual(payload.participants?.start, START_IDS)) fail('изменён состав S1–S4');
  if (!isDeepStrictEqual(payload.participants?.freeze, FREEZE_IDS)) fail('изменён состав freeze');
  if (payload.startOrders?.length < 20) fail('S1–S4 требуют не менее 20 прогонов для p95 ниже max');
  assertBalancedRunBlocks('BENCH_RUNS', payload.startOrders, START_IDS);
  assertBalancedRunBlocks('BENCH_FREEZE_RUNS', payload.freezeOrders, FREEZE_IDS);

  if (!isDeepStrictEqual(Object.keys(payload.results ?? {}), FREEZE_IDS)) {
    fail('набор results не совпадает с участниками');
  }
  const freezeMatrix = {};
  const localVersion = `${rootPackage.name}@${rootPackage.version} (локальный dist)`;
  const packageVersion = (name) => `${name}@${environment.packages[name].version}`;
  const expectedVersions = {
    lab: localVersion,
    motion: packageVersion('motion'),
    gsap: packageVersion('gsap'),
    anime: packageVersion('animejs'),
    'waapi-ctl': 'платформа Chromium (без библиотеки)',
    'lab-spring': localVersion,
    'lab-native': localVersion,
    'motion-mini': packageVersion('motion'),
    'anime-waapi': packageVersion('animejs'),
  };
  for (const id of FREEZE_IDS) {
    const result = payload.results[id];
    if (result?.version !== expectedVersions[id]) fail(`${id}: версия не связана с provenance`);
    if (result?.group !== GROUPS[id]) fail(`${id}: неверная capability-группа`);
    assertSha(result?.adapterSha256, `${id} adapter`);
    assertSha(result?.size?.sha256, `${id} size adapter`);
    for (const metric of ['raw', 'gz', 'br']) {
      if (!Number.isSafeInteger(result?.size?.[metric]) || result.size[metric] <= 0) {
        fail(`${id}: size.${metric} обязан быть положительным числом байт`);
      }
    }
    if (result.size.gz > result.size.raw || result.size.br > result.size.raw) {
      fail(`${id}: compressed size больше raw`);
    }
    if (!markdown.includes(result.adapterSha256) || !markdown.includes(result.size.sha256)) {
      fail(`${id}: Markdown не содержит хеши адаптеров`);
    }
    recomputeResult(result, id, payload.startOrders.length, payload.freezeOrders.length);
    freezeMatrix[id] = result.raw.freeze;
  }
  assertFreezeMatrix(freezeMatrix, 'waapi-ctl');
  const expectedClaims = createBenchmarkClaims(payload.results, {
    seed: payload.orderSeed,
    iterations: payload.claims?.method?.bootstrapIterations,
    timerQuantumMs,
  });
  if (!isDeepStrictEqual(payload.claims, expectedClaims)) fail('claims не пересчитываются из raw-кластеров');
  return payload;
}

/** После clean-замера можно добавить только доказательство и указатель на него. */
export function assertAllowedPostReportChanges(files, stem) {
  const allowed = new Set([
    `bench/compare/results/${stem}.md`,
    `bench/compare/results/${stem}.json`,
    'docs/бенчмарк.md',
  ]);
  const unexpected = files.filter((file) => !allowed.has(file));
  if (unexpected.length > 0) {
    fail(`после замера изменились исполняемые входы: ${unexpected.join(', ')}`);
  }
}
