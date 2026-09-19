import {
  FRESH_PAIRED_BLOCK_PREREGISTRATION as DESIGN,
  validateFreshPairedBlockPreregistration,
} from './fresh-paired-block-preregistration.mjs';
import { pairedLogRatioInterval, pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 fresh-paired-block pilot: ${message}`);
}

export class FreshPairedBlockFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 fresh-paired-block pilot: ${message}`);
    this.name = 'FreshPairedBlockFailure';
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

function observationFrom(raw, sceneId, run, workMultiplier, token, position) {
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  invariant(raw?.semantic === true, `${sceneId}/run-${run}/${position}: semantic oracle failed`);
  invariant(raw.isolationToken === token, `${sceneId}/run-${run}/${position}: pair token drifted`);
  invariant(raw.position === position, `${sceneId}/run-${run}/${position}: pair position drifted`);
  invariant(Number.isFinite(raw.ownerMs) && raw.ownerMs >= 0, `${sceneId}/run-${run}/${position}: invalid owner-time`);
  invariant(Number.isFinite(raw.enclosingWallMs) && raw.enclosingWallMs >= raw.ownerMs, `${sceneId}/run-${run}/${position}: invalid enclosing wall-time`);
  invariant(Number.isFinite(raw.warmupWallMs) && raw.warmupWallMs >= 0, `${sceneId}/run-${run}/${position}: warmup wall diagnostic invalid`);
  invariant(raw.logicalUnits === logicalUnits, `${sceneId}/run-${run}/${position}: logical-unit count drifted`);
  invariant(raw.batchCalls === batchCalls, `${sceneId}/run-${run}/${position}: live-batch count drifted`);
  invariant(raw.warmupLogicalUnits === warmupLogicalUnits, `${sceneId}/run-${run}/${position}: warmup count drifted`);
  invariant(raw.workMultiplier === workMultiplier, `${sceneId}/run-${run}/${position}: work multiplier drifted`);
  invariant(raw.physicalExecutions === logicalUnits * workMultiplier, `${sceneId}/run-${run}/${position}: formal work count drifted`);
  if (raw.ownerMs < DESIGN.measurement.minimumOwnerMsPerArm) {
    throw new FreshPairedBlockFailure('formal arm did not clear frozen owner-time floor', {
      sceneId,
      run,
      position,
      workMultiplier,
      ownerMs: raw.ownerMs,
      minimumOwnerMsPerArm: DESIGN.measurement.minimumOwnerMsPerArm,
    });
  }
  return {
    run,
    samples: [raw.ownerMs / logicalUnits],
    ownerMs: raw.ownerMs,
    enclosingWallMs: raw.enclosingWallMs,
    warmupWallMs: raw.warmupWallMs,
    logicalUnits,
    physicalExecutions: raw.physicalExecutions,
    batchCalls,
    warmupLogicalUnits,
    workMultiplier,
    processLifecycle: raw.processLifecycle,
    isolationToken: token,
    pairOrdinal: raw.pairOrdinal,
    position,
    browserVersion: raw.browserVersion,
    semantic: true,
  };
}

export async function acquireFreshPairedBlock(measureFreshPair, sceneId, run, pairKind, order) {
  validateFreshPairedBlockPreregistration();
  invariant(typeof measureFreshPair === 'function', 'measureFreshPair must be a function');
  invariant(DESIGN.sceneIds.includes(sceneId), `unknown scene ${sceneId}`);
  invariant(Number.isSafeInteger(run) && run >= 0, 'run identity invalid');
  invariant(pairKind === 'aa' || pairKind === 'deliberate2x', 'pair kind invalid');

  const expectedOrders = pairKind === 'aa' ? ['AB', 'BA'] : ['SD', 'DS'];
  invariant(expectedOrders.includes(order), `${pairKind}: order ${order} is not preregistered`);
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');

  const arms = pairKind === 'aa'
    ? (order === 'AB'
      ? [{ key: 'a', workMultiplier: 1 }, { key: 'b', workMultiplier: 1 }]
      : [{ key: 'b', workMultiplier: 1 }, { key: 'a', workMultiplier: 1 }])
    : (order === 'SD'
      ? [{ key: 'single', workMultiplier: 1 }, { key: 'doubled', workMultiplier: 2 }]
      : [{ key: 'doubled', workMultiplier: 2 }, { key: 'single', workMultiplier: 1 }]);

  const result = await measureFreshPair({
    sceneId,
    run,
    pairKind,
    order,
    arms,
    logicalUnits,
    batchCalls,
    warmupLogicalUnits,
  });

  invariant(result?.semantic === true, `${sceneId}/run-${run}/${pairKind}: pair semantic oracle failed`);
  invariant(result.processLifecycle === 'launch-paired-arms-close', `${sceneId}/run-${run}/${pairKind}: fresh-pair lifecycle receipt missing`);
  invariant(typeof result.isolationToken === 'string' && result.isolationToken.length >= 16, `${sceneId}/run-${run}/${pairKind}: pair isolation token missing`);
  invariant(Number.isSafeInteger(result.pairOrdinal) && result.pairOrdinal > 0, `${sceneId}/run-${run}/${pairKind}: pair ordinal missing`);
  invariant(typeof result.browserVersion === 'string' && result.browserVersion.length > 0, `${sceneId}/run-${run}/${pairKind}: browser version missing`);
  invariant(Number.isFinite(result.pairEnclosingWallMs) && result.pairEnclosingWallMs >= 0, `${sceneId}/run-${run}/${pairKind}: invalid pair wall-time`);
  if (result.pairEnclosingWallMs > DESIGN.measurement.maximumEnclosingWallMsPerPair) {
    throw new FreshPairedBlockFailure('formal pair exceeded enclosing wall bound', {
      sceneId,
      run,
      pairKind,
      pairEnclosingWallMs: result.pairEnclosingWallMs,
      maximumEnclosingWallMsPerPair: DESIGN.measurement.maximumEnclosingWallMsPerPair,
    });
  }
  invariant(Array.isArray(result.observations) && result.observations.length === 2, `${sceneId}/run-${run}/${pairKind}: pair observations missing`);

  const byKey = {};
  for (let position = 0; position < arms.length; position++) {
    const arm = arms[position];
    const raw = result.observations[position];
    invariant(raw?.key === arm.key, `${sceneId}/run-${run}/${pairKind}: observed arm order drifted`);
    invariant(raw.processLifecycle === result.processLifecycle, `${sceneId}/run-${run}/${pairKind}/${arm.key}: lifecycle drifted`);
    invariant(raw.pairOrdinal === result.pairOrdinal, `${sceneId}/run-${run}/${pairKind}/${arm.key}: pair ordinal drifted`);
    invariant(raw.browserVersion === result.browserVersion, `${sceneId}/run-${run}/${pairKind}/${arm.key}: browser version drifted`);
    byKey[arm.key] = observationFrom(raw, sceneId, run, arm.workMultiplier, result.isolationToken, position);
  }

  return {
    order,
    isolationToken: result.isolationToken,
    pairOrdinal: result.pairOrdinal,
    browserVersion: result.browserVersion,
    pairEnclosingWallMs: result.pairEnclosingWallMs,
    observations: byKey,
  };
}

export async function acquireFreshPairedControls(measureFreshPair, sceneId, options = {}) {
  validateFreshPairedBlockPreregistration();
  const runBlocks = options.runBlocks ?? DESIGN.controls.runBlocks;
  const orderSeed = options.orderSeed ?? DESIGN.controls.orderSeed;
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const nextOrder = orderGenerator(orderSeed);
  const aa = { orders: [], pairTokens: [], a: [], b: [] };
  const deliberate2x = { orders: [], pairTokens: [], single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    const aaOrder = nextOrder() ? 'AB' : 'BA';
    const aaPair = await acquireFreshPairedBlock(measureFreshPair, sceneId, run, 'aa', aaOrder);
    aa.orders.push(aaOrder);
    aa.pairTokens.push(aaPair.isolationToken);
    aa.a.push(aaPair.observations.a);
    aa.b.push(aaPair.observations.b);

    const deliberateOrder = nextOrder() ? 'SD' : 'DS';
    const deliberatePair = await acquireFreshPairedBlock(measureFreshPair, sceneId, run, 'deliberate2x', deliberateOrder);
    deliberate2x.orders.push(deliberateOrder);
    deliberate2x.pairTokens.push(deliberatePair.isolationToken);
    deliberate2x.single.push(deliberatePair.observations.single);
    deliberate2x.doubled.push(deliberatePair.observations.doubled);
  }

  return { aa, deliberate2x };
}

function validateObservation(entry, sceneId, run, workMultiplier, label, expectedToken, expectedPosition, browserVersion) {
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  invariant(entry?.run === run && entry.semantic === true, `${label}: run identity/semantic drifted`);
  invariant(entry.samples?.length === 1 && Number.isFinite(entry.samples[0]) && entry.samples[0] > 0, `${label}: exactly one positive sample required`);
  invariant(entry.processLifecycle === 'launch-paired-arms-close', `${label}: lifecycle receipt drifted`);
  invariant(entry.isolationToken === expectedToken, `${label}: pair token mismatch`);
  invariant(entry.position === expectedPosition, `${label}: position drifted`);
  invariant(entry.browserVersion === browserVersion, `${label}: browser version drifted`);
  invariant(entry.logicalUnits === logicalUnits, `${label}: logical-unit count drifted`);
  invariant(entry.batchCalls === batchCalls, `${label}: live-batch count drifted`);
  invariant(entry.warmupLogicalUnits === warmupLogicalUnits, `${label}: warmup work drifted`);
  invariant(entry.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
  invariant(entry.physicalExecutions === logicalUnits * workMultiplier, `${label}: formal work count drifted`);
  invariant(entry.ownerMs >= DESIGN.measurement.minimumOwnerMsPerArm, `${label}: owner floor escaped`);
  invariant(entry.enclosingWallMs >= entry.ownerMs, `${label}: arm wall-time invalid`);
  invariant(Number.isFinite(entry.warmupWallMs) && entry.warmupWallMs >= 0, `${label}: warmup wall diagnostic invalid`);
  invariant(Object.is(entry.samples[0], entry.ownerMs / logicalUnits), `${label}: sample/raw owner mismatch`);
}

function validatePair(group, sceneId, run, leftName, rightName, leftMultiplier, rightMultiplier, allowedOrders, label, tokens, browserVersion) {
  const order = group.orders[run];
  invariant(allowedOrders.includes(order), `${label}: unregistered order`);
  const token = group.pairTokens[run];
  invariant(typeof token === 'string' && token.length >= 16, `${label}: pair token missing`);
  invariant(!tokens.has(token), `${label}: pair isolation token reused across run-blocks`);
  tokens.add(token);
  const firstKey = order[0] === 'A' ? 'a' : order[0] === 'B' ? 'b' : order[0] === 'S' ? 'single' : 'doubled';
  const secondKey = firstKey === leftName ? rightName : leftName;
  const positions = { [firstKey]: 0, [secondKey]: 1 };
  validateObservation(group[leftName][run], sceneId, run, leftMultiplier, `${label}/${leftName}`, token, positions[leftName], browserVersion);
  validateObservation(group[rightName][run], sceneId, run, rightMultiplier, `${label}/${rightName}`, token, positions[rightName], browserVersion);
}

export function buildFreshPairedPilotReceipt({ inventory, calibration, preregRevision, harnessRevision, cells, pilotEnclosingWallMs, generatedAt = new Date().toISOString() }) {
  validateFreshPairedBlockPreregistration();
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

export function finalizeFreshPairedPilotReceipt(receipt) {
  validateFreshPairedBlockPreregistration(receipt?.design);
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
      const groups = [
        ['aa', scene.raw?.aa, 'a', 'b', 1, 1, ['AB', 'BA']],
        ['deliberate2x', scene.raw?.deliberate2x, 'single', 'doubled', 1, 2, ['SD', 'DS']],
      ];
      for (const [groupName, group, leftName, rightName, leftMultiplier, rightMultiplier, orders] of groups) {
        invariant(Array.isArray(group?.orders) && group.orders.length === DESIGN.controls.runBlocks, `${label}/${groupName}: order receipts missing`);
        invariant(Array.isArray(group?.pairTokens) && group.pairTokens.length === DESIGN.controls.runBlocks, `${label}/${groupName}: pair-token receipts missing`);
        invariant(Array.isArray(group[leftName]) && group[leftName].length === DESIGN.controls.runBlocks, `${label}/${groupName}: left block count drifted`);
        invariant(Array.isArray(group[rightName]) && group[rightName].length === DESIGN.controls.runBlocks, `${label}/${groupName}: right block count drifted`);
        for (let run = 0; run < DESIGN.controls.runBlocks; run++) {
          validatePair(group, scene.id, run, leftName, rightName, leftMultiplier, rightMultiplier, orders, `${label}/${groupName}/run-${run}`, tokens, cell.browserVersion);
        }
      }
      const seed = DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3);
      scene.aa = pairedLogRatioInterval(scene.raw.aa.a, scene.raw.aa.b, seed, DESIGN.controls.bootstrapIterations);
      scene.deliberate2x = pairedLogRatioInterval(scene.raw.deliberate2x.doubled, scene.raw.deliberate2x.single, seed ^ 0x2a2a2a, DESIGN.controls.bootstrapIterations);
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  invariant(tokens.size === DESIGN.engines.length * DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 2, 'pair-process isolation-token cardinality drifted');
  output.processIsolation = {
    kind: 'fresh-browser-process-per-paired-run-block',
    uniquePairTokens: tokens.size,
    formalArmsPerPair: 2,
  };
  return output;
}
