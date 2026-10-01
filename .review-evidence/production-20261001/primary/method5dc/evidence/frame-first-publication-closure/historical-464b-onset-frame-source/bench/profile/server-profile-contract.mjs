import { isDeepStrictEqual } from 'node:util';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertBalancedRunBlocks, assertRealmTimerStep, binary64Ulp, deriveRealmTimerStep, evaluateStartSemanticEvidence,
  exactBinomialOrderStatisticBounds, makeRoundRobinOrders, nextDown, nextUp, summarizeSamples } from '../compare/methodology.mjs';
import { sha256Bytes } from '../compare/provenance.mjs';
import { TRANSFORM_PAIR_PROFILE, validateTransformLifecycleSample } from '../../scripts/bench-transform-support.mjs';
import { SERVER_PROFILE, planServerSampleSize, serverProfileDigest, serverTailPolicy, verifyServerProfile } from './server-profile-registration.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const IDS = ['left', 'right'];
function invariant(value, message) {
  if (!value) throw new Error(`server profile: ${message}`);
}
function positive(value) { return Number.isFinite(value) && value > 0; }

function meanBounds(bounds, denominator) {
  let low = 0, high = 0;
  for (const bound of bounds) {
    low = Math.max(0, nextDown(low + bound.low)); high = nextUp(high + bound.high);
  }
  return { low: Math.max(0, nextDown(low / denominator)), high: nextUp(high / denominator) };
}

function errorBounds(value, error) {
  invariant(Number.isFinite(value) && value >= 0 && positive(error), 'невалидная clock error boundary');
  return { low: Math.max(0, nextDown(value - error)), high: nextUp(value + error) };
}

// Observed quantum не удостоверяет error model. Error берётся из закреплённого
// upstream TimeClamper/TimeTicks и учитывает float conversion обеих reads.
export function serverBrowserClockBounds(clock, monotonicHostUpperNs) {
  invariant(/^\d+$/.test(monotonicHostUpperNs ?? ''), 'нет общего CLOCK_MONOTONIC bound');
  const ns = BigInt(monotonicHostUpperNs);
  invariant(ns > 0n && ns < BigInt(SERVER_PROFILE.clockError.monotonicCounterLimitMs) * 1_000_000n, 'CLOCK_MONOTONIC вне safe модели');
  // Запас1ms превышает conversion error Number(ns)/1e6 при limit2^42ms.
  const upperMs = nextUp(Number(ns) / 1e6 + 1);
  invariant(Number.isFinite(clock?.beginMs) && Number.isFinite(clock?.endMs) && clock.beginMs >= 0 &&
    clock.endMs >= clock.beginMs && clock.endMs <= upperMs, 'невалидные clock reads');
  const measuredMs = clock.endMs - clock.beginMs;
  const endpointError = SERVER_PROFILE.clockError.browserClampErrorPerTimestampMs + SERVER_PROFILE.clockError.browserTickTruncationPerTimestampMs;
  // Две conversions(now/origin) и subtraction на каждую read; ещё одна
  // subtraction интервала. Origin одинаков, но его ошибка включена консервативно.
  const errorMs = nextUp(nextUp(2 * endpointError) + nextUp(6 * binary64Ulp(upperMs) + binary64Ulp(measuredMs)));
  return { ...errorBounds(measuredMs, errorMs), measuredMs, errorMs };
}

// В perf интервале общий origin сокращается. Сопоставление document frame
// с perf API включает три coarsened timestamps: frame, now и origin.
// Та же закреплённая модель даёт три endpoint envelopes и девять ULP;
// это semantic relation, не изменение uncertainty измеряемых API costs.
export function serverBrowserSemanticClockErrorMs(monotonicHostUpperNs) {
  return nextUp(1.5 * serverBrowserClockBounds({ beginMs: 0, endMs: 0 }, monotonicHostUpperNs).errorMs);
}

function compactCoordinates(values) {
  if (!Array.isArray(values)) return values;
  const runs = [];
  for (const value of values) {
    if (runs.length && Object.is(runs.at(-1)[1], value)) runs.at(-1)[0]++;
    else runs.push([1, value]);
  }
  return { encoding: 'rle', count: values.length, runs };
}

function expandCoordinates(values, count) {
  if (Array.isArray(values)) { invariant(values.length === count && Array.from(values).every(Number.isFinite), 'неполные normal-motion coordinates'); return values; }
  invariant(values?.encoding === 'rle' && values.count === count && Array.isArray(values.runs) &&
    isDeepStrictEqual(Object.keys(values).sort(), ['count', 'encoding', 'runs']), 'неполные normal-motion RLE coordinates');
  const expanded = [];
  for (const run of values.runs) {
    invariant(Array.isArray(run) && run.length === 2 && Number.isSafeInteger(run[0]) && run[0] > 0 &&
      Number.isFinite(run[1]) && expanded.length + run[0] <= count, 'невалидный normal-motion RLE run');
    for (let i = 0; i < run[0]; i++) expanded.push(run[1]);
  }
  invariant(expanded.length === count, 'normal-motion RLE потерял targets');
  return expanded;
}

function compactSemanticGroups(groups) {
  if (!Array.isArray(groups)) return groups;
  return groups.map((group) => group && typeof group === 'object' && !Array.isArray(group) && Object.hasOwn(group, 'positions')
    ? { ...group, positions: compactCoordinates(group.positions) } : group);
}

export function compactServerSemanticEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return evidence;
  // Отказ сохраняет приобретённый prefix и дополнительные поля, без создания отсутствующих наблюдений.
  const compact = { ...evidence };
  if (Array.isArray(evidence.checkpoints)) compact.checkpoints = evidence.checkpoints.map((checkpoint) =>
    checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) && Object.hasOwn(checkpoint, 'groups')
      ? { ...checkpoint, groups: compactSemanticGroups(checkpoint.groups) } : checkpoint);
  if (Array.isArray(evidence.terminal)) compact.terminal = evidence.terminal.map(compactCoordinates);
  if (evidence.onset && typeof evidence.onset === 'object' && !Array.isArray(evidence.onset)) {
    compact.onset = { ...evidence.onset };
    for (const phase of ['before', 'after']) {
      if (Object.hasOwn(evidence.onset, phase)) compact.onset[phase] = compactSemanticGroups(evidence.onset[phase]);
    }
  }
  return compact;
}

function validateNormalMotion(evidence, scene, monotonicHostUpperNs) {
  invariant(evidence?.valid === true && Array.isArray(evidence.checkpoints) && Array.isArray(evidence.terminal), 'нет normal-motion oracle');
  invariant(!evidence.failures?.length, 'normal-motion control потерял failure');
  const calls = SERVER_PROFILE.browserSemanticCalls;
  invariant(evidence.terminal.length === calls && evidence.checkpoints.length === 3, 'потерян normal-motion checkpoint/call');
  invariant(evidence.onset && typeof evidence.onset === 'object' && !Array.isArray(evidence.onset), 'нет normal-motion onset observations');
  const onset = { ...evidence.onset };
  for (const phase of ['before', 'after']) {
    invariant(Array.isArray(onset[phase]) && onset[phase].length === calls, `потеряна normal-motion onset ${phase} группа`);
    onset[phase] = Array.from(onset[phase], (group) => {
      invariant(group && typeof group === 'object' && !Array.isArray(group), `невалидная normal-motion onset ${phase} группа`);
      return { ...group, positions: expandCoordinates(group.positions, scene.targetsPerCall) };
    });
  }
  // Clock/zero/phase law принадлежит общему oracle; decoder восстанавливает каждый target.
  const expanded = { ...evidence, onset, checkpoints: evidence.checkpoints.map((checkpoint) => {
    invariant(Number.isFinite(checkpoint.frameTimestampMs), 'нет observed normal-motion frame timestamp');
    invariant(Array.isArray(checkpoint.groups) && checkpoint.groups.length === calls, 'потеряна normal-motion группа');
    return { ...checkpoint, groups: checkpoint.groups.map((group) => ({ ...group, positions: expandCoordinates(group.positions, scene.targetsPerCall) })) };
  }), terminal: evidence.terminal.map((values) => expandCoordinates(values, scene.targetsPerCall)) };
  const semanticClockErrorMs = serverBrowserSemanticClockErrorMs(monotonicHostUpperNs);
  const observedTimes = [...expanded.callStartedAtMs, ...['before', 'after'].flatMap((phase) => expanded.onset[phase]
    .flatMap((group) => [group.readStartedMs, group.readEndedMs, group.documentFrame?.beforeMs, group.documentFrame?.afterMs])), ...expanded.checkpoints.flatMap((checkpoint) =>
    [checkpoint.frameTimestampMs, ...checkpoint.groups.flatMap((group) => [group.readStartedMs, group.readEndedMs,
      group.documentFrame?.beforeMs, group.documentFrame?.afterMs])])];
  invariant(observedTimes.every(Number.isFinite), 'неполные normal-motion clock observations');
  serverBrowserClockBounds({ beginMs: 0, endMs: Math.max(...observedTimes.map(Math.abs)) }, monotonicHostUpperNs);
  invariant(evaluateStartSemanticEvidence(expanded, { ...scene, ...SERVER_PROFILE.browserSemantics, semanticClockErrorMs,
    durationMs: SERVER_PROFILE.durationMs, toPx: SERVER_PROFILE.toPx }, calls), 'normal-motion oracle отверг intermediate/stagger/topology');
}

export function verifyServerClockRegistration(registration) {
  const model = SERVER_PROFILE.clockError;
  invariant(registration.browser === model.browser && registration.browserVersion === model.browserVersion &&
    registration.browserExecutableSha256 === model.browserExecutableSha256 && registration.clockModelDigest === serverProfileDigest(model),
  'browser binary/clock model не сертифицированы этим протоколом');
  const identity = registration.machine?.identity;
  invariant(identity?.platform === 'linux' && identity.release === model.kernelRelease && identity.node === model.nodeVersion && identity.nodeExecutableSha256 === model.nodeExecutableSha256,
    'Node binary/platform не сертифицированы clock model');
  for (const provenance of Object.values(registration.provenance ?? {})) invariant(provenance.environment?.node === model.nodeVersion &&
    provenance.environment.nodeExecutableSha256 === model.nodeExecutableSha256, 'source toolchain не совпадает с clock model');
}

export function serverOrders(runs, seed = SERVER_PROFILE.seed) {
  const orders = makeRoundRobinOrders(IDS, runs, seed);
  assertBalancedRunBlocks('server profile', orders, IDS);
  return orders;
}

export function serverMetricCells() {
  return [
    ...SERVER_PROFILE.engineScenes.flatMap((scene) => SERVER_PROFILE.metrics.engine.map((metric) => ({ id: `${scene.id}:${metric}`, scene: scene.id, kind: 'engine', metric }))),
    ...SERVER_PROFILE.browserScenes.flatMap((scene) => SERVER_PROFILE.metrics.browser.map((metric) => ({ id: `${scene.id}:${metric}`, scene: scene.id, kind: 'browser', metric }))),
  ];
}

// Кадры/повторы остаются в raw. Admission использует один нормированный batch
// на run; независимая порядковая статистика использует среднее двух runs блока.
export function serverCellPairs(stage, runs, expectedStage) {
  invariant(['warmup', 'pilot', 'aa', 'positive', 'ab'].includes(expectedStage) && stage?.name === expectedStage, 'имя стадии не соответствует владельцу artifact');
  invariant(stage?.rows?.length === runs * (SERVER_PROFILE.engineScenes.length + SERVER_PROFILE.browserScenes.length), 'неполная серия измерений');
  const expectedOrders = serverOrders(runs);
  const seen = new Set();
  // Один sample имеет несколько проекций метрик. Проверка приобретённого raw
  // принадлежит sample/scene/work, а не повторяется для каждой проекции.
  const validationCache = new WeakMap();
  for (const row of stage.rows) {
    const key = `${row.scene}:${row.run}`;
    invariant(!seen.has(key), 'повторный run'); seen.add(key);
    invariant(Number.isSafeInteger(row.run) && row.run >= 0 && row.run < runs &&
      isDeepStrictEqual(row.order, expectedOrders[row.run]), 'нарушен зарегистрированный порядок');
    invariant(isDeepStrictEqual(Object.keys(row.samples ?? {}).sort(), IDS), 'потерян участник');
  }
  return serverMetricCells().map((cell) => {
    const rows = stage.rows.filter((row) => row.scene === cell.scene).sort((a, b) => a.run - b.run);
    invariant(rows.length === runs, 'потеряна сцена');
    invariant(rows.every((row) => row.kind === cell.kind), 'подменён вид сцены');
    const read = Object.fromEntries(IDS.map((id) => [id, rows.map((row) => readServerSample(row.samples[id], cell,
      expectedStage === 'positive' && id === 'right' ? 2 : 1, validationCache))]));
    return { ...cell, left: read.left.map((row) => row.value), right: read.right.map((row) => row.value),
      leftBounds: read.left.map((row) => row.bounds), rightBounds: read.right.map((row) => row.bounds) };
  });
}

function readServerSample(sample, cell, workMultiplier, validationCache = new WeakMap()) {
      invariant(sample?.semantic === true && positive(sample[cell.metric]), `${cell.id}: неверный sample или semantics`);
      invariant(sample.workMultiplier === workMultiplier, 'подменён знаменатель положительного контроля');
      invariant(sample.denominator === SERVER_PROFILE.denominator && sample.repetitions === SERVER_PROFILE.repetitions, 'изменён знаменатель');
      invariant(Array.isArray(sample.raw) && sample.raw.length === sample.repetitions * (cell.kind === 'engine' ? sample.workMultiplier : 1), 'потеряны raw повторы');
      const validationKey = `${cell.kind}:${cell.scene}:${workMultiplier}`;
      if (!validationCache.get(sample)?.has(validationKey)) {
      if (cell.kind === 'engine') {
        const scene = SERVER_PROFILE.engineScenes.find((scene) => scene.id === cell.scene);
        for (const raw of sample.raw) {
          invariant(Array.isArray(raw.frameNs) && raw.frameNs.length === TRANSFORM_PAIR_PROFILE.frameOffsetsMs.length &&
            raw.frameNs.every((x) => Number.isSafeInteger(x) && x >= 0) && Number.isSafeInteger(raw.operationNs) && raw.operationNs >= 0 &&
            Number.isSafeInteger(raw.cancelDrainNs) && raw.cancelDrainNs >= 0, 'потеряны frame samples или safe CPU counter');
          validateTransformLifecycleSample(raw, scene);
          const clockReads = raw.raw.clockReads, cpuReads = raw.raw.cpuReads;
          invariant(Array.isArray(cpuReads) && cpuReads.length === clockReads.length, 'потеряны actual thread CPU fields');
          for (let sequence = 0; sequence < cpuReads.length; sequence++) {
            const read = cpuReads[sequence];
            invariant(read?.sequence === sequence && Number.isSafeInteger(read.userUs) && read.userUs >= 0 &&
              Number.isSafeInteger(read.systemUs) && read.systemUs >= 0, 'невалидные user/system CPU fields');
            const valueNs = String((BigInt(read.userUs) + BigInt(read.systemUs)) * 1000n);
            invariant(read.valueNs === valueNs && clockReads[sequence].valueNs === valueNs, 'CPU endpoint не пересчитывается из user/system');
            if (sequence > 0) invariant(read.userUs >= cpuReads[sequence - 1].userUs && read.systemUs >= cpuReads[sequence - 1].systemUs,
              'user/system CPU fields идут назад');
          }
          const semantic = raw.semantic;
          invariant(semantic?.valid === true && semantic.targets === scene.count && semantic.frames === raw.frameNs.length &&
            semantic.finished === true && semantic.pending === 0 && semantic.onCompleteCalls === 0 &&
            semantic.previousFinished === (scene.lifecycle === 'fresh' ? null : true) && semantic.previousCompleteCalls === 0 &&
            validTraceHashes(semantic.targetTraceHashes, scene.count), 'невалидный lifecycle witness');
        }
      } else {
        const step = deriveRealmTimerStep('server sample', sample.timerEvidence);
        assertRealmTimerStep('server sample', sample.timerEvidence, sample.measurementTimeOriginMs);
        invariant(sample.timerStepMs === step && sample.clockModelDigest === serverProfileDigest(SERVER_PROFILE.clockError), 'clock evidence/model не совпадают');
        const scene = SERVER_PROFILE.browserScenes.find((scene) => scene.id === cell.scene);
        validateNormalMotion(sample.semanticEvidence, scene, sample.monotonicHostUpperNs);
        invariant(Array.isArray(sample.endpoints) && sample.endpoints.length === scene.targetsPerCall &&
          sample.endpoints.every((x) => Number.isFinite(x) && Math.abs(x - SERVER_PROFILE.toPx) <= 2), 'невалидный endpoint witness');
        invariant(Array.isArray(sample.warmup) && sample.warmup.length === 1, 'потерян warmup batch');
        for (const raw of [...sample.raw, ...sample.warmup]) {
          const calls = SERVER_PROFILE.browserBatchCalls * workMultiplier;
          invariant(raw.calls === calls && raw.ownersStarted === calls && raw.ownersCancelled === calls, 'batch потерял полезные owner outcomes');
          const start = serverBrowserClockBounds(raw.startClock, sample.monotonicHostUpperNs), cancel = serverBrowserClockBounds(raw.cancelClock, sample.monotonicHostUpperNs);
          invariant(raw.batchStartMs === start.measuredMs && raw.batchCancelMs === cancel.measuredMs &&
            raw.startMs === raw.batchStartMs / SERVER_PROFILE.browserBatchCalls && raw.cancelMs === raw.batchCancelMs / SERVER_PROFILE.browserBatchCalls &&
            raw.cancelClock.beginMs >= raw.startClock.endMs, 'batch clock reads/знаменатель не воспроизводятся');
          validateStartWitness(raw, scene, sample.monotonicHostUpperNs);
          validateCancellationWitness(raw, calls * scene.targetsPerCall);
        }
        validateCancellationWitness({ cancelMs: sample.controlCancelMs, cancelWitness: sample.controlCancelWitness }, scene.targetsPerCall);
      }
      const checked = validationCache.get(sample) ?? new Set(); checked.add(validationKey); validationCache.set(sample, checked);
      }
      const rawValues = sample.raw.map((value) => cell.metric === 'meanFrameNs'
        ? value.frameNs?.reduce((a, b) => a + b, 0) / value.frameNs?.length : value[cell.metric]);
      invariant(rawValues.every(positive), 'некорректные raw timing');
      const recomputed = rawValues.reduce((a, b) => a + b, 0) / sample.repetitions;
      invariant(recomputed === sample[cell.metric], 'timing не пересчитывается из raw / знаменателя');
      const pointwise = sample.raw.map((raw) => {
        if (cell.kind === 'engine') return cell.metric === 'meanFrameNs'
          ? meanBounds(raw.frameNs.map((value) => errorBounds(value, SERVER_PROFILE.clockError.engineIntervalUncertaintyNs)), raw.frameNs.length)
          : errorBounds(raw[cell.metric], SERVER_PROFILE.clockError.engineIntervalUncertaintyNs);
        const interval = serverBrowserClockBounds(cell.metric === 'startMs' ? raw.startClock : raw.cancelClock, sample.monotonicHostUpperNs);
        return meanBounds([interval], SERVER_PROFILE.browserBatchCalls);
      });
      return { value: sample[cell.metric], bounds: meanBounds(pointwise, sample.repetitions) };
}

export function validateServerBrowserSample(sample, scene, workMultiplier = 1) {
  const validationCache = new WeakMap();
  for (const metric of SERVER_PROFILE.metrics.browser) readServerSample(sample,
    { id: `${scene.id}:${metric}`, kind: 'browser', scene: scene.id, metric }, workMultiplier, validationCache);
}

export function validateServerEngineSample(sample, scene, workMultiplier = 1) {
  const validationCache = new WeakMap();
  for (const metric of SERVER_PROFILE.metrics.engine) readServerSample(sample,
    { id: `${scene.id}:${metric}`, kind: 'engine', scene: scene.id, metric }, workMultiplier, validationCache);
}

function coordinateReader(values, count, label) {
  if (Array.isArray(values)) {
    invariant(values.length === count && Array.from(values).every(Number.isFinite), `неполные ${label} coordinates`);
    return { at: (index) => values[index], runs: null };
  }
  if (values?.encoding === 'repeat') {
    invariant(values.count === count && Number.isFinite(values.value) &&
      isDeepStrictEqual(Object.keys(values).sort(), ['count', 'encoding', 'value']), `неполные ${label} RLE coordinates`);
    return { at: () => values.value, runs: [[count, values.value]] };
  }
  invariant(values?.encoding === 'rle' && values.count === count && Array.isArray(values.runs) &&
    isDeepStrictEqual(Object.keys(values).sort(), ['count', 'encoding', 'runs']), `неполные ${label} RLE coordinates`);
  let expanded = 0;
  const ends = values.runs.map((run) => {
    invariant(Array.isArray(run) && run.length === 2 && Number.isSafeInteger(run[0]) && run[0] > 0 && Number.isFinite(run[1]) &&
      expanded + run[0] <= count, `невалидный ${label} RLE run`);
    expanded += run[0]; return expanded;
  });
  invariant(expanded === count, `${label} RLE потерял targets`);
  return { runs: values.runs, at: (index) => {
    let low = 0, high = ends.length - 1;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (index < ends[middle]) high = middle; else low = middle + 1; }
    return values.runs[low][1];
  } };
}

function validateStartWitness(raw, scene, monotonicHostUpperNs) {
  const witness = raw.startWitness;
  invariant(witness?.connectedTargets === raw.calls * scene.targetsPerCall && Number.isSafeInteger(witness.activeWaapi) && witness.activeWaapi >= 0,
    'start batch потерял attached targets');
  const leading = coordinateReader(witness.leadingPositions, raw.calls, 'start');
  invariant(witness.readClock?.beginMs >= raw.startClock.endMs && witness.readClock.endMs >= witness.readClock.beginMs &&
    raw.cancelClock.beginMs >= witness.readClock.endMs, 'start observation не соответствует clock chronology');
  const window = serverBrowserClockBounds({ beginMs: raw.startClock.beginMs, endMs: witness.readClock.endMs }, monotonicHostUpperNs);
  invariant(window.high < SERVER_PROFILE.durationMs * (1 - SERVER_PROFILE.browserSemantics.finalTolerancePx / SERVER_PROFILE.toPx),
    'start batch не разрешил окно до линейного endpoint');
  // Каждый свежий owner вызван после batch begin, а CSS прочитан до read end.
  // Общая верхняя граница elapsed учитывает обе clock reads и float roundoff.
  const maximumPosition = nextUp(nextUp(nextUp(SERVER_PROFILE.toPx / SERVER_PROFILE.durationMs) * window.high) +
    SERVER_PROFILE.browserSemantics.movementThresholdPx);
  for (let call = 0; call < raw.calls; call++) {
    const position = leading.at(call);
    invariant(position >= -SERVER_PROFILE.browserSemantics.finalTolerancePx &&
      position < SERVER_PROFILE.toPx - SERVER_PROFILE.browserSemantics.finalTolerancePx, 'timed owner мгновенно достиг endpoint до duration');
    invariant(position >= SERVER_PROFILE.browserSemantics.fromPx - SERVER_PROFILE.browserSemantics.movementThresholdPx &&
      position <= maximumPosition, 'timed onset не соответствует свежему началу и actual clock окну');
  }
}

function validateCancellationWitness(raw, targets) {
  const witness = raw.cancelWitness;
  invariant(witness?.connectedTargets === targets && witness.activeWaapiBefore === 0 && positive(witness.cancelDrainMs) &&
    witness.cancelDrainMs >= (raw.batchCancelMs ?? raw.cancelMs) && Array.isArray(witness.frames) &&
    witness.frames.length === SERVER_PROFILE.browserCancellationWitness.frames, 'невалидный cancel/drain witness');
  const before = coordinateReader(witness.transformsBefore, targets, 'cancel');
  for (const frame of witness.frames) {
    invariant(frame.connectedTargets === targets && frame.activeWaapi === 0, 'cancel не достиг attached-target quiescence');
    const after = coordinateReader(frame.transforms, targets, 'cancel');
    if (before.runs && after.runs) {
      let left = 0, right = 0, leftRemaining = before.runs[0][0], rightRemaining = after.runs[0][0];
      while (left < before.runs.length && right < after.runs.length) {
        invariant(Math.abs(after.runs[right][1] - before.runs[left][1]) <= SERVER_PROFILE.browserCancellationWitness.transformTolerancePx,
          'cancel не достиг наблюдаемой неподвижности attached targets');
        const step = Math.min(leftRemaining, rightRemaining); leftRemaining -= step; rightRemaining -= step;
        if (leftRemaining === 0 && ++left < before.runs.length) leftRemaining = before.runs[left][0];
        if (rightRemaining === 0 && ++right < after.runs.length) rightRemaining = after.runs[right][0];
      }
    } else for (let target = 0; target < targets; target++) invariant(Math.abs(after.at(target) - before.at(target)) <= SERVER_PROFILE.browserCancellationWitness.transformTolerancePx,
      'cancel не достиг наблюдаемой неподвижности attached targets');
  }
}

function unsupportedComparator(scene, id) {
  return scene.staggerGapMs > 0 && ['motion-mini', 'anime-waapi'].includes(id);
}

export function serverComparatorPlan(runs) {
  return SERVER_PROFILE.browserScenes.flatMap((scene) => SERVER_PROFILE.comparators.flatMap((id) => unsupportedComparator(scene, id) ? []
    : Array.from({ length: runs }, (_, run) => ({ scene: scene.id, id, run }))));
}

function validateSupplementalSamples(artifact) {
  const validationCache = new WeakMap();
  invariant(Array.isArray(artifact.comparators) && artifact.comparators.length === SERVER_PROFILE.browserScenes.length * SERVER_PROFILE.comparators.length,
    'потеряны обязательные comparator cells');
  let index = 0;
  for (const scene of SERVER_PROFILE.browserScenes) for (const id of SERVER_PROFILE.comparators) {
    const comparator = artifact.comparators[index++];
    invariant(comparator?.scene === scene.id && comparator.id === id, 'comparator cells не соответствуют плану');
    if (unsupportedComparator(scene, id)) {
      invariant(comparator.status === 'UNPROVEN' && typeof comparator.reason === 'string' && comparator.reason.length > 0 && !comparator.rows,
        'несуществующий stagger API объявлен измеренным');
      continue;
    }
    invariant(Array.isArray(comparator.rows) && comparator.rows.length === artifact.samplePlan.runs, 'потеряны raw comparator samples');
    for (const sample of comparator.rows) for (const metric of SERVER_PROFILE.metrics.browser) readServerSample(sample,
      { id: `${id}:${scene.id}:${metric}`, kind: 'browser', scene: scene.id, metric }, 1, validationCache);
  }
  invariant(isDeepStrictEqual(Object.keys(artifact.retention ?? {}).sort(), ['baseline', 'candidate']), 'потерян отдельный retention child');
  for (const report of Object.values(artifact.retention)) {
    invariant(report.verdict === 'COMPLETE' && report.failure === null && Array.isArray(report.rows) && report.rows.length === SERVER_PROFILE.engineScenes.length,
      'retention child не завершён');
    report.rows.forEach((row, index) => {
      invariant(row.scene === SERVER_PROFILE.engineScenes[index].id && Number.isSafeInteger(row.before?.heapUsed) && row.before.heapUsed >= 0 &&
        Number.isSafeInteger(row.after?.heapUsed) && row.after.heapUsed >= 0 && row.retainedHeapDeltaBytes === row.after.heapUsed - row.before.heapUsed,
      'retained heap delta не воспроизводится');
    });
  }
}

function validTraceHashes(hashes, expectedCount) {
  if (Array.isArray(hashes)) return hashes.length === expectedCount && hashes.every((hash) => SHA256.test(hash));
  return hashes?.encoding === 'repeat' && hashes.count === expectedCount && SHA256.test(hashes.value) &&
    isDeepStrictEqual(Object.keys(hashes).sort(), ['count', 'encoding', 'value']);
}

// Для зарегистрированных q=1/2,19/20 и alpha=1/1600 ranks сравниваются
// точно в BigInt. Float underflow и погрешность суммирования не дают admission.
export function serverOrderStatisticBounds(values, probability, alphaPerTail) {
  invariant(Array.isArray(values) && values.length > 0 && values.every((x) => Number.isFinite(x) && x >= 0) &&
    probability > 0 && probability < 1 && alphaPerTail > 0 && alphaPerTail < 0.5, 'невалидная порядковая статистика');
  invariant(probability === 0.5 || probability === 0.95, 'вероятность вне зарегистрированных exact квантилей');
  const [numerator, denominator] = probability === 0.5 ? [1n, 2n] : [19n, 20n];
  const alphaDenominator = BigInt(SERVER_PROFILE.familySize * 2 * 2 * 2 * 20);
  invariant(alphaPerTail === 1 / Number(alphaDenominator), 'alpha вне зарегистрированного exact семейства');
  return exactBinomialOrderStatisticBounds(values, [numerator, denominator], [1n, alphaDenominator]);
}

export function serverFamilyIntervals(pairs) {
  invariant(Array.isArray(pairs) && pairs.length === SERVER_PROFILE.familySize, 'неполное семейство CI');
  const policy = serverTailPolicy();
  return pairs.map(({ id, left, right, leftBounds, rightBounds }) => {
    invariant(Array.isArray(left) && left.length >= 8 && left.length % 2 === 0 && right?.length === left.length &&
      [...left, ...right].every(positive), 'некорректные парные CI данные');
    for (const [values, bounds] of [[left, leftBounds], [right, rightBounds]]) invariant(Array.isArray(bounds) && bounds.length === values.length &&
      bounds.every((bound, index) => Number.isFinite(bound?.low) && Number.isFinite(bound?.high) && bound.low >= 0 &&
        bound.low <= values[index] && bound.high >= values[index]), 'нет pointwise clock uncertainty до CI');
    const blockMeans = (values) => Array.from({ length: values.length / 2 }, (_, block) => (values[block * 2] + values[block * 2 + 1]) / 2);
    const blockBounds = (bounds) => Array.from({ length: bounds.length / 2 }, (_, block) => meanBounds(bounds.slice(block * 2, block * 2 + 2), 2));
    const l = blockMeans(left), r = blockMeans(right), lb = blockBounds(leftBounds), rb = blockBounds(rightBounds);
    const boundedStatistics = (values, bounds, p) => ({ ...serverOrderStatisticBounds(values, p, policy.alphaPerTail),
      low: serverOrderStatisticBounds(bounds.map((bound) => bound.low), p, policy.alphaPerTail).low,
      high: serverOrderStatisticBounds(bounds.map((bound) => bound.high), p, policy.alphaPerTail).high });
    return { id, blocks: left.length / 2, runs: left.length, unit: SERVER_PROFILE.samplingUnit,
      correction: policy.correction, method: 'pointwise-clock-bounds+exact-binomial-order-statistics', assumption: SERVER_PROFILE.stationarityAssumption,
      ...Object.fromEntries([['p50', 0.5], ['p95', 0.95]].map(([key, p]) => {
        const baseline = boundedStatistics(l, lb, p);
        const candidate = boundedStatistics(r, rb, p);
        return [key, { ratio: candidate.estimate / baseline.estimate,
          low: baseline.high === null ? 0 : Math.max(0, nextDown(candidate.low / baseline.high)),
          high: candidate.high === null || baseline.low === 0 ? null : nextUp(candidate.high / baseline.low),
          bounded: candidate.high !== null && baseline.high !== null && baseline.low > 0 && candidate.low > 0,
          baseline, candidate }];
      })) };
  });
}

export function serverCalibrationVerdict(aa, positiveControl, samplePlan) {
  const reasons = [];
  if (!samplePlan.feasible) reasons.push(`null-pilot требует ${samplePlan.requiredRuns} run, предел ${SERVER_PROFILE.maxRuns}`);
  for (const cell of aa) {
    if (!cell.p95.bounded || !cell.p50.bounded || cell.p95.high > SERVER_PROFILE.nonInferiorityUpper || cell.p95.low < 1 / SERVER_PROFILE.nonInferiorityUpper ||
        cell.p50.high > SERVER_PROFILE.nonInferiorityUpper || cell.p50.low < 1 / SERVER_PROFILE.nonInferiorityUpper) {
      reasons.push(`${cell.id}: A/A не удержал двустороннюю полосу 1/1.05…1.05`);
    }
  }
  for (const cell of positiveControl) if (!cell.p50.bounded || cell.p50.low <= SERVER_PROFILE.positiveLower) reasons.push(`${cell.id}: 2×work не различён`);
  return { verdict: reasons.length ? 'UNPROVEN' : 'PASS', reasons };
}

export function serverResourceReasons(stages, identity) {
  const reasons = [];
  invariant(/^\d+$/.test(identity?.affinity) && typeof identity.cgroupCpuMax === 'string' && identity.cgroupCpuMax.length > 0,
    'ресурсные observations не связаны с зарегистрированным machine');
  for (const stage of stages) {
    const rowsPerBlock = (SERVER_PROFILE.engineScenes.length + SERVER_PROFILE.browserScenes.length) * 2;
    invariant(Array.isArray(stage.blocks) && stage.blocks.length === stage.rows.length / rowsPerBlock, 'нет наблюдений ресурсов каждого парного блока');
    for (let index = 0; index < stage.blocks.length; index++) {
      const block = stage.blocks[index];
      invariant(block.block === index && block.before?.cpuStat && block.after?.cpuStat && /^\d+$/.test(block.before.affinity), 'невалидный ресурсный блок');
      if (block.before.affinity !== block.after.affinity || block.before.cpuMax !== block.after.cpuMax) reasons.push(`${stage.name}: affinity/quota изменились`);
      if ([block.before, block.after].some((snapshot) => snapshot.affinity !== identity.affinity || snapshot.cpuMax !== identity.cgroupCpuMax)) {
        reasons.push(`${stage.name}: block ${index} отличается от зарегистрированных affinity/quota`);
      }
      for (const key of ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec']) {
        const before = block.before.cpuStat[key], after = block.after.cpuStat[key];
        invariant(Number.isSafeInteger(before) && Number.isSafeInteger(after) && before >= 0 && after >= before && block.delta[key] === after - before,
          'resource delta не воспроизводится');
      }
      if (block.delta.nr_throttled !== 0 || block.delta.throttled_usec !== 0) reasons.push(`${stage.name}: block ${index} содержит cgroup CPU throttling`);
    }
  }
  return reasons;
}

export function validateServerArtifact(artifact) {
  invariant(artifact?.schema === 1, 'неизвестная schema');
  verifyServerProfile(artifact.protocol);
  invariant(Array.isArray(artifact.failures), 'потеряны отказы');
  if (artifact.registration === null) {
    invariant(artifact.registrationDigest === null && artifact.verdict === 'UNPROVEN' && artifact.failures.length > 0 &&
      !artifact.pilot && !artifact.aa && !artifact.ab, 'неполная регистрация допустила измерения');
    return { verification: 'preparation-refused', verdict: 'UNPROVEN' };
  }
  invariant(SHA256.test(artifact.registrationDigest) && artifact.registrationDigest === serverProfileDigest(artifact.registration), 'подменён digest регистрации');
  invariant(artifact.registration?.candidateSamplesObserved === false, 'кандидат наблюдался до регистрации');
  invariant(artifact.registration.protocolDigest === serverProfileDigest(SERVER_PROFILE), 'неверный digest протокола');
  invariant(SERVER_PROFILE.browsers.includes(artifact.registration.browser), 'неизвестный browser');
  for (const id of ['baseline', 'candidate']) {
    const provenance = artifact.registration.provenance?.[id];
    invariant(SHA1.test(provenance?.revision) && provenance.dirty === false && SHA256.test(provenance.trackedRevisionSha256) &&
      SHA256.test(provenance.worktreeSha256) && SHA256.test(provenance.distRuntime?.sha256), 'неполное source provenance');
    invariant(/^v24\./.test(provenance.environment?.node) && provenance.environment.pnpm === '11.11.0' &&
      SHA256.test(provenance.environment.nodeExecutableSha256), 'неполное toolchain provenance');
    for (const key of ['root/package.json', 'root/pnpm-lock.yaml', 'bench/package.json', 'bench/pnpm-lock.yaml']) invariant(SHA256.test(provenance.inputs?.[key]), 'потерян input hash');
    for (const [field, names] of [['packages', ['esbuild', 'playwright', 'motion', 'gsap', 'animejs']], ['rootPackages', ['tsup', 'typescript', 'esbuild']]]) {
      for (const name of names) {
        const pkg = provenance.environment[field]?.[name];
        invariant(/^\d+\.\d+\.\d+$/.test(pkg?.version) && SHA256.test(pkg.sha256) && Number.isSafeInteger(pkg.files) && pkg.files > 0, 'потерян установленный package hash');
      }
    }
    invariant(SHA256.test(artifact.registration.packages?.[id]?.tarballSha256) && SHA256.test(artifact.registration.packages?.[id]?.treeSha256), 'неполное package provenance');
  }
  invariant(artifact.registration.provenance.baseline.revision === SERVER_PROFILE.baselineRevision, 'неверный baseline');
  invariant(SHA256.test(artifact.registration.machine?.sha256) && SHA256.test(artifact.registration.browserExecutableSha256) &&
    typeof artifact.registration.browserVersion === 'string' && artifact.registration.browserVersion.length > 0, 'неполное machine/browser provenance');
  invariant(artifact.registration.machine.sha256 === serverProfileDigest(artifact.registration.machine.identity) &&
    /^\d+$/.test(artifact.registration.machine.identity.affinity) && artifact.registration.machine.identity.platform === 'linux' &&
    typeof artifact.registration.machine.identity.cgroupCpuMax === 'string' && artifact.registration.machine.identity.cgroupCpuMax.length > 0 &&
    SHA256.test(artifact.registration.machine.identity.nodeExecutableSha256), 'machine identity не закреплена');
  invariant(SHA256.test(artifact.registration.browserTree?.sha256) && Number.isSafeInteger(artifact.registration.browserTree?.files) &&
    artifact.registration.browserTree.files > 0, 'потерян browser tree hash');
  verifyServerClockRegistration(artifact.registration);
  invariant(Object.keys(artifact.registration.harness ?? {}).length >= 6 && Object.values(artifact.registration.harness).every((x) => SHA256.test(x.sha256)), 'неполное harness provenance');
  for (const id of SERVER_PROFILE.comparators.filter((id) => !id.startsWith('waapi'))) invariant(SHA256.test(artifact.registration.packages[id]?.treeSha256) &&
    SHA256.test(artifact.registration.packages[id]?.tarballSha256), 'потерян comparator package');
  invariant(Object.keys(artifact.registration.transitivePackages ?? {}).length >= 3 &&
    Object.values(artifact.registration.transitivePackages).every((pkg) => SHA256.test(pkg.treeSha256) && SHA256.test(pkg.tarballSha256)), 'потеряны transitive tarballs');
  if (!artifact.pilot || !artifact.calibration) {
    invariant(artifact.verdict === 'UNPROVEN' && artifact.failures.length > 0 && !artifact.ab, 'незавершённое измерение объявлено успехом');
    return { verification: 'recorded-refusal-only', verdict: 'UNPROVEN' };
  }
  // Identity стадий проверяется до дорогих raw проекций. Их подробная
  // проверка по-прежнему принадлежит serverCellPairs каждой полной серии.
  for (const name of ['pilot', 'aa', 'positive', ...(artifact.ab ? ['ab'] : [])]) {
    invariant(artifact[name]?.name === name, 'имя стадии не соответствует владельцу artifact');
  }
  for (const id of artifact.ab ? ['baseline', 'candidate'] : ['baseline']) {
    const control = artifact.rawControls?.[id];
    invariant(control?.noMotion?.equal === true && SHA256.test(control.noMotion.beforeSha256) &&
      control.noMotion.beforeSha256 === control.noMotion.afterSha256 && control.reduced?.prefersReducedMotion === true &&
      Math.abs(control.reduced.x - SERVER_PROFILE.toPx) <= 2 && control.reduced.rafRequests === 0 && control.reduced.activeWaapi === 0,
    'потерян raw no-motion/reduced-motion control');
  }
  const pilotPairs = serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, 'pilot');
  invariant(isDeepStrictEqual(artifact.samplePlan, planServerSampleSize(pilotPairs)), 'N не воспроизводится из baseline-only pilot');
  invariant(artifact.frozenPlanDigest === serverProfileDigest({ registrationDigest: artifact.registrationDigest, samplePlan: artifact.samplePlan }), 'не закреплён N до A/A и A/B');
  const aa = serverFamilyIntervals(serverCellPairs(artifact.aa, artifact.samplePlan.runs, 'aa'));
  const positiveControl = serverFamilyIntervals(serverCellPairs(artifact.positive, artifact.samplePlan.runs, 'positive'));
  const calibration = serverCalibrationVerdict(aa, positiveControl, artifact.samplePlan);
  calibration.reasons.push(...serverResourceReasons([artifact.warmup, artifact.pilot, artifact.aa, artifact.positive], artifact.registration.machine.identity));
  calibration.verdict = calibration.reasons.length ? 'UNPROVEN' : 'PASS';
  invariant(isDeepStrictEqual(artifact.calibration, { ...calibration, aa, positive: positiveControl }), 'вердикт контроля не воспроизводится');
  if (calibration.verdict !== 'PASS') {
    invariant(!artifact.ab && artifact.verdict === 'UNPROVEN', 'негодная калибровка допустила A/B');
    return { verification: 'calibration-refused', ...calibration };
  }
  if (!artifact.ab) {
    invariant(artifact.verdict === 'UNPROVEN' && artifact.failures.length > 0, 'отсутствие A/B скрыто');
    return { verification: 'post-calibration-refused', verdict: 'UNPROVEN' };
  }
  if (artifact.failures.length > 0 && (artifact.ab.rows?.length !== artifact.samplePlan.runs *
      (SERVER_PROFILE.engineScenes.length + SERVER_PROFILE.browserScenes.length) ||
      artifact.ab.rows.some((row) => Object.keys(row.samples ?? {}).length !== IDS.length))) {
    invariant(artifact.verdict === 'UNPROVEN', 'частичный A/B объявлен успехом');
    return { verification: 'partial-samples-refused', verdict: 'UNPROVEN' };
  }
  const ab = serverFamilyIntervals(serverCellPairs(artifact.ab, artifact.samplePlan.runs, 'ab'));
  const resourceReasons = serverResourceReasons([artifact.ab], artifact.registration.machine.identity);
  invariant(resourceReasons.length === 0 || (artifact.verdict === 'UNPROVEN' && artifact.failures.length > 0), 'условия A/B нарушены, отказ потерян');
  if (artifact.failures.length > 0) {
    invariant(artifact.verdict === 'UNPROVEN', 'отказ скрыт успешным вердиктом');
    return { verification: 'completed-samples-refused', verdict: 'UNPROVEN' };
  }
  validateSupplementalSamples(artifact);
  const expected = ab.every((cell) => cell.p95.bounded && cell.p95.high <= SERVER_PROFILE.nonInferiorityUpper) ? 'PASS' : 'NO-GO';
  invariant(isDeepStrictEqual(artifact.comparison, ab) && artifact.verdict === expected, 'A/B вердикт не воспроизводится');
  return { verification: 'server-cell-only', verdict: expected, unproven: SERVER_PROFILE.unproven };
}

// Hash-chain хранит порядок preregistration → baseline-only pilot → N →
// calibration → A/B. Raw rows должны совпасть с каждой сохранённой квитанцией.
export function serverArtifactDigest(artifact) {
  const hash = createHash('sha256');
  for (const chunk of serverArtifactChunks(artifact)) hash.update(chunk);
  return hash.digest('hex');
}

// Сериализация rows отдельными chunks сохраняет весь raw, даже когда итоговый
// документ превышает максимальную строку V8. Один sample ограничен схемой сцены.
export function* serverArtifactChunks(artifact) {
  function* valueChunks(value) {
    if (Array.isArray(value)) {
      yield '[';
      for (let index = 0; index < value.length; index++) {
        if (index) yield ',';
        yield JSON.stringify(value[index]) ?? 'null';
      }
      yield ']';
    } else if (value !== null && typeof value === 'object' && typeof value.toJSON !== 'function') {
      yield '{'; let first = true;
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        if (!first) yield ','; first = false;
        yield `${JSON.stringify(key)}:`; yield* valueChunks(child);
      }
      yield '}';
    } else yield JSON.stringify(value);
  }
  yield* valueChunks(artifact); yield '\n';
}

export function writeServerArtifact(file, artifact) {
  const descriptor = openSync(file, 'wx'), hash = createHash('sha256');
  let bytes = 0;
  try {
    for (const chunk of serverArtifactChunks(artifact)) {
      const buffer = Buffer.from(chunk); hash.update(buffer); bytes += buffer.length;
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
  } finally { closeSync(descriptor); }
  return { sha256: hash.digest('hex'), bytes };
}

// JSON carrier делится только между полными values. Строки, escape sequences
// и числа разбирает native JSON.parse; весь artifact не становится строкой V8.
export function parseServerJsonBytes(bytes, chunkBytes = 32 * 1024 * 1024) {
  invariant(Buffer.isBuffer(bytes) && Number.isSafeInteger(chunkBytes) && chunkBytes > 0, 'невалидный JSON carrier');
  const whitespace = (code) => code === 32 || code === 9 || code === 10 || code === 13;
  const skip = (index, end) => { while (index < end && whitespace(bytes[index])) index++; return index; };
  const stringEnd = (start, end) => {
    let escaped = false;
    for (let index = start + 1; index < end; index++) {
      if (escaped) escaped = false;
      else if (bytes[index] === 92) escaped = true;
      else if (bytes[index] === 34) return index + 1;
    }
    throw new Error('server profile: оборван JSON string');
  };
  const valueEnd = (start, end) => {
    let depth = 0;
    for (let index = start; index < end; index++) {
      const code = bytes[index];
      if (code === 34) { index = stringEnd(index, end) - 1; continue; }
      if (code === 123 || code === 91) depth++;
      else if (code === 125 || code === 93) { if (!depth) return index; depth--; }
      else if (code === 44 && !depth) return index;
    }
    return end;
  };
  const parse = (start, end) => {
    start = skip(start, end); while (end > start && whitespace(bytes[end - 1])) end--;
    const first = bytes[start];
    if (end - start <= chunkBytes || (first !== 123 && first !== 91)) return JSON.parse(bytes.toString('utf8', start, end));
    const object = first === 123, close = object ? 125 : 93, result = object ? {} : [];
    invariant(bytes[end - 1] === close, 'оборван JSON container');
    let cursor = skip(start + 1, end);
    if (cursor === end - 1) return result;
    for (;;) {
      let key;
      if (object) {
        invariant(bytes[cursor] === 34, 'JSON object потерял key');
        const keyEnd = stringEnd(cursor, end); key = JSON.parse(bytes.toString('utf8', cursor, keyEnd));
        cursor = skip(keyEnd, end); invariant(bytes[cursor] === 58, 'JSON object потерял colon'); cursor = skip(cursor + 1, end);
      }
      const childEnd = valueEnd(cursor, end - 1), value = parse(cursor, childEnd);
      // defineProperty сохраняет JSON.parse semantics для __proto__ и duplicate keys.
      if (object) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      else result.push(value);
      cursor = skip(childEnd, end);
      if (cursor === end - 1) return result;
      invariant(bytes[cursor] === 44, 'JSON container потерял separator');
      cursor = skip(cursor + 1, end); invariant(cursor < end - 1, 'JSON container содержит trailing comma');
    }
  };
  return parse(0, bytes.length);
}

export function parseServerJournalBytes(bytes) {
  invariant(Buffer.isBuffer(bytes), 'невалидный journal carrier');
  const records = [];
  let start = 0, end = bytes.length;
  const whitespace = (code) => code === 32 || code === 9 || code === 10 || code === 13;
  while (start < end && whitespace(bytes[start])) start++;
  while (end > start && whitespace(bytes[end - 1])) end--;
  invariant(start < end, 'нет журнала регистрации и samples');
  for (let index = start; index < end; index++) if (bytes[index] === 10) {
    records.push(parseServerJsonBytes(bytes.subarray(start, index))); start = index + 1;
  }
  records.push(parseServerJsonBytes(bytes.subarray(start, end)));
  return records;
}

export function serverStagePlan(stage, runs) {
  const orders = serverOrders(runs), plan = [];
  for (let run = 0; run < runs; run++) {
    for (const [kind, scenes] of [['engine', SERVER_PROFILE.engineScenes], ['browser', SERVER_PROFILE.browserScenes]]) {
      for (const scene of scenes) for (const participant of orders[run]) plan.push({ stage, kind, scene: scene.id, run, participant,
        build: stage === 'ab' && participant === 'right' ? 'candidate' : 'baseline' });
    }
  }
  return plan;
}

export function validateServerJournal(artifact, records, rawDigest) {
  invariant(Array.isArray(records) && records.length > 0, 'нет журнала регистрации и samples');
  if (artifact.samplePlan) invariant(Number.isSafeInteger(artifact.samplePlan.runs) && artifact.samplePlan.runs % 2 === 0 &&
    artifact.samplePlan.runs >= SERVER_PROFILE.minRuns && artifact.samplePlan.runs <= SERVER_PROFILE.maxRuns, 'N журнала вне зарегистрированного ресурса');
  let previous = '0'.repeat(64), registration = false, frozen = false, calibration = false, calibrationRecorded = false, stopped = false;
  let baselineControl = false, candidateControl = false;
  const phases = ['warmup', 'pilot', 'aa', 'positive', 'ab'];
  const runsFor = (name) => name === 'warmup' ? SERVER_PROFILE.warmupRuns : name === 'pilot' ? SERVER_PROFILE.pilotRuns : artifact.samplePlan?.runs;
  const plans = Object.fromEntries(phases.map((name) => [name, runsFor(name) ? serverStagePlan(name, runsFor(name)) : []]));
  const counts = Object.fromEntries(phases.map((name) => [name, 0]));
  const resourceCounts = Object.fromEntries(phases.map((name) => [name, 0]));
  const complete = (name) => counts[name] === plans[name].length && resourceCounts[name] === runsFor(name) / 2;
  const comparatorPlan = artifact.samplePlan ? serverComparatorPlan(artifact.samplePlan.runs) : [];
  let comparatorCount = 0, retentionFinished = false, finishedDigest;
  const seen = new Map(), comparatorSamples = new Map(), retentionSamples = new Map(), failures = [], failedSamples = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex];
    const { digest } = record;
    invariant(record.sequenceDigest === previous && SHA256.test(digest), 'повреждена цепь журнала');
    previous = digest;
    if (record.type === 'registration-before-any-sample') {
      invariant(!registration && !stopped && artifact.registration !== null && seen.size === 0 && isDeepStrictEqual(record.value.registration, artifact.registration) &&
        record.value.digest === artifact.registrationDigest, 'регистрация не предшествует samples'); registration = true;
    } else if (record.type === 'raw-controls-baseline') {
      invariant(registration && !baselineControl && seen.size === 0 && isDeepStrictEqual(record.value, artifact.rawControls?.baseline), 'baseline raw control не предшествует timing'); baselineControl = true;
    } else if (record.type === 'N-frozen-before-calibration-and-AB') {
      invariant(registration && !stopped && !frozen && complete('warmup') && complete('pilot') && isDeepStrictEqual(record.value.samplePlan, artifact.samplePlan) &&
        record.value.digest === artifact.frozenPlanDigest,
      'N изменён или заморожен без полного baseline-only pilot'); frozen = true;
    } else if (record.type === 'calibration') {
      invariant(frozen && !stopped && !calibrationRecorded && complete('aa') && complete('positive') && isDeepStrictEqual(record.value, artifact.calibration), 'calibration выдана до завершения A/A и 2×work');
      calibrationRecorded = true;
      calibration = record.value.verdict === 'PASS';
    } else if (record.type === 'sample' || record.type === 'failed-sample') {
      const sample = record.value;
      invariant(registration && !stopped, 'sample получен до preregistration или после отказа');
      invariant(baselineControl, 'sample получен без baseline raw controls');
      invariant(phases.includes(sample.stage), 'неизвестная стадия sample');
      for (const earlier of phases.slice(0, phases.indexOf(sample.stage))) invariant(complete(earlier), 'стадии исполняются не по плану');
      if (['aa', 'positive', 'ab'].includes(sample.stage)) invariant(frozen, 'sample получен до замораживания N');
      if (sample.stage === 'ab') invariant(calibration && candidateControl, 'A/B запущен при негодной calibration/raw controls');
      const expected = plans[sample.stage][counts[sample.stage]];
      invariant(expected && Object.entries(expected).every(([key, value]) => sample[key] === value), 'фактический порядок/tuple sample отличается от preregistration');
      const key = `${sample.stage}:${sample.scene}:${sample.run}:${sample.participant}`;
      invariant(!seen.has(key), 'sample журнала повторён');
      if (record.type === 'failed-sample') { failedSamples.push(sample); stopped = true; }
      else { seen.set(key, sample.value); counts[sample.stage]++; }
    } else if (record.type === 'resources-block') {
      const { stage, ...block } = record.value;
      invariant(phases.includes(stage) && block.block === resourceCounts[stage] &&
        counts[stage] === (block.block + 1) * (SERVER_PROFILE.engineScenes.length + SERVER_PROFILE.browserScenes.length) * 4 &&
        isDeepStrictEqual(block, artifact[stage]?.blocks?.[block.block]), 'ресурсная квитанция не соответствует завершённому блоку');
      resourceCounts[stage]++;
    } else if (record.type === 'raw-controls-candidate-after-calibration') {
      invariant(!stopped && calibration && !candidateControl && isDeepStrictEqual(record.value, artifact.rawControls?.candidate), 'candidate raw control получен до годной calibration'); candidateControl = true;
    } else if (record.type === 'failure') {
      failures.push(record.value); stopped = true;
    } else if (record.type === 'finished') {
      invariant(recordIndex === records.length - 1 && record.value.verdict === artifact.verdict && SHA256.test(record.value.digest),
        'финальная квитанция не связана с raw/вердиктом');
      finishedDigest = record.value.digest;
    } else if (record.type === 'comparator-sample' || record.type === 'failed-comparator-sample') {
      invariant(!stopped && calibration && complete('ab'), 'дополнительное измерение получено до годного A/B');
      const value = record.value;
      const expected = comparatorPlan[comparatorCount];
      invariant(expected && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue), 'comparator sample не соответствует порядку плана');
      if (record.type === 'failed-comparator-sample') { failedSamples.push(value); stopped = true; }
      else {
        const key = `${value.scene}:${value.id}:${value.run}`;
        invariant(!comparatorSamples.has(key), 'повторный comparator sample'); comparatorSamples.set(key, value.sample); comparatorCount++;
      }
    } else if (record.type === 'retention-sample') {
      invariant(!stopped && calibration && complete('ab') && comparatorCount === comparatorPlan.length &&
        record.value.id === IDS.map((id) => id === 'left' ? 'baseline' : 'candidate')[retentionSamples.size] &&
        isDeepStrictEqual(record.value.value, artifact.retention?.[record.value.id]), 'retention sample не соответствует плану/raw');
      retentionSamples.set(record.value.id, record.value.value);
    } else if (record.type === 'retention-separate-forced-GC') {
      invariant(!stopped && !retentionFinished && calibration && complete('ab') && retentionSamples.size === 2, 'retention child не завершён');
      invariant(isDeepStrictEqual(record.value, artifact.retention), 'retention не совпадает с квитанцией');
      retentionFinished = true;
    } else invariant(false, 'неизвестная квитанция журнала');
  }
  invariant(records.at(-1).type === 'finished', 'журнал оборван до финальной квитанции');
  invariant(isDeepStrictEqual(failures, artifact.failures), 'failures потеряны или добавлены вне журнала');
  for (const failed of failedSamples) invariant(failures.some((failure) => failure.stage === failed.stage && isDeepStrictEqual(failure.error, failed.error)), 'failed sample исключён из failure union');
  if (stopped) invariant(artifact.verdict === 'UNPROVEN', 'сохранённый отказ объявлен PASS');
  for (const stage of ['warmup', 'pilot', 'aa', 'positive', 'ab']) {
    for (const row of artifact[stage]?.rows ?? []) for (const [id, sample] of Object.entries(row.samples)) {
      const key = `${stage}:${row.scene}:${row.run}:${id}`;
      invariant(isDeepStrictEqual(seen.get(key), sample), 'raw sample расходится с журналом'); seen.delete(key);
    }
  }
  invariant(seen.size === 0, 'samples журнала исключены из результата');
  for (const comparator of artifact.comparators ?? []) for (let run = 0; run < (comparator.rows ?? []).length; run++) {
    const key = `${comparator.scene}:${comparator.id}:${run}`;
    invariant(isDeepStrictEqual(comparatorSamples.get(key), comparator.rows[run]), 'comparator sample расходится с журналом'); comparatorSamples.delete(key);
  }
  invariant(comparatorSamples.size === 0, 'comparator samples исключены из результата');
  invariant(isDeepStrictEqual(Object.fromEntries(retentionSamples), artifact.retention ?? {}), 'retention samples исключены из результата');
  if (artifact.verdict !== 'UNPROVEN') invariant(comparatorCount === comparatorPlan.length && retentionFinished,
    'обязательные comparator/retention measurements не завершены');
  // Полный raw хешируется после проверки хронологии, failure union и полноты.
  // Отказ на этих границах не сериализует заведомо негодную историю повторно.
  invariant(finishedDigest === (rawDigest ?? serverArtifactDigest(artifact)), 'финальная квитанция не связана с raw/вердиктом');
  // Каждая допущенная история заново проверяет все тела квитанций. Структурный
  // отказ не повторяет сериализацию raw, не участвующего в успешном admission.
  for (const record of records) {
    const { digest, ...payload } = record;
    invariant(digest === serverProfileDigest(payload), 'повреждена цепь журнала');
  }
  return { journalFinalDigest: previous };
}

export function serverDescriptiveTiming(stage) {
  return serverMetricCells().map(({ id, scene, metric }) => ({ id, ...summarizeSamples(stage.rows.filter((x) => x.scene === scene)
    .flatMap((row) => IDS.map((id) => row.samples[id][metric])), { strict: true }) }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    invariant(args.length === 6 && args[0] === '--raw' && args[2] === '--digest' && args[4] === '--journal',
      'нужны --raw <json> --digest <внешний sha256> --journal <ndjson>');
    const raw = readFileSync(args[1]); invariant(SHA256.test(args[3]) && sha256Bytes(raw) === args[3], 'не совпал внешний digest raw');
    const artifact = parseServerJsonBytes(raw);
    const records = parseServerJournalBytes(readFileSync(args[5]));
    const chronology = validateServerJournal(artifact, records, args[3]);
    process.stdout.write(`${JSON.stringify({ ...validateServerArtifact(artifact), ...chronology })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
