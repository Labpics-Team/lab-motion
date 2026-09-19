import {
  RENDERER_THREAD_PREREGISTRATION as DESIGN,
  validateRendererThreadPreregistration,
} from './renderer-thread-preregistration.mjs';
import { pairedLogRatioInterval, pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 renderer-thread pilot: ${message}`);
}

export class RendererThreadFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 renderer-thread pilot: ${message}`);
    this.name = 'RendererThreadFailure';
    this.evidence = evidence;
  }
}

function orderGenerator(seed) {
  let state = seed >>> 0;
  invariant(state !== 0, 'order seed must be non-zero');
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) & 1;
  };
}

function frozenCount(map, sceneId, label) {
  const value = map[sceneId];
  invariant(Number.isSafeInteger(value) && value > 0, `${sceneId}: frozen ${label} missing`);
  return value;
}

export function selectExecutionThread(before, after, browserRootPid, options = {}) {
  const minimumCpuMs = options.minimumCpuMs ?? 100;
  const dominanceRatio = options.dominanceRatio ?? 4;
  invariant(before instanceof Map && after instanceof Map, 'thread snapshots must be Maps');
  invariant(Number.isSafeInteger(browserRootPid) && browserRootPid > 1, 'browser root pid missing');
  const candidates = [];
  for (const [key, end] of after) {
    const start = before.get(key);
    if (!start || end.pid === browserRootPid || start.pid === browserRootPid) continue;
    if (start.pid !== end.pid || start.tid !== end.tid || start.starttime !== end.starttime) continue;
    invariant(end.cpuNs >= start.cpuNs, `${key}: schedstat moved backwards during sentinel`);
    const cpuMs = Number(end.cpuNs - start.cpuNs) / 1e6;
    if (cpuMs > 0) candidates.push({ ...end, cpuMs });
  }
  candidates.sort((a, b) => b.cpuMs - a.cpuMs);
  invariant(candidates.length > 0, 'sentinel found no stable non-root descendant task');
  const selected = candidates[0];
  const runnerUpCpuMs = candidates[1]?.cpuMs ?? 0;
  const ratio = selected.cpuMs / Math.max(runnerUpCpuMs, Number.EPSILON);
  if (selected.cpuMs < minimumCpuMs || ratio < dominanceRatio) {
    throw new RendererThreadFailure('page execution thread sentinel is ambiguous', {
      selected: { pid: selected.pid, tid: selected.tid, comm: selected.comm, cpuMs: selected.cpuMs },
      runnerUpCpuMs,
      dominanceRatio: ratio,
      requiredMinimumCpuMs: minimumCpuMs,
      requiredDominanceRatio: dominanceRatio,
    });
  }
  return {
    pid: selected.pid,
    tid: selected.tid,
    starttime: selected.starttime,
    comm: selected.comm,
    cmd: selected.cmd,
    sentinelCpuMs: selected.cpuMs,
    sentinelRunnerUpCpuMs: runnerUpCpuMs,
    sentinelDominanceRatio: ratio,
  };
}

function observationFrom(raw, sceneId, run, workMultiplier, token, position, expectedThread) {
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  const label = `${sceneId}/run-${run}/${position}`;
  invariant(raw?.semantic === true, `${label}: semantic oracle failed`);
  invariant(raw.isolationToken === token, `${label}: pair token drifted`);
  invariant(raw.position === position, `${label}: pair position drifted`);
  invariant(raw.thread?.pid === expectedThread.pid && raw.thread?.tid === expectedThread.tid && raw.thread?.starttime === expectedThread.starttime, `${label}: page thread identity drifted`);
  invariant(Number.isFinite(raw.motionThreadCpuMs) && raw.motionThreadCpuMs >= DESIGN.measurement.minimumRawThreadCpuMsPerArm, `${label}: motion thread CPU below frozen floor`);
  invariant(Number.isFinite(raw.controlThreadCpuMs) && raw.controlThreadCpuMs >= DESIGN.measurement.minimumRawThreadCpuMsPerArm, `${label}: control thread CPU below frozen floor`);
  invariant(Number.isFinite(raw.differentialCpuMs) && Object.is(raw.differentialCpuMs, raw.motionThreadCpuMs - raw.controlThreadCpuMs), `${label}: differential/raw mismatch`);
  if (raw.differentialCpuMs < DESIGN.measurement.minimumDifferentialCpuMsPerSample) {
    throw new RendererThreadFailure('renderer-thread removable-cost differential did not clear frozen floor', {
      sceneId, run, position, workMultiplier,
      motionThreadCpuMs: raw.motionThreadCpuMs,
      controlThreadCpuMs: raw.controlThreadCpuMs,
      differentialCpuMs: raw.differentialCpuMs,
      minimumDifferentialCpuMsPerSample: DESIGN.measurement.minimumDifferentialCpuMsPerSample,
    });
  }
  invariant(raw.logicalUnits === logicalUnits && raw.batchCalls === batchCalls && raw.warmupLogicalUnits === warmupLogicalUnits, `${label}: frozen work shape drifted`);
  invariant(raw.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
  invariant(raw.motionPhysicalExecutions === logicalUnits * workMultiplier, `${label}: motion work count drifted`);
  invariant(raw.controlPhysicalExecutions === logicalUnits * workMultiplier, `${label}: control work count drifted`);
  invariant(raw.subarmOrder === 'motion-control' || raw.subarmOrder === 'control-motion', `${label}: subarm order missing`);
  invariant(Number.isFinite(raw.enclosingWallMs) && raw.enclosingWallMs >= 0, `${label}: enclosing wall invalid`);
  return {
    run,
    samples: [raw.differentialCpuMs / logicalUnits],
    motionThreadCpuMs: raw.motionThreadCpuMs,
    controlThreadCpuMs: raw.controlThreadCpuMs,
    differentialCpuMs: raw.differentialCpuMs,
    logicalUnits,
    batchCalls,
    warmupLogicalUnits,
    workMultiplier,
    motionPhysicalExecutions: raw.motionPhysicalExecutions,
    controlPhysicalExecutions: raw.controlPhysicalExecutions,
    subarmOrder: raw.subarmOrder,
    enclosingWallMs: raw.enclosingWallMs,
    processLifecycle: raw.processLifecycle,
    isolationToken: token,
    pairOrdinal: raw.pairOrdinal,
    position,
    browserVersion: raw.browserVersion,
    thread: raw.thread,
    semantic: true,
  };
}

export async function acquireRendererThreadBlock(measureFreshPair, sceneId, run, pairKind, order, subarmOrderBits) {
  validateRendererThreadPreregistration();
  invariant(typeof measureFreshPair === 'function', 'measureFreshPair must be a function');
  invariant(DESIGN.sceneIds.includes(sceneId), `unknown scene ${sceneId}`);
  invariant(Number.isSafeInteger(run) && run >= 0, 'run identity invalid');
  invariant(pairKind === 'aa' || pairKind === 'deliberate2x', 'pair kind invalid');
  const expectedOrders = pairKind === 'aa' ? ['AB', 'BA'] : ['SD', 'DS'];
  invariant(expectedOrders.includes(order), `${pairKind}: order ${order} is not preregistered`);
  invariant(Array.isArray(subarmOrderBits) && subarmOrderBits.length === 2, 'subarm order bits missing');

  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  const baseArms = pairKind === 'aa'
    ? (order === 'AB' ? [['a', 1], ['b', 1]] : [['b', 1], ['a', 1]])
    : (order === 'SD' ? [['single', 1], ['doubled', 2]] : [['doubled', 2], ['single', 1]]);
  const arms = baseArms.map(([key, workMultiplier], index) => ({
    key,
    workMultiplier,
    subarmOrder: subarmOrderBits[index] ? 'motion-control' : 'control-motion',
  }));

  const result = await measureFreshPair({ sceneId, run, pairKind, order, arms, logicalUnits, batchCalls, warmupLogicalUnits });
  invariant(result?.semantic === true, `${sceneId}/run-${run}/${pairKind}: pair semantic oracle failed`);
  invariant(result.processLifecycle === 'fresh-browser-server-bound-page-thread-paired-arms-close', `${sceneId}/run-${run}/${pairKind}: fresh-pair lifecycle receipt missing`);
  invariant(typeof result.isolationToken === 'string' && result.isolationToken.length >= 16, `${sceneId}/run-${run}/${pairKind}: pair token missing`);
  invariant(Number.isSafeInteger(result.pairOrdinal) && result.pairOrdinal > 0, `${sceneId}/run-${run}/${pairKind}: pair ordinal missing`);
  invariant(typeof result.browserVersion === 'string' && result.browserVersion.length > 0, `${sceneId}/run-${run}/${pairKind}: browser version missing`);
  invariant(result.thread?.sentinelCpuMs >= 100 && result.thread?.sentinelDominanceRatio >= 4, `${sceneId}/run-${run}/${pairKind}: page-thread binding receipt invalid`);
  invariant(Number.isFinite(result.pairEnclosingWallMs) && result.pairEnclosingWallMs >= 0, `${sceneId}/run-${run}/${pairKind}: pair wall invalid`);
  if (result.pairEnclosingWallMs > DESIGN.measurement.maximumEnclosingWallMsPerPair) {
    throw new RendererThreadFailure('formal pair exceeded enclosing wall bound', { sceneId, run, pairKind, pairEnclosingWallMs: result.pairEnclosingWallMs });
  }
  invariant(Array.isArray(result.observations) && result.observations.length === 2, `${sceneId}/run-${run}/${pairKind}: pair observations missing`);
  const byKey = {};
  for (let position = 0; position < arms.length; position++) {
    const arm = arms[position];
    const raw = result.observations[position];
    invariant(raw?.key === arm.key && raw.subarmOrder === arm.subarmOrder, `${sceneId}/run-${run}/${pairKind}: observed arm order drifted`);
    byKey[arm.key] = observationFrom(raw, sceneId, run, arm.workMultiplier, result.isolationToken, position, result.thread);
  }
  return { order, isolationToken: result.isolationToken, pairOrdinal: result.pairOrdinal, browserVersion: result.browserVersion, thread: result.thread, pairEnclosingWallMs: result.pairEnclosingWallMs, observations: byKey };
}

export async function acquireRendererThreadControls(measureFreshPair, sceneId, options = {}) {
  validateRendererThreadPreregistration();
  const runBlocks = options.runBlocks ?? DESIGN.controls.runBlocks;
  const nextOrder = orderGenerator(options.orderSeed ?? DESIGN.controls.orderSeed);
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const aa = { orders: [], pairTokens: [], a: [], b: [] };
  const deliberate2x = { orders: [], pairTokens: [], single: [], doubled: [] };
  for (let run = 0; run < runBlocks; run++) {
    const aaOrder = nextOrder() ? 'AB' : 'BA';
    const aaPair = await acquireRendererThreadBlock(measureFreshPair, sceneId, run, 'aa', aaOrder, [nextOrder(), nextOrder()]);
    aa.orders.push(aaOrder); aa.pairTokens.push(aaPair.isolationToken); aa.a.push(aaPair.observations.a); aa.b.push(aaPair.observations.b);
    const deliberateOrder = nextOrder() ? 'SD' : 'DS';
    const deliberatePair = await acquireRendererThreadBlock(measureFreshPair, sceneId, run, 'deliberate2x', deliberateOrder, [nextOrder(), nextOrder()]);
    deliberate2x.orders.push(deliberateOrder); deliberate2x.pairTokens.push(deliberatePair.isolationToken); deliberate2x.single.push(deliberatePair.observations.single); deliberate2x.doubled.push(deliberatePair.observations.doubled);
  }
  return { aa, deliberate2x };
}

function validateObservation(entry, sceneId, run, workMultiplier, label, expectedToken, browserVersion, thread) {
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  invariant(entry?.run === run && entry.semantic === true, `${label}: run identity/semantic drifted`);
  invariant(entry.samples?.length === 1 && Number.isFinite(entry.samples[0]) && entry.samples[0] > 0, `${label}: one positive sample required`);
  invariant(entry.isolationToken === expectedToken && entry.browserVersion === browserVersion, `${label}: pair/browser identity drifted`);
  invariant(entry.thread?.pid === thread.pid && entry.thread?.tid === thread.tid && entry.thread?.starttime === thread.starttime, `${label}: bound thread drifted`);
  invariant(entry.logicalUnits === logicalUnits && entry.workMultiplier === workMultiplier, `${label}: work shape drifted`);
  invariant(entry.motionThreadCpuMs >= DESIGN.measurement.minimumRawThreadCpuMsPerArm && entry.controlThreadCpuMs >= DESIGN.measurement.minimumRawThreadCpuMsPerArm, `${label}: raw CPU floor escaped`);
  invariant(entry.differentialCpuMs >= DESIGN.measurement.minimumDifferentialCpuMsPerSample, `${label}: differential floor escaped`);
  invariant(Object.is(entry.samples[0], entry.differentialCpuMs / logicalUnits), `${label}: normalized differential mismatch`);
}

export function buildRendererThreadPilotReceipt({ inventory, calibration, preregRevision, harnessRevision, cells, pilotEnclosingWallMs, generatedAt = new Date().toISOString() }) {
  validateRendererThreadPreregistration();
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision) && /^[0-9a-f]{40}$/u.test(harnessRevision), 'exact revisions missing');
  invariant(Number.isFinite(pilotEnclosingWallMs) && pilotEnclosingWallMs >= 0 && pilotEnclosingWallMs <= DESIGN.measurement.maximumPilotWallMs, 'whole-pilot wall bound escaped');
  return {
    schemaVersion: 1, node: 'PROFILE-01', designId: DESIGN.id, preregRevision, harnessRevision,
    baselineRevision: DESIGN.baselineRevision, generatedAt, candidateSamples: 0, pilotEnclosingWallMs,
    inventorySha256: pairedLogReceiptSha256(inventory), calibrationSha256: pairedLogReceiptSha256(calibration), design: DESIGN, cells,
  };
}

export function finalizeRendererThreadPilotReceipt(receipt) {
  validateRendererThreadPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01' && receipt.designId === DESIGN.id, 'receipt identity drifted');
  invariant(receipt.baselineRevision === DESIGN.baselineRevision && receipt.candidateSamples === 0, 'baseline/candidate gate drifted');
  invariant(/^[0-9a-f]{40}$/u.test(receipt.preregRevision) && /^[0-9a-f]{40}$/u.test(receipt.harnessRevision), 'receipt exact revisions missing');
  invariant(/^[0-9a-f]{64}$/u.test(receipt.inventorySha256) && /^[0-9a-f]{64}$/u.test(receipt.calibrationSha256), 'content addresses missing');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESIGN.engines.length, 'desktop cell matrix missing');
  const output = structuredClone(receipt);
  const tokens = new Set();
  const threads = new Set();
  const [aaLow, aaHigh] = DESIGN.controls.aaBand;
  for (let cellIndex = 0; cellIndex < output.cells.length; cellIndex++) {
    const cell = output.cells[cellIndex];
    const engine = DESIGN.engines[cellIndex];
    invariant(cell?.id === `desktop-${engine}` && cell.engine === engine, `${engine}: cell identity drifted`);
    invariant(JSON.stringify(cell.scenes?.map(({ id }) => id)) === JSON.stringify(DESIGN.sceneIds), `${engine}: scene matrix drifted`);
    for (let sceneIndex = 0; sceneIndex < cell.scenes.length; sceneIndex++) {
      const scene = cell.scenes[sceneIndex];
      const label = `${cell.id}/${scene.id}`;
      const groups = [
        ['aa', scene.raw?.aa, 'a', 'b', 1, 1, ['AB', 'BA']],
        ['deliberate2x', scene.raw?.deliberate2x, 'single', 'doubled', 1, 2, ['SD', 'DS']],
      ];
      for (const [groupName, group, leftName, rightName, leftMultiplier, rightMultiplier, allowedOrders] of groups) {
        invariant(Array.isArray(group?.orders) && group.orders.length === DESIGN.controls.runBlocks, `${label}/${groupName}: orders missing`);
        invariant(Array.isArray(group?.pairTokens) && group.pairTokens.length === DESIGN.controls.runBlocks, `${label}/${groupName}: tokens missing`);
        invariant(group[leftName]?.length === DESIGN.controls.runBlocks && group[rightName]?.length === DESIGN.controls.runBlocks, `${label}/${groupName}: block count drifted`);
        for (let run = 0; run < DESIGN.controls.runBlocks; run++) {
          invariant(allowedOrders.includes(group.orders[run]), `${label}/${groupName}/run-${run}: order drifted`);
          const token = group.pairTokens[run];
          invariant(typeof token === 'string' && !tokens.has(token), `${label}/${groupName}/run-${run}: token reused`);
          tokens.add(token);
          const thread = group[leftName][run]?.thread;
          invariant(thread?.pid === group[rightName][run]?.thread?.pid && thread?.tid === group[rightName][run]?.thread?.tid && thread?.starttime === group[rightName][run]?.thread?.starttime, `${label}/${groupName}/run-${run}: pair thread mismatch`);
          const threadKey = `${token}:${thread.pid}:${thread.tid}:${thread.starttime}`;
          invariant(!threads.has(threadKey), `${label}/${groupName}/run-${run}: thread receipt reused`);
          threads.add(threadKey);
          validateObservation(group[leftName][run], scene.id, run, leftMultiplier, `${label}/${groupName}/${leftName}`, token, cell.browserVersion, thread);
          validateObservation(group[rightName][run], scene.id, run, rightMultiplier, `${label}/${groupName}/${rightName}`, token, cell.browserVersion, thread);
        }
      }
      const seed = DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3);
      scene.aa = pairedLogRatioInterval(scene.raw.aa.a, scene.raw.aa.b, seed, DESIGN.controls.bootstrapIterations);
      scene.deliberate2x = pairedLogRatioInterval(scene.raw.deliberate2x.doubled, scene.raw.deliberate2x.single, seed ^ 0x2a2a2a, DESIGN.controls.bootstrapIterations);
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  const expectedPairs = DESIGN.engines.length * DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 2;
  invariant(tokens.size === expectedPairs && threads.size === expectedPairs, 'fresh pair/thread cardinality drifted');
  output.processIsolation = { kind: 'fresh-browser-server-and-bound-page-thread-per-paired-run-block', uniquePairTokens: tokens.size, uniqueBoundThreadReceipts: threads.size, formalObservationsPerPair: 2 };
  return output;
}
