import { FIXED_WORK_PREREGISTRATION as DESIGN, validateFixedWorkPreregistration } from './fixed-work-preregistration.mjs';
import { pairedLogRatioInterval, pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 fixed-work pilot: ${message}`);
}

export class FixedWorkResolutionFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 fixed-work pilot: ${message}`);
    this.name = 'FixedWorkResolutionFailure';
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

function cluster(run, observation, label) {
  invariant(observation?.semantic === true, `${label}: semantic oracle failed`);
  return {
    run,
    samples: [observation.costPerLogicalUnitMs],
    ownerMs: observation.ownerMs,
    enclosingWallMs: observation.enclosingWallMs,
    logicalUnits: observation.logicalUnits,
    physicalExecutions: observation.physicalExecutions,
    workMultiplier: observation.workMultiplier,
    semantic: true,
  };
}

/**
 * Acquire exactly one preregistered fixed-work packet. Timing never controls
 * how much semantic work executes; it can only reject the completed packet.
 */
export async function acquireFixedWorkObservation(measurePacket, sceneId, workMultiplier = 1) {
  validateFixedWorkPreregistration();
  invariant(typeof measurePacket === 'function', 'measurePacket must be a function');
  invariant(DESIGN.sceneIds.includes(sceneId), `unknown scene ${sceneId}`);
  invariant(workMultiplier === 1 || workMultiplier === 2, 'work multiplier must be 1 or 2');

  const logicalUnits = expectedLogicalUnits(sceneId);
  const result = await measurePacket({ sceneId, logicalUnits, workMultiplier });
  invariant(result && result.semantic === true, `${sceneId}: packet semantic oracle failed`);
  invariant(Number.isFinite(result.ownerMs) && result.ownerMs >= 0, `${sceneId}: invalid owner-time`);
  invariant(Number.isFinite(result.enclosingWallMs) && result.enclosingWallMs >= result.ownerMs, `${sceneId}: invalid enclosing wall-time`);
  invariant(result.logicalUnits === logicalUnits, `${sceneId}: fixed logical-unit count drifted`);
  invariant(result.workMultiplier === workMultiplier, `${sceneId}: work multiplier drifted`);
  invariant(result.physicalExecutions === logicalUnits * workMultiplier, `${sceneId}: physical-work count drifted`);

  if (result.enclosingWallMs > DESIGN.measurement.maximumEnclosingWallMs) {
    throw new FixedWorkResolutionFailure('fixed packet exceeded enclosing wall bound', {
      sceneId,
      logicalUnits,
      workMultiplier,
      ownerMs: result.ownerMs,
      enclosingWallMs: result.enclosingWallMs,
      maximumEnclosingWallMs: DESIGN.measurement.maximumEnclosingWallMs,
    });
  }
  if (result.ownerMs < DESIGN.measurement.minimumOwnedMs) {
    throw new FixedWorkResolutionFailure('fixed packet did not clear frozen owner-time floor', {
      sceneId,
      logicalUnits,
      workMultiplier,
      ownerMs: result.ownerMs,
      minimumOwnedMs: DESIGN.measurement.minimumOwnedMs,
    });
  }

  return {
    ownerMs: result.ownerMs,
    enclosingWallMs: result.enclosingWallMs,
    logicalUnits,
    physicalExecutions: result.physicalExecutions,
    workMultiplier,
    costPerLogicalUnitMs: result.ownerMs / logicalUnits,
    semantic: true,
  };
}

export async function acquireFixedWorkControls(measurePacket, sceneId, options = {}) {
  validateFixedWorkPreregistration();
  const runBlocks = options.runBlocks ?? DESIGN.controls.runBlocks;
  const orderSeed = options.orderSeed ?? DESIGN.controls.orderSeed;
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const nextOrder = orderGenerator(orderSeed);
  const aa = { a: [], b: [] };
  const deliberate2x = { single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    let a;
    let b;
    if (nextOrder()) {
      b = await acquireFixedWorkObservation(measurePacket, sceneId, 1);
      a = await acquireFixedWorkObservation(measurePacket, sceneId, 1);
    } else {
      a = await acquireFixedWorkObservation(measurePacket, sceneId, 1);
      b = await acquireFixedWorkObservation(measurePacket, sceneId, 1);
    }
    aa.a.push(cluster(run, a, `run ${run}/aa-a`));
    aa.b.push(cluster(run, b, `run ${run}/aa-b`));

    let single;
    let doubled;
    if (nextOrder()) {
      doubled = await acquireFixedWorkObservation(measurePacket, sceneId, 2);
      single = await acquireFixedWorkObservation(measurePacket, sceneId, 1);
    } else {
      single = await acquireFixedWorkObservation(measurePacket, sceneId, 1);
      doubled = await acquireFixedWorkObservation(measurePacket, sceneId, 2);
    }
    deliberate2x.single.push(cluster(run, single, `run ${run}/single`));
    deliberate2x.doubled.push(cluster(run, doubled, `run ${run}/doubled`));
  }
  return { aa, deliberate2x };
}

function validateClusterSet(clusters, sceneId, workMultiplier, label) {
  invariant(Array.isArray(clusters) && clusters.length === DESIGN.controls.runBlocks, `${label}: run-block count drifted`);
  const logicalUnits = expectedLogicalUnits(sceneId);
  for (let run = 0; run < clusters.length; run++) {
    const entry = clusters[run];
    invariant(entry?.run === run && entry.semantic === true, `${label}: run identity/semantic drifted`);
    invariant(entry.samples?.length === 1 && Number.isFinite(entry.samples[0]) && entry.samples[0] > 0, `${label}: normalized sample invalid`);
    invariant(entry.ownerMs >= DESIGN.measurement.minimumOwnedMs, `${label}: owner-time floor escaped`);
    invariant(entry.enclosingWallMs >= entry.ownerMs && entry.enclosingWallMs <= DESIGN.measurement.maximumEnclosingWallMs, `${label}: wall bound escaped`);
    invariant(entry.logicalUnits === logicalUnits, `${label}: fixed logical-unit count escaped`);
    invariant(entry.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
    invariant(entry.physicalExecutions === logicalUnits * workMultiplier, `${label}: physical-work count drifted`);
    invariant(Object.is(entry.samples[0], entry.ownerMs / logicalUnits), `${label}: raw/normalized mismatch`);
  }
}

export function buildFixedWorkPilotReceipt({ inventory, preregRevision, harnessRevision, cells, generatedAt = new Date().toISOString() }) {
  validateFixedWorkPreregistration();
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'preregRevision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harnessRevision must be exact SHA');
  return {
    schemaVersion: 1,
    node: 'PROFILE-01',
    designId: DESIGN.id,
    preregRevision,
    harnessRevision,
    baselineRevision: DESIGN.baselineRevision,
    generatedAt,
    candidateSamples: 0,
    inventorySha256: pairedLogReceiptSha256(inventory),
    design: DESIGN,
    cells,
  };
}

export function finalizeFixedWorkPilotReceipt(receipt) {
  validateFixedWorkPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01', 'receipt identity drifted');
  invariant(receipt.designId === DESIGN.id, 'receipt design drifted');
  invariant(receipt.baselineRevision === DESIGN.baselineRevision, 'receipt baseline drifted');
  invariant(receipt.candidateSamples === 0, 'pilot observed candidate data');
  invariant(/^[0-9a-f]{40}$/u.test(receipt.preregRevision) && /^[0-9a-f]{40}$/u.test(receipt.harnessRevision), 'receipt exact revisions missing');
  invariant(/^[0-9a-f]{64}$/u.test(receipt.inventorySha256), 'inventory digest missing');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESIGN.engines.length, 'desktop cell matrix missing');

  const output = structuredClone(receipt);
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
      validateClusterSet(scene.raw?.aa?.a, scene.id, 1, `${label}/aa-a`);
      validateClusterSet(scene.raw?.aa?.b, scene.id, 1, `${label}/aa-b`);
      validateClusterSet(scene.raw?.deliberate2x?.single, scene.id, 1, `${label}/single`);
      validateClusterSet(scene.raw?.deliberate2x?.doubled, scene.id, 2, `${label}/doubled`);

      const seed = DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3);
      scene.aa = pairedLogRatioInterval(scene.raw.aa.a, scene.raw.aa.b, seed, DESIGN.controls.bootstrapIterations);
      scene.deliberate2x = pairedLogRatioInterval(
        scene.raw.deliberate2x.doubled,
        scene.raw.deliberate2x.single,
        seed ^ 0x2a2a2a,
        DESIGN.controls.bootstrapIterations,
      );
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  return output;
}
