/** Чистые, тестируемые законы сравнительного стенда. */

export const PRODUCTION_ADAPTER_PROFILE = Object.freeze({
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
});

/** Один локальный origin возвращает браузеру полную timer precision без flags. */
export const BENCHMARK_TIMER_ISOLATION_POLICY = Object.freeze({
  crossOriginIsolated: true,
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginEmbedderPolicy: 'require-corp',
  originAgentCluster: '?1',
});

/** Warm-floor использует шаг моды; superiority-порог — максимум всех дельт. */
export const WARM_TIMER_CALIBRATION_POLICY = Object.freeze({
  practicalRelativeThreshold: 0.05,
  intervalObservedBoundsPerParticipant: 1,
  minimumElapsedQuanta: 4,
  pilotClusters: 3,
  maximumTargetsPerPilot: 65_536,
  timerFloorProvenance: 'four-local-steps-per-publish-batch',
  pilotClustersProvenance: 'minimum-independent-repeatability-policy',
  maximumTargetsPerPilotProvenance: 'harness-resource-safety-policy',
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
    coldMetric: 'firstPresented',
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

/** Шаг сетки для измеримого warm-batch выводится из одношаговой концентрации. */
export function deriveTimerStep(values) {
  if (!Array.isArray(values) || values.length < 16) {
    throw new Error('timer calibration: нужны минимум 16 положительных конечных delta');
  }
  const denseValues = Array.from(values);
  if (denseValues.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('timer calibration: нужны минимум 16 положительных конечных delta');
  }
  const sorted = denseValues.sort((left, right) => left - right);
  const median = sorted.length % 2
    ? sorted[sorted.length >> 1]
    : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
  if (!Number.isFinite(median) || median <= 0) {
    throw new Error('timer calibration: медиана потеряла конечность при арифметике');
  }
  const concentrated = sorted.filter((value) => Math.abs(value - median) <= median * 0.1);
  if (concentrated.length < Math.ceil(sorted.length * 0.75)) {
    throw new Error('timer calibration: delta не образуют устойчивую концентрацию');
  }
  const lower = concentrated[0];
  const upper = concentrated[concentrated.length - 1];
  let stepUpper = upper;
  for (const value of sorted) {
    if (value <= upper) continue;
    const ticks = Math.round(value / median);
    if (!Number.isSafeInteger(ticks) || ticks < 2) {
      throw new Error('timer calibration: delta вне одношаговой моды не является целочисленной гармоникой');
    }
    const low = ticks * lower;
    const high = ticks * upper;
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      throw new Error('timer calibration: delta вне одношаговой моды не является целочисленной гармоникой');
    }
    const floatingTolerance = (
      binary64Ulp(value) + binary64Ulp(low) + binary64Ulp(high)
    );
    if (
      !Number.isFinite(floatingTolerance) ||
      value < low - floatingTolerance ||
      value > high + floatingTolerance
    ) {
      throw new Error('timer calibration: delta вне одношаговой моды не является целочисленной гармоникой');
    }
    if (value > high) {
      const outward = nextUp(value / ticks);
      if (!Number.isFinite(outward)) {
        throw new Error('timer calibration: верхняя граница гармоники потеряла конечность');
      }
      stepUpper = Math.max(stepUpper, outward);
    }
  }
  // Гармоническая дельта доказывает только пропуск нескольких шагов сетки, но
  // не его причину. Верхний край одношаговой моды остаётся консервативной границей.
  return stepUpper;
}

function nextUp(value) {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, bits + (value > 0 ? 1n : -1n));
  return view.getFloat64(0);
}

function binary64Ulp(value) {
  const magnitude = Math.abs(value);
  return nextUp(magnitude) - magnitude;
}

function deriveRealmTimerBounds(name, evidence) {
  if (
    evidence?.crossOriginIsolated !== true ||
    !Array.isArray(evidence?.probes) ||
    evidence.probes.length !== 2 ||
    evidence.probes[0]?.phase !== 'before' ||
    evidence.probes[1]?.phase !== 'after'
  ) {
    throw new Error(`${name}: нужны before/after probes cross-origin isolated realm`);
  }
  const timeOriginMs = evidence.probes[0]?.timeOriginMs;
  if (!Number.isFinite(timeOriginMs) || timeOriginMs <= 0) {
    throw new Error(`${name}.before: отсутствует timeOrigin`);
  }
  const stepUpperBounds = [];
  const observedUpperBounds = [];
  for (const probe of evidence.probes) {
    if (!Number.isFinite(probe.timeOriginMs) || probe.timeOriginMs <= 0) {
      throw new Error(`${name}.${probe.phase}: отсутствует timeOrigin`);
    }
    if (probe.timeOriginMs !== timeOriginMs) {
      throw new Error(`${name}: before/after probes принадлежат разным realm`);
    }
    try {
      stepUpperBounds.push(deriveTimerStep(probe.performanceNowDeltasMs));
      observedUpperBounds.push(Math.max(...probe.performanceNowDeltasMs));
    } catch (error) {
      throw new Error(`${name}.${probe.phase}: ${error?.message ?? String(error)}`);
    }
  }
  return {
    timeOriginMs,
    stepMs: Math.max(...stepUpperBounds),
    observedUpperMs: Math.max(...observedUpperBounds),
  };
}

/** Одношаговая граница служит только для выбора измеримого warm-batch. */
export function deriveRealmTimerStep(name, evidence) {
  return deriveRealmTimerBounds(name, evidence).stepMs;
}

/** Все наблюдаемые дельты остаются консервативной границей superiority-claim. */
export function deriveRealmClockUncertainty(name, evidence) {
  return deriveRealmTimerBounds(name, evidence).observedUpperMs;
}

function assertRealmMeasurement(name, evidence, measurementTimeOriginMs, field) {
  const bounds = deriveRealmTimerBounds(name, evidence);
  if (measurementTimeOriginMs !== bounds.timeOriginMs) {
    throw new Error(`${name}: измерение и timer probes принадлежат разным realm`);
  }
  return bounds[field];
}

export function assertRealmTimerStep(name, evidence, measurementTimeOriginMs) {
  return assertRealmMeasurement(name, evidence, measurementTimeOriginMs, 'stepMs');
}

export function assertRealmClockUncertainty(name, evidence, measurementTimeOriginMs) {
  return assertRealmMeasurement(name, evidence, measurementTimeOriginMs, 'observedUpperMs');
}

/** Runtime marker и API-вызов связываются raw-часами одного page realm. */
export function deriveCdpStartClock(name, startClock, timerEvidence) {
  const clockUncertaintyMs = assertRealmClockUncertainty(
    name,
    timerEvidence,
    startClock?.pageTimeOriginMs,
  );
  if (
    typeof startClock?.token !== 'string' || startClock.token.length === 0 ||
    startClock.cdpToken !== startClock.token ||
    startClock.cdpClockDomain !== 'TimeSinceEpoch' ||
    startClock.runtimeTimestampUnit !== 'milliseconds' ||
    startClock.frameTimestampUnit !== 'seconds' ||
    !Number.isFinite(startClock.pageBeforeNowMs) || startClock.pageBeforeNowMs < 0 ||
    !Number.isFinite(startClock.pageApiNowMs) ||
    startClock.pageApiNowMs < startClock.pageBeforeNowMs ||
    !Number.isFinite(startClock.cdpRuntimeTimestampMs) || startClock.cdpRuntimeTimestampMs <= 0
  ) {
    throw new Error(`${name}: CDP start clock невалиден`);
  }
  const pageBeforeEpochMs = startClock.pageTimeOriginMs + startClock.pageBeforeNowMs;
  const pageApiEpochMs = startClock.pageTimeOriginMs + startClock.pageApiNowMs;
  if (
    startClock.cdpRuntimeTimestampMs < pageBeforeEpochMs - clockUncertaintyMs ||
    startClock.cdpRuntimeTimestampMs > pageApiEpochMs + clockUncertaintyMs
  ) {
    throw new Error(`${name}: Runtime marker не связан с page epoch`);
  }
  return {
    startedAtSeconds: startClock.cdpRuntimeTimestampMs / 1000,
    markerToApiUpperMs: (
      startClock.pageApiNowMs - startClock.pageBeforeNowMs + clockUncertaintyMs
    ),
    clockUncertaintyMs,
  };
}

function exactStringKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/**
 * Пилоты идут общими раундами: каждый участник меряется с тем же `calls`, затем
 * весь сценарий удваивается. Последний раунд обязан быть первым прошедшим.
 */
export function deriveWarmStartCalibration(
  pilots,
  participantIds,
  policy = WARM_TIMER_CALIBRATION_POLICY,
) {
  if (
    !Array.isArray(participantIds) || participantIds.length === 0 ||
    participantIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(participantIds).size !== participantIds.length
  ) {
    throw new Error('warm calibration: нужен уникальный список участников');
  }
  if (
    !Number.isFinite(policy?.practicalRelativeThreshold) ||
    policy.practicalRelativeThreshold <= 0 || policy.practicalRelativeThreshold >= 1 ||
    !Number.isSafeInteger(policy?.intervalObservedBoundsPerParticipant) ||
    policy.intervalObservedBoundsPerParticipant !== 1 ||
    !Number.isSafeInteger(policy.minimumElapsedQuanta) || policy.minimumElapsedQuanta <= 0 ||
    !Number.isSafeInteger(policy.pilotClusters) || policy.pilotClusters < 2 ||
    !Number.isSafeInteger(policy.maximumTargetsPerPilot) || policy.maximumTargetsPerPilot <= 0
  ) {
    throw new Error('warm calibration: невалидная policy');
  }

  const scenarioIds = Object.keys(START_SCENARIO_MANIFEST);
  if (!exactStringKeys(pilots, scenarioIds)) {
    throw new Error('warm calibration: pilots не совпадают со сценарной матрицей');
  }
  const effectiveWarmCalls = {};
  const scenarioManifest = {};

  for (const id of scenarioIds) {
    const config = START_SCENARIO_MANIFEST[id];
    const rounds = pilots[id];
    if (!Array.isArray(rounds) || rounds.length === 0) {
      throw new Error(`${id}: warm calibration не содержит раундов`);
    }
    let expectedCalls = config.warmCalls;
    for (let index = 0; index < rounds.length; index++) {
      const round = rounds[index];
      if (!Number.isSafeInteger(round?.calls) || round.calls !== expectedCalls) {
        throw new Error(`${id}: calls обязаны начинаться с ${config.warmCalls} и удваиваться`);
      }
      if (
        !Number.isSafeInteger(round.calls * config.targetsPerCall) ||
        round.calls * config.targetsPerCall > policy.maximumTargetsPerPilot
      ) {
        throw new Error(`${id}: warm calibration превысила лимит целей пилота`);
      }
      if (!exactStringKeys(round.measurements, participantIds)) {
        throw new Error(`${id}: measurements должны содержать ровно всех участников`);
      }
      const values = participantIds.map((participant) => round.measurements[participant]);
      if (values.some((clusters) => (
        !Array.isArray(clusters) || clusters.length !== policy.pilotClusters ||
        clusters.some((measurement) => (
          !Array.isArray(measurement?.batchElapsedMs) ||
          measurement.batchElapsedMs.length !== config.warmSamples ||
          measurement.batchElapsedMs.some((value) => !Number.isFinite(value) || value < 0)
        ))
      ))) {
        throw new Error(`${id}: measurements требуют полные конечные pilot-кластеры publish-формы`);
      }
      const passed = values.every((clusters, participant) => (
        clusters.every((measurement, cluster) => {
          const quantum = assertRealmTimerStep(
            `${id}.${participantIds[participant]} pilot ${cluster + 1}`,
            measurement.timerEvidence,
            measurement.measurementTimeOriginMs,
          );
          const minimumElapsedMs = quantum * policy.minimumElapsedQuanta;
          return measurement.batchElapsedMs.every((value) => value >= minimumElapsedMs);
        })
      ));
      if (passed && index !== rounds.length - 1) {
        throw new Error(`${id}: после первого прошедшего раунда pilots нарушают минимальность`);
      }
      if (index === rounds.length - 1) {
        if (!passed) {
          const nextCalls = round.calls * 2;
          if (
            !Number.isSafeInteger(nextCalls) ||
            nextCalls * config.targetsPerCall > policy.maximumTargetsPerPilot
          ) {
            throw new Error(`${id}: warm calibration не сошлась до лимита целей пилота`);
          }
          throw new Error(`${id}: warm calibration оборвана до сходящегося раунда`);
        }
        effectiveWarmCalls[id] = round.calls;
        scenarioManifest[id] = scenario({ ...config, warmCalls: round.calls });
      }
      expectedCalls *= 2;
    }
  }

  return Object.freeze({
    effectiveWarmCalls: Object.freeze(effectiveWarmCalls),
    scenarioManifest: Object.freeze(scenarioManifest),
  });
}

function selectFirstPresentedFrame(evidence, expectedMovementThresholdPx) {
  const startClock = deriveCdpStartClock(
    'first presented',
    evidence?.startClock,
    evidence?.timerEvidence,
  );
  if (
    !Number.isFinite(expectedMovementThresholdPx) || expectedMovementThresholdPx <= 0 ||
    evidence?.movementThresholdPx !== expectedMovementThresholdPx ||
    evidence?.startedAtSeconds !== startClock.startedAtSeconds ||
    !Number.isSafeInteger(evidence?.rawFrames) || evidence.rawFrames <= 0 ||
    !Array.isArray(evidence?.frames) || evidence.frames.length < 2 ||
    evidence.rawFrames < evidence.frames.length
  ) {
    throw new Error('first presented: невалидные evidence или threshold');
  }
  let previousTimestamp = -Infinity;
  let baseline;
  for (const frame of evidence.frames) {
    if (
      !Number.isFinite(frame?.timestampSeconds) || frame.timestampSeconds <= previousTimestamp ||
      !Number.isFinite(frame?.x)
    ) {
      throw new Error('first presented: кадры обязаны иметь строгий timestamp-порядок');
    }
    previousTimestamp = frame.timestampSeconds;
    if (frame.timestampSeconds < evidence.startedAtSeconds) baseline = frame.x;
  }
  if (baseline === undefined) {
    throw new Error('first presented: нет baseline-кадра до старта');
  }
  const moved = evidence.frames.find((frame) => (
    frame.timestampSeconds > evidence.startedAtSeconds &&
    Math.abs(frame.x - baseline) >= expectedMovementThresholdPx
  ));
  return { startClock, baseline, moved };
}

/** Первый сдвинувшийся пиксель выводится только из timestamp кадров скринкаста. */
export function deriveFirstPresentedElapsedMs(evidence, expectedMovementThresholdPx) {
  const { moved } = selectFirstPresentedFrame(evidence, expectedMovementThresholdPx);
  return moved === undefined
    ? null
    : (moved.timestampSeconds - evidence.startedAtSeconds) * 1000;
}

/** Clock uncertainty для first-presented claim выводится только из raw evidence. */
export function deriveFirstPresentedUncertaintyMs(evidence, expectedMovementThresholdPx) {
  const { startClock, moved } = selectFirstPresentedFrame(
    evidence,
    expectedMovementThresholdPx,
  );
  const elapsedMs = moved === undefined
    ? null
    : (moved.timestampSeconds - evidence.startedAtSeconds) * 1000;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error('first presented uncertainty: нет положительного moved-frame sample');
  }
  const elapsedSeconds = moved.timestampSeconds - evidence.startedAtSeconds;
  const binary64BoundMs = (
    binary64Ulp(moved.timestampSeconds) +
    binary64Ulp(evidence.startedAtSeconds) +
    binary64Ulp(elapsedSeconds)
  ) * 1000;
  return startClock.markerToApiUpperMs + binary64BoundMs;
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

/** Долгий browser-run падает на первом потерянном измерении, не через часы. */
export function assertPositiveFiniteSamples(name, values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${name}: samples обязаны быть непустым массивом`);
  }
  const invalidSample = values.findIndex((value) => !Number.isFinite(value) || value <= 0);
  if (invalidSample !== -1) {
    throw new Error(
      `${name}: sample ${invalidSample + 1}=${String(values[invalidSample])} ` +
      'не является положительным конечным числом',
    );
  }
}

/** Raw batch остаётся измеримым и является SSOT для публикуемой per-call цены. */
export function assertWarmStartMeasurement(
  name,
  samples,
  batchElapsedMs,
  calls,
  timerEvidence,
  measurementTimeOriginMs,
  policy = WARM_TIMER_CALIBRATION_POLICY,
) {
  if (
    !Number.isSafeInteger(calls) || calls <= 0 ||
    !Number.isSafeInteger(policy?.minimumElapsedQuanta) || policy.minimumElapsedQuanta <= 0
  ) {
    throw new Error(`${name}: calls и minimumElapsedQuanta обязаны быть положительными целыми`);
  }
  const timerStepMs = assertRealmTimerStep(
    name,
    timerEvidence,
    measurementTimeOriginMs,
  );
  const minimumElapsedMs = timerStepMs * policy.minimumElapsedQuanta;
  assertPositiveFiniteSamples(name, samples);
  assertPositiveFiniteSamples(`${name}: raw batch`, batchElapsedMs);
  if (samples.length !== batchElapsedMs.length) {
    throw new Error(`${name}: samples и raw batch имеют разную длину`);
  }
  for (let sample = 0; sample < samples.length; sample++) {
    if (samples[sample] !== batchElapsedMs[sample] / calls) {
      throw new Error(`${name}: sample ${sample + 1} не пересчитывается из raw batch`);
    }
    if (batchElapsedMs[sample] < minimumElapsedMs) {
      throw new Error(
        `${name}: raw batch sample ${sample + 1}=${batchElapsedMs[sample]} ` +
        `ниже timer floor ${minimumElapsedMs}`,
      );
    }
  }
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
    assertPositiveFiniteSamples(`${name}: cluster ${index + 1}`, cluster.samples);
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
  const relativeGain = 1 - evidence.p50.ratio;
  const absoluteGain = evidence.p50.competitor - evidence.p50.lab;
  const gates = {
    confidence: evidence.p50.high < 1,
    practicalRelative: relativeGain >= relativeThreshold,
    clockResolved: absoluteGain > absoluteThreshold,
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
