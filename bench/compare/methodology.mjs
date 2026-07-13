/** Чистые, тестируемые законы сравнительного стенда. */

export const PRODUCTION_ADAPTER_PROFILE = Object.freeze({
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
});

const scenario = (value) => Object.freeze(value);

/** Каноническая топология: runner, raw schema и claim thresholds читают один объект. */
export const START_SCENARIO_MANIFEST = Object.freeze({
  s1: scenario({
    targetsPerCall: 1,
    warmCalls: 40,
    warmSamples: 7,
    staggerGapMs: 0,
    durationMs: 1_200,
    toPx: 300,
    movementThresholdPx: 0.5,
    finalTolerancePx: 2,
    coldMetric: 'firstVisible',
  }),
  s2: scenario({
    targetsPerCall: 100,
    warmCalls: 5,
    warmSamples: 7,
    staggerGapMs: 0,
    durationMs: 1_200,
    toPx: 300,
    movementThresholdPx: 0.5,
    finalTolerancePx: 2,
    coldMetric: 'apiReturn',
  }),
  s3: scenario({
    targetsPerCall: 200,
    warmCalls: 3,
    warmSamples: 7,
    staggerGapMs: 5,
    durationMs: 1_200,
    toPx: 300,
    movementThresholdPx: 0.5,
    finalTolerancePx: 2,
    coldMetric: 'apiReturn',
  }),
  s4: scenario({
    targetsPerCall: 1_000,
    warmCalls: 1,
    warmSamples: 7,
    staggerGapMs: 0,
    durationMs: 1_200,
    toPx: 300,
    movementThresholdPx: 0.5,
    finalTolerancePx: 2,
    coldMetric: 'apiReturn',
  }),
});

export function parseBenchCount(name, raw, fallback, { min, max }) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}: ожидалось целое число в [${min}, ${max}], получено ${String(raw)}`);
  }
  return value;
}

function seededShuffle(values, seed) {
  const out = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Один seeded shuffle задаёт базу, циклический сдвиг балансирует каждую позицию.
 * При числе прогонов, кратном N, каждый участник бывает на каждом месте поровну.
 */
export function makeRoundRobinOrders(ids, runs, seed) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('round-robin: пустой список');
  return Array.from({ length: runs }, (_, run) => {
    const block = Math.floor(run / ids.length);
    const base = seededShuffle(ids, (seed + Math.imul(block, 0x9e3779b9)) >>> 0);
    const offset = run % ids.length;
    return [...base.slice(offset), ...base.slice(0, offset)];
  });
}

/** Publish-блок проверяет фактический порядок, а не обещание генератора. */
export function assertBalancedRunBlocks(name, ordersOrRuns, participantsOrIds) {
  // Счётная форма остаётся для локальных microbench warmup; отчёты
  // обязаны передавать матрицу, чтобы ложный shuffle не прошёл гейт.
  if (Number.isSafeInteger(ordersOrRuns) && Number.isSafeInteger(participantsOrIds)) {
    if (
      participantsOrIds <= 0 ||
      ordersOrRuns < participantsOrIds ||
      ordersOrRuns % participantsOrIds !== 0
    ) {
      throw new Error(`${name}: число прогонов должно быть положительным кратным числу участников (${participantsOrIds})`);
    }
    return;
  }

  const orders = ordersOrRuns;
  const ids = participantsOrIds;
  if (!Array.isArray(orders) || !Array.isArray(ids) || ids.length === 0) {
    throw new Error(`${name}: ожидались матрица порядков и список участников`);
  }
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length || orders.length < ids.length || orders.length % ids.length !== 0) {
    throw new Error(`${name}: требуются полные блоки по ${ids.length} прогонов`);
  }
  for (let run = 0; run < orders.length; run++) {
    const order = orders[run];
    if (
      !Array.isArray(order) ||
      order.length !== ids.length ||
      new Set(order).size !== ids.length ||
      order.some((id) => !uniqueIds.has(id))
    ) {
      throw new Error(`${name}: run ${run + 1} не является перестановкой участников`);
    }
  }
  for (let blockStart = 0; blockStart < orders.length; blockStart += ids.length) {
    for (let position = 0; position < ids.length; position++) {
      const seen = new Set();
      for (let offset = 0; offset < ids.length; offset++) {
        seen.add(orders[blockStart + offset][position]);
      }
      if (seen.size !== ids.length) {
        throw new Error(`${name}: блок ${blockStart / ids.length + 1}, позиция ${position + 1} не сбалансирована`);
      }
    }
  }
}

/** Один квантильный закон для генератора и независимого валидатора. */
export function summarizeSamples(values, { strict = false } = {}) {
  if (!Array.isArray(values) || (strict && values.some((value) => !Number.isFinite(value)))) {
    return null;
  }
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  const middle = sorted.length >> 1;
  const p50 = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return { samples: sorted.length, p50, p95: at(0.95), p99: at(0.99) };
}

/** В comparative-отчёте нет выборки >=100, поэтому p99 там был бы просто max. */
export function summarizeReportSamples(values, options) {
  const summary = summarizeSamples(values, options);
  if (summary === null) return null;
  return { samples: summary.samples, p50: summary.p50, p95: summary.p95 };
}

export function summarizeMedianSamples(values, options) {
  const summary = summarizeSamples(values, options);
  if (summary === null) return null;
  return { samples: summary.samples, p50: summary.p50 };
}

/** Физический абсолютный порог выводится из raw-калибровки часов браузера. */
export function deriveTimerQuantum(values) {
  if (
    !Array.isArray(values) ||
    values.length < 16 ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error('timer calibration: нужны минимум 16 положительных конечных delta');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted.length % 2
    ? sorted[sorted.length >> 1]
    : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
  const concentrated = sorted.filter((value) => Math.abs(value - median) <= median * 0.1);
  if (concentrated.length < Math.ceil(sorted.length * 0.75)) {
    throw new Error('timer calibration: delta не образуют устойчивую концентрацию');
  }
  const middle = concentrated.length >> 1;
  return concentrated.length % 2
    ? concentrated[middle]
    : (concentrated[middle - 1] + concentrated[middle]) / 2;
}

function sameTopology(actual, expected, calls) {
  return (
    actual?.calls === calls &&
    actual.targetsPerCall === expected.targetsPerCall &&
    actual.staggerGapMs === expected.staggerGapMs &&
    actual.durationMs === expected.durationMs &&
    actual.toPx === expected.toPx
  );
}

/** Raw semantic evidence доказывает число вызовов, каждый target и stagger frontier. */
export function evaluateStartSemanticEvidence(evidence, expected, calls) {
  if (!sameTopology(evidence?.topology, expected, calls)) return false;
  if (
    !Array.isArray(evidence.callStartedAtMs) ||
    evidence.callStartedAtMs.length !== calls ||
    evidence.callStartedAtMs.some((value) => !Number.isFinite(value) || value < 0) ||
    !Array.isArray(evidence.checkpoints) || evidence.checkpoints.length === 0 ||
    !Array.isArray(evidence.terminal) || evidence.terminal.length !== calls
  ) return false;

  const shape = (positions) => (
    Array.isArray(positions) &&
    positions.length === expected.targetsPerCall &&
    positions.every(Number.isFinite)
  );
  const terminalValid = evidence.terminal.every((positions) => (
    shape(positions) && positions.every((value) => (
      Math.abs(value - expected.toPx) <= expected.finalTolerancePx
    ))
  ));
  if (!terminalValid) return false;

  let provedPartialStagger = expected.staggerGapMs === 0;
  for (const checkpoint of evidence.checkpoints) {
    if (!Array.isArray(checkpoint?.groups) || checkpoint.groups.length !== calls) return false;
    for (let call = 0; call < calls; call++) {
      const group = checkpoint.groups[call];
      if (
        !Number.isFinite(group?.readStartedMs) ||
        !Number.isFinite(group?.readEndedMs) ||
        group.readStartedMs < evidence.callStartedAtMs[call] ||
        group.readEndedMs < group.readStartedMs ||
        !shape(group.positions)
      ) return false;
      if (expected.staggerGapMs === 0) {
        if (group.positions.some((value) => (
          value < expected.movementThresholdPx ||
          value >= expected.toPx - expected.finalTolerancePx
        ))) return false;
        continue;
      }

      for (let target = 1; target < group.positions.length; target++) {
        if (group.positions[target] > group.positions[target - 1] + expected.movementThresholdPx) {
          return false;
        }
      }
      let lastMoved = -1;
      for (let target = 0; target < group.positions.length; target++) {
        if (group.positions[target] >= expected.movementThresholdPx) lastMoved = target;
      }
      const sinceStartLow = group.readStartedMs - evidence.callStartedAtMs[call];
      const sinceStartHigh = group.readEndedMs - evidence.callStartedAtMs[call];
      const expectedLow = Math.min(
        expected.targetsPerCall - 1,
        Math.max(-1, Math.floor(sinceStartLow / expected.staggerGapMs) - 1),
      );
      const expectedHigh = Math.min(
        expected.targetsPerCall - 1,
        Math.max(-1, Math.floor(sinceStartHigh / expected.staggerGapMs) + 1),
      );
      if (lastMoved < expectedLow || lastMoved > expectedHigh) return false;
      if (lastMoved >= 0 && lastMoved < expected.targetsPerCall - 1) provedPartialStagger = true;
    }
  }
  return provedPartialStagger;
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1))];
}

function validateClusters(name, clusters) {
  if (!Array.isArray(clusters) || clusters.length < 2) {
    throw new Error(`${name}: paired bootstrap требует не менее двух run-кластеров`);
  }
  const runs = new Set();
  return clusters.map((cluster, index) => {
    if (!Number.isSafeInteger(cluster?.run) || cluster.run < 0 || runs.has(cluster.run)) {
      throw new Error(`${name}: cluster ${index + 1} содержит невалидный run`);
    }
    runs.add(cluster.run);
    if (!Array.isArray(cluster.samples) || cluster.samples.length === 0) {
      throw new Error(`${name}: cluster ${index + 1} содержит невалидные samples`);
    }
    const invalidSample = cluster.samples.findIndex(
      (value) => !Number.isFinite(value) || value <= 0,
    );
    if (invalidSample !== -1) {
      throw new Error(
        `${name}: cluster ${index + 1}, sample ${invalidSample + 1}=` +
        `${String(cluster.samples[invalidSample])} не является положительным конечным числом`,
      );
    }
    if (cluster.semantic !== true && cluster.semantic !== false) {
      throw new Error(`${name}: cluster ${index + 1} не содержит semantic gate`);
    }
    return cluster;
  });
}

/**
 * Кластер — один независимый round-robin run; внутренние повторы не выдают себя
 * за независимые наблюдения. Одинаковые индексы сохраняют paired-дизайн.
 */
export function pairedClusterBootstrap(
  labInput,
  competitorInput,
  { seed, iterations = 10_000 } = {},
) {
  const lab = validateClusters('lab', labInput);
  const competitor = validateClusters('competitor', competitorInput);
  if (lab.length !== competitor.length) {
    throw new Error('paired bootstrap: число парных run-кластеров различается');
  }
  for (let index = 0; index < lab.length; index++) {
    if (lab[index].run !== competitor[index].run) {
      throw new Error(`paired bootstrap: run ${lab[index].run} не совпадает с ${competitor[index].run}`);
    }
  }
  const observationsPerCluster = lab[0].samples.length;
  if (
    lab.some((cluster) => cluster.samples.length !== observationsPerCluster) ||
    competitor.some((cluster) => cluster.samples.length !== observationsPerCluster)
  ) {
    throw new Error('paired bootstrap: форма samples должна совпадать во всех run-кластерах');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(iterations) || iterations < 100) {
    throw new Error('paired bootstrap: seed и iterations должны быть положительными целыми');
  }

  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const allLab = lab.flatMap((cluster) => cluster.samples);
  const allCompetitor = competitor.flatMap((cluster) => cluster.samples);
  const labSummary = summarizeSamples(allLab, { strict: true });
  const competitorSummary = summarizeSamples(allCompetitor, { strict: true });
  const observedP50Ratio = labSummary.p50 / competitorSummary.p50;
  const p50Ratios = [];
  const p95Ratios = [];
  let nullAtLeastAsFavorable = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const sampledLab = [];
    const sampledCompetitor = [];
    const nullLab = [];
    for (let cluster = 0; cluster < lab.length; cluster++) {
      const index = Math.floor(random() * lab.length);
      sampledLab.push(...lab[index].samples);
      sampledCompetitor.push(...competitor[index].samples);
      nullLab.push(...lab[index].samples.map((value) => value / observedP50Ratio));
    }
    const labSample = summarizeSamples(sampledLab, { strict: true });
    const competitorSample = summarizeSamples(sampledCompetitor, { strict: true });
    p50Ratios.push(labSample.p50 / competitorSample.p50);
    p95Ratios.push(labSample.p95 / competitorSample.p95);
    const nullSummary = summarizeSamples(nullLab, { strict: true });
    if (nullSummary.p50 / competitorSample.p50 <= observedP50Ratio) nullAtLeastAsFavorable++;
  }

  const interval = (ratios, ratio, labValue, competitorValue) => ({
    ratio,
    low: quantile(ratios, 0.025),
    high: quantile(ratios, 0.975),
    lab: labValue,
    competitor: competitorValue,
  });
  return {
    clusters: lab.length,
    observations: allLab.length,
    semantic: [...lab, ...competitor].every((cluster) => cluster.semantic),
    p50: interval(
      p50Ratios,
      observedP50Ratio,
      labSummary.p50,
      competitorSummary.p50,
    ),
    p95: interval(
      p95Ratios,
      labSummary.p95 / competitorSummary.p95,
      labSummary.p95,
      competitorSummary.p95,
    ),
    pValue: (nullAtLeastAsFavorable + 1) / (iterations + 1),
  };
}

/** Holm step-down сохраняет исходный порядок отчёта и закрывает всё после первого отказа. */
export function applyHolmCorrection(claims, alpha = 0.05) {
  if (!Array.isArray(claims) || claims.length === 0) throw new Error('Holm: пустое семейство claims');
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('Holm: невалидный alpha');
  const sorted = claims.map((claim, index) => {
    if (typeof claim?.id !== 'string' || !Number.isFinite(claim.pValue) || claim.pValue < 0 || claim.pValue > 1) {
      throw new Error('Holm: каждый claim требует id и pValue в [0, 1]');
    }
    return { ...claim, index };
  }).sort((left, right) => left.pValue - right.pValue || left.id.localeCompare(right.id));

  let previousAdjusted = 0;
  let familyOpen = true;
  const result = new Array(sorted.length);
  for (let rank = 0; rank < sorted.length; rank++) {
    const claim = sorted[rank];
    const remaining = sorted.length - rank;
    const adjustedPValue = Math.min(1, Math.max(previousAdjusted, claim.pValue * remaining));
    const accepted = familyOpen && claim.pValue <= alpha / remaining;
    if (!accepted) familyOpen = false;
    previousAdjusted = adjustedPValue;
    const { index, ...original } = claim;
    result[index] = { ...original, adjustedPValue, accepted };
  }
  return result;
}

function finiteEvidenceMetric(metric) {
  return metric && ['ratio', 'low', 'high', 'lab', 'competitor']
    .every((key) => Number.isFinite(metric[key]));
}

/** Claim остаётся неопределённым, пока не пройдёт каждый независимый гейт. */
export function evaluatePerformanceClaim(
  evidence,
  {
    relativeThreshold = 0.05,
    absoluteThreshold,
    holmAccepted,
    p95NonInferiorityMargin = 0.05,
  },
) {
  if (
    !finiteEvidenceMetric(evidence?.p50) ||
    !finiteEvidenceMetric(evidence?.p95) ||
    !Number.isFinite(absoluteThreshold) || absoluteThreshold < 0 ||
    !Number.isFinite(relativeThreshold) || relativeThreshold < 0 || relativeThreshold >= 1 ||
    !Number.isFinite(p95NonInferiorityMargin) || p95NonInferiorityMargin < 0 ||
    typeof holmAccepted !== 'boolean'
  ) {
    throw new Error('claim: невалидные evidence или thresholds');
  }
  const relativeGain = Number((1 - evidence.p50.ratio).toFixed(12));
  const absoluteGain = Number((evidence.p50.competitor - evidence.p50.lab).toFixed(12));
  const gates = {
    confidence: evidence.p50.high < 1,
    practicalRelative: relativeGain >= relativeThreshold,
    practicalAbsolute: absoluteGain >= absoluteThreshold,
    semantic: evidence.semantic === true,
    holm: holmAccepted,
    p95NonInferiority: evidence.p95.high <= 1 + p95NonInferiorityMargin,
  };
  return {
    verdict: Object.values(gates).every(Boolean) ? 'win' : 'inconclusive',
    relativeGain,
    absoluteGain,
    gates,
  };
}

/** Размер сравним только при равной capability-группе и одновременной победе gzip+Brotli. */
export function evaluateSizeClaim(lab, competitor) {
  const valid = (entry) => (
    typeof entry?.capabilityGroup === 'string' && entry.capabilityGroup.length > 0 &&
    Number.isFinite(entry.gzip) && entry.gzip >= 0 &&
    Number.isFinite(entry.brotli) && entry.brotli >= 0
  );
  if (!valid(lab) || !valid(competitor)) throw new Error('size claim: невалидные данные');
  if (lab.capabilityGroup !== competitor.capabilityGroup) {
    return { verdict: 'incomparable', gzipWin: false, brotliWin: false };
  }
  const gzipWin = lab.gzip < competitor.gzip;
  const brotliWin = lab.brotli < competitor.brotli;
  return {
    verdict: gzipWin && brotliWin ? 'win' : 'inconclusive',
    gzipWin,
    brotliWin,
  };
}

function heldAt(points, t) {
  let held;
  for (const point of points) {
    if (point.t > t) break;
    held = point;
  }
  return held;
}

/**
 * Симметричная точность blocked-траектории относительно unblocked baseline той
 * же библиотеки. Нормировка — полный размах baseline в измеряемом окне.
 */
export function scoreAgainstBaseline(blocked, baseline, grid) {
  const expected = grid.map((t) => heldAt(baseline, t)).filter(Boolean);
  if (expected.length !== grid.length || expected.length === 0) return { score: null, samples: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const point of expected) {
    if (point.x < min) min = point.x;
    if (point.x > max) max = point.x;
  }
  const scale = Math.max(1, max - min);
  let quality = 0;
  let samples = 0;
  for (let i = 0; i < grid.length; i++) {
    const actual = heldAt(blocked, grid[i]);
    if (actual === undefined) continue;
    const error = Math.abs(actual.x - expected[i].x);
    quality += Math.max(0, 1 - error / scale);
    samples++;
  }
  return { score: samples === 0 ? null : (quality / samples) * 100, samples };
}

/** JSON-доказательство, из которого score S5 пересчитывается без скрытого состояния. */
export function createFreezeEvidence(blocked, baseline, grid) {
  const copyPoints = (points, label) => {
    if (!Array.isArray(points)) throw new Error(`S5 raw: ${label} не массив`);
    return points.map((point, index) => {
      if (!Number.isFinite(point?.t) || !Number.isFinite(point?.x)) {
        throw new Error(`S5 raw: ${label}[${index}] содержит нечисловую точку`);
      }
      return { t: point.t, x: point.x };
    });
  };
  if (!Array.isArray(grid) || grid.some((value) => !Number.isFinite(value))) {
    throw new Error('S5 raw: grid содержит нечисловое время');
  }
  return {
    blocked: copyPoints(blocked, 'blocked'),
    baseline: copyPoints(baseline, 'baseline'),
    grid: [...grid],
  };
}

export function movementStats(points) {
  if (points.length === 0) {
    return { frames: 0, distinctPositions: 0, netAdvancement: 0, totalAdvancement: 0 };
  }
  const positions = new Set();
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    positions.add(points[i].x);
    if (i > 0) total += Math.abs(points[i].x - points[i - 1].x);
  }
  return {
    frames: points.length,
    distinctPositions: positions.size,
    netAdvancement: Math.abs(points[points.length - 1].x - points[0].x),
    totalAdvancement: total,
  };
}

/** Никакого survivor filtering: один невалидный run инвалидирует весь отчёт. */
export function assertFreezeMatrix(matrix, controlId) {
  for (const [id, runs] of Object.entries(matrix)) {
    if (!Array.isArray(runs) || runs.length === 0) throw new Error(`${id}: нет freeze-прогонов`);
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run?.valid || !Number.isFinite(run.score) || run.samples < 5) {
        throw new Error(`${id}: run ${i + 1} невалиден`);
      }
    }
  }
  const control = matrix[controlId];
  if (!control) throw new Error(`${controlId}: отсутствует платформенный контроль`);
  for (let i = 0; i < control.length; i++) {
    const movement = control[i].movement;
    if (
      movement.frames < 5 ||
      movement.distinctPositions < 5 ||
      movement.totalAdvancement < 10
    ) {
      throw new Error(`${controlId}: run ${i + 1} не доказал движение компоситора`);
    }
  }
}
