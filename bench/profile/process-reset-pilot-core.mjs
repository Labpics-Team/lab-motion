import {
  PROCESS_RESET_PREREGISTRATION as DESIGN,
  validateProcessResetPreregistration,
} from './process-reset-preregistration.mjs';
import { pairedLogRatioInterval, pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 process-reset pilot: ${message}`);
}

export class ProcessResetResolutionFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 process-reset pilot: ${message}`);
    this.name = 'ProcessResetResolutionFailure';
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

function cluster(run, observation) {
  return {
    run,
    samples: [observation.costPerLogicalUnitMs],
    ...observation,
  };
}

export async function acquireProcessResetObservation(measureFreshPacket, sceneId, workMultiplier = 1) {
  validateProcessResetPreregistration();
  invariant(typeof measureFreshPacket === 'function', 'measureFreshPacket must be a function');
  invariant(DESIGN.sceneIds.includes(sceneId), `unknown scene ${sceneId}`);
  invariant(workMultiplier === 1 || workMultiplier === 2, 'work multiplier must be 1 or 2');

  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  const result = await measureFreshPacket({ sceneId, logicalUnits, batchCalls, warmupLogicalUnits, workMultiplier });

  invariant(result?.semantic === true, `${sceneId}: semantic oracle failed`);
  invariant(result.processLifecycle === 'launch-warmup-measure-close', `${sceneId}: fresh-process lifecycle receipt missing`);
  invariant(typeof result.isolationToken === 'string' && result.isolationToken.length >= 16, `${sceneId}: isolation token missing`);
  invariant(Number.isSafeInteger(result.launchOrdinal) && result.launchOrdinal > 0, `${sceneId}: launch ordinal missing`);
  invariant(typeof result.browserVersion === 'string' && result.browserVersion.length > 0, `${sceneId}: browser version missing`);
  invariant(Number.isFinite(result.ownerMs) && result.ownerMs >= 0, `${sceneId}: invalid owner-time`);
  invariant(Number.isFinite(result.enclosingWallMs) && result.enclosingWallMs >= result.ownerMs, `${sceneId}: invalid enclosing wall-time`);
  invariant(Number.isFinite(result.launchSetupWallMs) && result.launchSetupWallMs >= 0, `${sceneId}: invalid launch/setup wall-time`);
  invariant(Number.isFinite(result.warmupWallMs) && result.warmupWallMs >= 0, `${sceneId}: invalid warmup wall-time`);
  invariant(Number.isFinite(result.closeWallMs) && result.closeWallMs >= 0, `${sceneId}: invalid close wall-time`);
  invariant(result.logicalUnits === logicalUnits, `${sceneId}: fixed logical-unit count drifted`);
  invariant(result.batchCalls === batchCalls, `${sceneId}: live-batch count drifted`);
  invariant(result.warmupLogicalUnits === warmupLogicalUnits, `${sceneId}: warmup count drifted`);
  invariant(result.workMultiplier === workMultiplier, `${sceneId}: work multiplier drifted`);
  invariant(result.physicalExecutions === logicalUnits * workMultiplier, `${sceneId}: physical-work count drifted`);
  invariant(result.warmupPhysicalExecutions === warmupLogicalUnits, `${sceneId}: warmup work-count drifted`);

  if (result.enclosingWallMs > DESIGN.measurement.maximumEnclosingWallMsPerPacket) {
    throw new ProcessResetResolutionFailure('formal packet exceeded enclosing wall bound', {
      sceneId,
      logicalUnits,
      batchCalls,
      workMultiplier,
      ownerMs: result.ownerMs,
      enclosingWallMs: result.enclosingWallMs,
      maximumEnclosingWallMsPerPacket: DESIGN.measurement.maximumEnclosingWallMsPerPacket,
    });
  }
  if (result.ownerMs < DESIGN.measurement.minimumOwnerMsPerPacket) {
    throw new ProcessResetResolutionFailure('formal packet did not clear frozen owner-time floor', {
      sceneId,
      logicalUnits,
      batchCalls,
      workMultiplier,
      ownerMs: result.ownerMs,
      minimumOwnerMsPerPacket: DESIGN.measurement.minimumOwnerMsPerPacket,
    });
  }

  return {
    ownerMs: result.ownerMs,
    enclosingWallMs: result.enclosingWallMs,
    launchSetupWallMs: result.launchSetupWallMs,
    warmupWallMs: result.warmupWallMs,
    closeWallMs: result.closeWallMs,
    logicalUnits,
    physicalExecutions: result.physicalExecutions,
    batchCalls,
    warmupLogicalUnits,
    warmupPhysicalExecutions: result.warmupPhysicalExecutions,
    workMultiplier,
    costPerLogicalUnitMs: result.ownerMs / logicalUnits,
    processLifecycle: result.processLifecycle,
    isolationToken: result.isolationToken,
    launchOrdinal: result.launchOrdinal,
    browserVersion: result.browserVersion,
    semantic: true,
  };
}

export async function acquireProcessResetControls(measureFreshPacket, sceneId, options = {}) {
  validateProcessResetPreregistration();
  const runBlocks = options.runBlocks ?? DESIGN.controls.runBlocks;
  const orderSeed = options.orderSeed ?? DESIGN.controls.orderSeed;
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const nextOrder = orderGenerator(orderSeed);
  const aa = { orders: [], a: [], b: [] };
  const deliberate2x = { orders: [], single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    const aaOrder = nextOrder() ? 'AB' : 'BA';
    aa.orders.push(aaOrder);
    let a;
    let b;
    if (aaOrder === 'AB') {
      a = await acquireProcessResetObservation(measureFreshPacket, sceneId, 1);
      b = await acquireProcessResetObservation(measureFreshPacket, sceneId, 1);
    } else {
      b = await acquireProcessResetObservation(measureFreshPacket, sceneId, 1);
      a = await acquireProcessResetObservation(measureFreshPacket, sceneId, 1);
    }
    aa.a.push(cluster(run, a));
    aa.b.push(cluster(run, b));

    const deliberateOrder = nextOrder() ? 'SD' : 'DS';
    deliberate2x.orders.push(deliberateOrder);
    let single;
    let doubled;
    if (deliberateOrder === 'SD') {
      single = await acquireProcessResetObservation(measureFreshPacket, sceneId, 1);
      doubled = await acquireProcessResetObservation(measureFreshPacket, sceneId, 2);
    } else {
      doubled = await acquireProcessResetObservation(measureFreshPacket, sceneId, 2);
      single = await acquireProcessResetObservation(measureFreshPacket, sceneId, 1);
    }
    deliberate2x.single.push(cluster(run, single));
    deliberate2x.doubled.push(cluster(run, doubled));
  }

  return { aa, deliberate2x };
}

function validateObservation(entry, sceneId, run, workMultiplier, label, tokens) {
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  invariant(entry?.run === run && entry.semantic === true, `${label}: run identity/semantic drifted`);
  invariant(entry.samples?.length === 1 && Number.isFinite(entry.samples[0]) && entry.samples[0] > 0, `${label}: exactly one positive sample required`);
  invariant(entry.processLifecycle === 'launch-warmup-measure-close', `${label}: lifecycle receipt drifted`);
  invariant(typeof entry.isolationToken === 'string' && entry.isolationToken.length >= 16, `${label}: isolation token missing`);
  invariant(!tokens.has(entry.isolationToken), `${label}: isolation token reused across formal arms`);
  tokens.add(entry.isolationToken);
  invariant(Number.isSafeInteger(entry.launchOrdinal) && entry.launchOrdinal > 0, `${label}: launch ordinal invalid`);
  invariant(typeof entry.browserVersion === 'string' && entry.browserVersion.length > 0, `${label}: browser version missing`);
  invariant(entry.logicalUnits === logicalUnits, `${label}: logical-unit count drifted`);
  invariant(entry.batchCalls === batchCalls, `${label}: live-batch count drifted`);
  invariant(entry.warmupLogicalUnits === warmupLogicalUnits && entry.warmupPhysicalExecutions === warmupLogicalUnits, `${label}: warmup work drifted`);
  invariant(entry.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
  invariant(entry.physicalExecutions === logicalUnits * workMultiplier, `${label}: formal work count drifted`);
  invariant(entry.ownerMs >= DESIGN.measurement.minimumOwnerMsPerPacket, `${label}: owner floor escaped`);
  invariant(entry.enclosingWallMs >= entry.ownerMs && entry.enclosingWallMs <= DESIGN.measurement.maximumEnclosingWallMsPerPacket, `${label}: packet wall bound escaped`);
  invariant([entry.launchSetupWallMs, entry.warmupWallMs, entry.closeWallMs].every((value) => Number.isFinite(value) && value >= 0), `${label}: lifecycle wall diagnostic invalid`);
  invariant(Object.is(entry.costPerLogicalUnitMs, entry.ownerMs / logicalUnits), `${label}: normalized owner cost drifted`);
  invariant(Object.is(entry.samples[0], entry.costPerLogicalUnitMs), `${label}: sample/raw owner mismatch`);
}

function validatePair(group, sceneId, leftName, rightName, leftMultiplier, rightMultiplier, allowedOrders, label, tokens, browserVersion) {
  invariant(Array.isArray(group?.orders) && group.orders.length === DESIGN.controls.runBlocks, `${label}: order receipts missing`);
  invariant(Array.isArray(group[leftName]) && group[leftName].length === DESIGN.controls.runBlocks, `${label}: left block count drifted`);
  invariant(Array.isArray(group[rightName]) && group[rightName].length === DESIGN.controls.runBlocks, `${label}: right block count drifted`);
  for (let run = 0; run < DESIGN.controls.runBlocks; run++) {
    invariant(allowedOrders.includes(group.orders[run]), `${label}/run-${run}: unregistered order`);
    validateObservation(group[leftName][run], sceneId, run, leftMultiplier, `${label}/run-${run}/${leftName}`, tokens);
    validateObservation(group[rightName][run], sceneId, run, rightMultiplier, `${label}/run-${run}/${rightName}`, tokens);
    invariant(group[leftName][run].browserVersion === browserVersion, `${label}/run-${run}/${leftName}: browser version drifted`);
    invariant(group[rightName][run].browserVersion === browserVersion, `${label}/run-${run}/${rightName}: browser version drifted`);
  }
}

export function buildProcessResetPilotReceipt({ inventory, calibration, preregRevision, harnessRevision, cells, pilotEnclosingWallMs, generatedAt = new Date().toISOString() }) {
  validateProcessResetPreregistration();
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'preregRevision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harnessRevision must be exact SHA');
  invariant(Number.isFinite(pilotEnclosingWallMs) && pilotEnclosingWallMs >= 0 && pilotEnclosingWallMs <= DESIGN.measurement.maximumPilotWallMs, 'whole-pilot wall bound escaped');
  return {
    schemaVersion: 1,
    node: 'PROFILE-01',
    designId: DESIGN.id,
    preregRevision,
    harnessRevision,
    baselineRevision: DESIGN.baselineRevision,
    generatedAt,
    candidateSamples: 0,
    pilotEnclosingWallMs,
    inventorySha256: pairedLogReceiptSha256(inventory),
    calibrationSha256: pairedLogReceiptSha256(calibration),
    design: DESIGN,
    cells,
  };
}

export function finalizeProcessResetPilotReceipt(receipt) {
  validateProcessResetPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01', 'receipt identity drifted');
  invariant(receipt.designId === DESIGN.id, 'receipt design drifted');
  invariant(receipt.baselineRevision === DESIGN.baselineRevision, 'receipt baseline drifted');
  invariant(receipt.candidateSamples === 0, 'pilot observed candidate data');
  invariant(Number.isFinite(receipt.pilotEnclosingWallMs) && receipt.pilotEnclosingWallMs >= 0 && receipt.pilotEnclosingWallMs <= DESIGN.measurement.maximumPilotWallMs, 'whole-pilot wall bound escaped');
  invariant(/^[0-9a-f]{40}$/u.test(receipt.preregRevision) && /^[0-9a-f]{40}$/u.test(receipt.harnessRevision), 'receipt exact revisions missing');
  invariant(/^[0-9a-f]{64}$/u.test(receipt.inventorySha256) && /^[0-9a-f]{64}$/u.test(receipt.calibrationSha256), 'content addresses missing');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESIGN.engines.length, 'desktop cell matrix missing');

  const output = structuredClone(receipt);
  const tokens = new Set();
  const [aaLow, aaHigh] = DESIGN.controls.aaBand;
  for (let cellIndex = 0; cellIndex < output.cells.length; cellIndex++) {
    const cell = output.cells[cellIndex];
    const engine = DESIGN.engines[cellIndex];
    invariant(cell?.id === `desktop-${engine}` && cell.engine === engine, `${engine}: cell identity drifted`);
    invariant(typeof cell.browserVersion === 'string' && cell.browserVersion.length > 0, `${engine}: browser version missing`);
    invariant(JSON.stringify(cell.scenes?.map(({ id }) => id)) === JSON.stringify(DESIGN.sceneIds), `${engine}: scene matrix drifted`);
    for (let sceneIndex = 0; sceneIndex < cell.scenes.length; sceneIndex++) {
      const scene = cell.scenes[sceneIndex];
      const label = `${cell.id}/${scene.id}`;
      validatePair(scene.raw?.aa, scene.id, 'a', 'b', 1, 1, ['AB', 'BA'], `${label}/aa`, tokens, cell.browserVersion);
      validatePair(scene.raw?.deliberate2x, scene.id, 'single', 'doubled', 1, 2, ['SD', 'DS'], `${label}/deliberate2x`, tokens, cell.browserVersion);
      const seed = DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3);
      scene.aa = pairedLogRatioInterval(scene.raw.aa.a, scene.raw.aa.b, seed, DESIGN.controls.bootstrapIterations);
      scene.deliberate2x = pairedLogRatioInterval(scene.raw.deliberate2x.doubled, scene.raw.deliberate2x.single, seed ^ 0x2a2a2a, DESIGN.controls.bootstrapIterations);
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  invariant(tokens.size === DESIGN.engines.length * DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 4, 'formal-arm isolation-token cardinality drifted');
  output.processIsolation = {
    kind: 'fresh-browser-process-per-formal-arm',
    uniqueFormalArmTokens: tokens.size,
  };
  return output;
}
