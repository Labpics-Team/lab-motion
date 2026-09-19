import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  REFERENCE_NORMALIZED_PREREGISTRATION as DESIGN,
  validateReferenceNormalizedPreregistration,
} from './reference-normalized-preregistration.mjs';
import { pairedLogRatioInterval, pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 reference-normalized pilot: ${message}`);
}

export class ReferenceNormalizedResolutionFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 reference-normalized pilot: ${message}`);
    this.name = 'ReferenceNormalizedResolutionFailure';
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

function expectedLogicalUnits(sceneId) {
  const units = DESIGN.measurement.logicalUnitsByScene[sceneId];
  invariant(Number.isSafeInteger(units) && units > 0, `${sceneId}: frozen logical-unit count missing`);
  return units;
}

function standardizedCostMs(ownerMs, logicalUnits, referenceBeforeMs, referenceAfterMs, referenceAnchorMs) {
  invariant(Number.isFinite(ownerMs) && ownerMs > 0, 'owner cost must be positive');
  invariant(Number.isSafeInteger(logicalUnits) && logicalUnits > 0, 'logical units must be positive');
  invariant(Number.isFinite(referenceBeforeMs) && referenceBeforeMs > 0, 'reference-before must be positive');
  invariant(Number.isFinite(referenceAfterMs) && referenceAfterMs > 0, 'reference-after must be positive');
  invariant(Number.isFinite(referenceAnchorMs) && referenceAnchorMs > 0, 'reference anchor must be positive');
  return (ownerMs / logicalUnits) * referenceAnchorMs / Math.sqrt(referenceBeforeMs * referenceAfterMs);
}

export async function acquireReferenceNormalizedObservation(measurePacket, sceneId, workMultiplier = 1) {
  validateReferenceNormalizedPreregistration();
  invariant(typeof measurePacket === 'function', 'measurePacket must be a function');
  invariant(DESIGN.sceneIds.includes(sceneId), `unknown scene ${sceneId}`);
  invariant(workMultiplier === 1 || workMultiplier === 2, 'work multiplier must be 1 or 2');

  const logicalUnits = expectedLogicalUnits(sceneId);
  const result = await measurePacket({ sceneId, logicalUnits, workMultiplier });
  invariant(result?.semantic === true, `${sceneId}: semantic oracle failed`);
  invariant(Number.isFinite(result.ownerMs) && result.ownerMs >= 0, `${sceneId}: invalid owner-time`);
  invariant(Number.isFinite(result.referenceBeforeMs) && result.referenceBeforeMs >= 0, `${sceneId}: invalid reference-before`);
  invariant(Number.isFinite(result.referenceAfterMs) && result.referenceAfterMs >= 0, `${sceneId}: invalid reference-after`);
  invariant(Number.isFinite(result.referenceAnchorMs) && result.referenceAnchorMs > 0, `${sceneId}: invalid reference anchor`);
  invariant(Number.isFinite(result.enclosingWallMs) && result.enclosingWallMs >= result.ownerMs, `${sceneId}: invalid enclosing wall-time`);
  invariant(result.logicalUnits === logicalUnits, `${sceneId}: fixed logical-unit count drifted`);
  invariant(result.workMultiplier === workMultiplier, `${sceneId}: work multiplier drifted`);
  invariant(result.physicalExecutions === logicalUnits * workMultiplier, `${sceneId}: physical-work count drifted`);
  invariant(result.batchCalls === DESIGN.measurement.liveBatchCallsByScene[sceneId], `${sceneId}: frozen live-batch count drifted`);
  invariant(Number.isSafeInteger(result.referenceCopies) && result.referenceCopies > 0, `${sceneId}: reference batch binding missing`);
  invariant(Number.isSafeInteger(result.referenceIterationsPerCopy) && result.referenceIterationsPerCopy > 0, `${sceneId}: reference iteration binding missing`);

  if (result.enclosingWallMs > DESIGN.measurement.maximumEnclosingWallMsPerPacket) {
    throw new ReferenceNormalizedResolutionFailure('packet exceeded enclosing wall bound', {
      sceneId, logicalUnits, workMultiplier, ownerMs: result.ownerMs, enclosingWallMs: result.enclosingWallMs,
      maximumEnclosingWallMsPerPacket: DESIGN.measurement.maximumEnclosingWallMsPerPacket,
    });
  }
  if (result.ownerMs < DESIGN.measurement.minimumOwnerMsPerPacket) {
    throw new ReferenceNormalizedResolutionFailure('owner packet did not clear frozen timing floor', {
      sceneId, logicalUnits, workMultiplier, ownerMs: result.ownerMs,
      minimumOwnerMsPerPacket: DESIGN.measurement.minimumOwnerMsPerPacket,
    });
  }
  if (result.referenceBeforeMs < DESIGN.measurement.referenceFloorMs || result.referenceAfterMs < DESIGN.measurement.referenceFloorMs) {
    throw new ReferenceNormalizedResolutionFailure('bracketing reference did not clear frozen timing floor', {
      sceneId, logicalUnits, workMultiplier,
      referenceBeforeMs: result.referenceBeforeMs,
      referenceAfterMs: result.referenceAfterMs,
      referenceAnchorMs: result.referenceAnchorMs,
      referenceFloorMs: DESIGN.measurement.referenceFloorMs,
    });
  }

  return {
    ownerMs: result.ownerMs,
    enclosingWallMs: result.enclosingWallMs,
    referenceBeforeMs: result.referenceBeforeMs,
    referenceAfterMs: result.referenceAfterMs,
      referenceAnchorMs: result.referenceAnchorMs,
    referenceCopies: result.referenceCopies,
    referenceIterationsPerCopy: result.referenceIterationsPerCopy,
    logicalUnits,
    physicalExecutions: result.physicalExecutions,
    batchCalls: result.batchCalls,
    workMultiplier,
    rawCostPerLogicalUnitMs: result.ownerMs / logicalUnits,
    standardizedCostMs: standardizedCostMs(result.ownerMs, logicalUnits, result.referenceBeforeMs, result.referenceAfterMs, result.referenceAnchorMs),
    semantic: true,
  };
}

function cluster(run, observation) {
  return {
    run,
    samples: [observation.standardizedCostMs],
    ...observation,
  };
}

export async function acquireReferenceNormalizedControls(measurePacket, sceneId, options = {}) {
  validateReferenceNormalizedPreregistration();
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
      a = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 1);
      b = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 1);
    } else {
      b = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 1);
      a = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 1);
    }
    aa.a.push(cluster(run, a));
    aa.b.push(cluster(run, b));

    const deliberateOrder = nextOrder() ? 'SD' : 'DS';
    deliberate2x.orders.push(deliberateOrder);
    let single;
    let doubled;
    if (deliberateOrder === 'SD') {
      single = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 1);
      doubled = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 2);
    } else {
      doubled = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 2);
      single = await acquireReferenceNormalizedObservation(measurePacket, sceneId, 1);
    }
    deliberate2x.single.push(cluster(run, single));
    deliberate2x.doubled.push(cluster(run, doubled));
  }
  return { aa, deliberate2x };
}

function validateObservation(entry, sceneId, run, workMultiplier, label) {
  const logicalUnits = expectedLogicalUnits(sceneId);
  invariant(entry?.run === run && entry.semantic === true, `${label}: run identity/semantic drifted`);
  invariant(entry.samples?.length === 1, `${label}: exactly one run-block sample required`);
  invariant(entry.logicalUnits === logicalUnits, `${label}: logical-unit count drifted`);
  invariant(entry.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
  invariant(entry.physicalExecutions === logicalUnits * workMultiplier, `${label}: physical-work count drifted`);
  invariant(entry.batchCalls === DESIGN.measurement.liveBatchCallsByScene[sceneId], `${label}: live-batch count drifted`);
  invariant(entry.ownerMs >= DESIGN.measurement.minimumOwnerMsPerPacket, `${label}: raw owner floor escaped`);
  invariant(entry.referenceBeforeMs >= DESIGN.measurement.referenceFloorMs && entry.referenceAfterMs >= DESIGN.measurement.referenceFloorMs, `${label}: reference floor escaped`);
  invariant(entry.enclosingWallMs >= entry.ownerMs && entry.enclosingWallMs <= DESIGN.measurement.maximumEnclosingWallMsPerPacket, `${label}: wall bound escaped`);
  invariant(Number.isSafeInteger(entry.referenceCopies) && entry.referenceCopies > 0, `${label}: reference copies invalid`);
  invariant(Number.isSafeInteger(entry.referenceIterationsPerCopy) && entry.referenceIterationsPerCopy > 0, `${label}: reference iterations invalid`);
  invariant(Object.is(entry.rawCostPerLogicalUnitMs, entry.ownerMs / logicalUnits), `${label}: raw cost drifted`);
  invariant(Number.isFinite(entry.referenceAnchorMs) && entry.referenceAnchorMs > 0, `${label}: reference anchor invalid`);
  const expectedStandardized = standardizedCostMs(entry.ownerMs, logicalUnits, entry.referenceBeforeMs, entry.referenceAfterMs, entry.referenceAnchorMs);
  invariant(Object.is(entry.standardizedCostMs, expectedStandardized) && Object.is(entry.samples[0], expectedStandardized), `${label}: standardized-ms sample drifted`);
}

function validatePair(group, sceneId, leftName, rightName, leftMultiplier, rightMultiplier, allowedOrders, label) {
  invariant(Array.isArray(group?.orders) && group.orders.length === DESIGN.controls.runBlocks, `${label}: order receipts missing`);
  invariant(Array.isArray(group[leftName]) && group[leftName].length === DESIGN.controls.runBlocks, `${label}: left run-block count drifted`);
  invariant(Array.isArray(group[rightName]) && group[rightName].length === DESIGN.controls.runBlocks, `${label}: right run-block count drifted`);
  for (let run = 0; run < DESIGN.controls.runBlocks; run++) {
    invariant(allowedOrders.includes(group.orders[run]), `${label}/run-${run}: unregistered order`);
    validateObservation(group[leftName][run], sceneId, run, leftMultiplier, `${label}/run-${run}/${leftName}`);
    validateObservation(group[rightName][run], sceneId, run, rightMultiplier, `${label}/run-${run}/${rightName}`);
    invariant(group[leftName][run].referenceCopies === group[rightName][run].referenceCopies, `${label}/run-${run}: reference binding changed within pair`);
    invariant(group[leftName][run].referenceIterationsPerCopy === group[rightName][run].referenceIterationsPerCopy, `${label}/run-${run}: reference iteration binding changed within pair`);
    invariant(Object.is(group[leftName][run].referenceAnchorMs, group[rightName][run].referenceAnchorMs), `${label}/run-${run}: reference anchor changed within pair`);
  }
}

export function buildReferenceNormalizedPilotReceipt({ inventory, calibration, preregRevision, harnessRevision, cells, pilotEnclosingWallMs, generatedAt = new Date().toISOString() }) {
  validateReferenceNormalizedPreregistration();
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

export function finalizeReferenceNormalizedPilotReceipt(receipt) {
  validateReferenceNormalizedPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01', 'receipt identity drifted');
  invariant(receipt.designId === DESIGN.id, 'receipt design drifted');
  invariant(receipt.baselineRevision === DESIGN.baselineRevision, 'receipt baseline drifted');
  invariant(receipt.candidateSamples === 0, 'pilot observed candidate data');
  invariant(Number.isFinite(receipt.pilotEnclosingWallMs) && receipt.pilotEnclosingWallMs >= 0 && receipt.pilotEnclosingWallMs <= DESIGN.measurement.maximumPilotWallMs, 'whole-pilot wall bound escaped');
  invariant(/^[0-9a-f]{40}$/u.test(receipt.preregRevision) && /^[0-9a-f]{40}$/u.test(receipt.harnessRevision), 'receipt exact revisions missing');
  invariant(/^[0-9a-f]{64}$/u.test(receipt.inventorySha256) && /^[0-9a-f]{64}$/u.test(receipt.calibrationSha256), 'content addresses missing');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESIGN.engines.length, 'desktop cell matrix missing');

  const output = structuredClone(receipt);
  const [aaLow, aaHigh] = DESIGN.controls.aaBand;
  for (let cellIndex = 0; cellIndex < output.cells.length; cellIndex++) {
    const cell = output.cells[cellIndex];
    const engine = DESIGN.engines[cellIndex];
    invariant(cell?.id === `desktop-${engine}` && cell.engine === engine, `${engine}: cell identity drifted`);
    invariant(typeof cell.browserVersion === 'string' && cell.browserVersion.length > 0, `${engine}: browser version missing`);
    invariant(Number.isSafeInteger(cell.referenceBinding?.iterationsPerCopy) && cell.referenceBinding.iterationsPerCopy > 0, `${engine}: reference iteration binding missing`);
    invariant(Number.isSafeInteger(cell.referenceBinding?.batchCopies) && cell.referenceBinding.batchCopies > 0, `${engine}: reference batch binding missing`);
    invariant(Number.isFinite(cell.referenceBinding?.anchorMs) && cell.referenceBinding.anchorMs > 0, `${engine}: reference anchor binding missing`);
    invariant(JSON.stringify(cell.scenes?.map(({ id }) => id)) === JSON.stringify(DESIGN.sceneIds), `${engine}: scene matrix drifted`);
    for (let sceneIndex = 0; sceneIndex < cell.scenes.length; sceneIndex++) {
      const scene = cell.scenes[sceneIndex];
      const label = `${cell.id}/${scene.id}`;
      validatePair(scene.raw?.aa, scene.id, 'a', 'b', 1, 1, ['AB', 'BA'], `${label}/aa`);
      validatePair(scene.raw?.deliberate2x, scene.id, 'single', 'doubled', 1, 2, ['SD', 'DS'], `${label}/deliberate2x`);
      for (const group of [scene.raw.aa.a, scene.raw.aa.b, scene.raw.deliberate2x.single, scene.raw.deliberate2x.doubled]) {
        for (const entry of group) {
          invariant(entry.referenceIterationsPerCopy === cell.referenceBinding.iterationsPerCopy, `${label}: reference iterations differ from cell binding`);
          invariant(entry.referenceCopies === cell.referenceBinding.batchCopies, `${label}: reference copies differ from cell binding`);
          invariant(Object.is(entry.referenceAnchorMs, cell.referenceBinding.anchorMs), `${label}: reference anchor differs from cell binding`);
        }
      }
      const seed = DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3);
      scene.aa = pairedLogRatioInterval(scene.raw.aa.a, scene.raw.aa.b, seed, DESIGN.controls.bootstrapIterations);
      scene.deliberate2x = pairedLogRatioInterval(scene.raw.deliberate2x.doubled, scene.raw.deliberate2x.single, seed ^ 0x2a2a2a, DESIGN.controls.bootstrapIterations);
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  return output;
}
