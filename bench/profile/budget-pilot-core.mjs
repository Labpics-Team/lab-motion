import { createHash } from 'node:crypto';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  OWNED_TIME_BUDGET_PREREGISTRATION as DESIGN,
  validateOwnedTimeBudgetPreregistration,
} from './budget-preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 owned-time pilot: ${message}`);
}

export class OwnedTimeBudgetFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 owned-time pilot: ${message}`);
    this.name = 'OwnedTimeBudgetFailure';
    this.evidence = evidence;
  }
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    invariant(typeof value !== 'number' || Number.isFinite(value), 'receipt contains non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  invariant(value && typeof value === 'object', 'receipt contains unsupported value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function budgetReceiptSha256(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
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

function observation(run, sample, label) {
  invariant(sample?.semantic === true, `${label}: semantic oracle failed`);
  invariant(Number.isFinite(sample.ownerMs) && sample.ownerMs >= DESIGN.measurement.targetOwnedMs, `${label}: owner-time budget unresolved`);
  invariant(Number.isFinite(sample.enclosingWallMs) && sample.enclosingWallMs >= sample.ownerMs, `${label}: enclosing wall cannot be below owner-time sum`);
  invariant(Number.isSafeInteger(sample.logicalUnits) && sample.logicalUnits > 0, `${label}: logical-unit count invalid`);
  invariant(Number.isSafeInteger(sample.physicalExecutions) && sample.physicalExecutions === sample.logicalUnits * sample.workMultiplier, `${label}: physical-work count drifted`);
  invariant(sample.workMultiplier === 1 || sample.workMultiplier === 2, `${label}: work multiplier invalid`);
  invariant(Number.isFinite(sample.costPerLogicalUnitMs) && sample.costPerLogicalUnitMs > 0, `${label}: normalized cost invalid`);
  invariant(Object.is(sample.costPerLogicalUnitMs, sample.ownerMs / sample.logicalUnits), `${label}: normalized cost does not match raw owner-time`);
  return {
    run,
    samples: [sample.costPerLogicalUnitMs],
    ownerMs: sample.ownerMs,
    enclosingWallMs: sample.enclosingWallMs,
    logicalUnits: sample.logicalUnits,
    physicalExecutions: sample.physicalExecutions,
    workMultiplier: sample.workMultiplier,
    semantic: true,
  };
}

/**
 * One formal observation. The only adaptive quantity is the number of physical
 * executions inside the observation. It follows a frozen owner-time budget and
 * never changes a candidate sample count or a statistical stopping rule.
 */
export async function acquireOwnedTimeObservation(measurePhysicalExecution, workMultiplier = 1, options = {}) {
  validateOwnedTimeBudgetPreregistration();
  const targetOwnedMs = options.targetOwnedMs ?? DESIGN.measurement.targetOwnedMs;
  const maximumLogicalUnits = options.maximumLogicalUnits ?? DESIGN.measurement.maximumLogicalUnits;
  const maximumEnclosingWallMs = options.maximumEnclosingWallMs ?? DESIGN.measurement.maximumEnclosingWallMs;
  invariant(typeof measurePhysicalExecution === 'function', 'measurePhysicalExecution must be a function');
  invariant(workMultiplier === 1 || workMultiplier === 2, 'workMultiplier must be 1 or 2');
  invariant(Number.isFinite(targetOwnedMs) && targetOwnedMs > 0, 'targetOwnedMs must be positive');
  invariant(Number.isSafeInteger(maximumLogicalUnits) && maximumLogicalUnits > 0, 'maximumLogicalUnits must be positive');
  invariant(Number.isFinite(maximumEnclosingWallMs) && maximumEnclosingWallMs > targetOwnedMs, 'maximumEnclosingWallMs must exceed targetOwnedMs');

  let ownerMs = 0;
  let enclosingWallMs = 0;
  let logicalUnits = 0;
  let physicalExecutions = 0;

  while (ownerMs < targetOwnedMs) {
    if (logicalUnits >= maximumLogicalUnits) {
      throw new OwnedTimeBudgetFailure('owner-time target not reached before logical-unit bound', {
        stage: 'budget-bound', targetOwnedMs, maximumLogicalUnits, ownerMs, enclosingWallMs, logicalUnits, physicalExecutions, workMultiplier,
      });
    }
    logicalUnits++;
    for (let execution = 0; execution < workMultiplier; execution++) {
      const sample = await measurePhysicalExecution();
      invariant(sample && Number.isFinite(sample.ownerMs) && sample.ownerMs >= 0, 'physical execution returned invalid owner-time');
      invariant(Number.isFinite(sample.enclosingWallMs) && sample.enclosingWallMs >= sample.ownerMs, 'physical execution returned invalid enclosing wall-time');
      ownerMs += sample.ownerMs;
      enclosingWallMs += sample.enclosingWallMs;
      physicalExecutions++;
      if (enclosingWallMs > maximumEnclosingWallMs && ownerMs < targetOwnedMs) {
        throw new OwnedTimeBudgetFailure('owner-time target not reached before enclosing wall-time bound', {
          stage: 'wall-bound', targetOwnedMs, maximumEnclosingWallMs, ownerMs, enclosingWallMs, logicalUnits, physicalExecutions, workMultiplier,
        });
      }
    }
  }

  return {
    ownerMs,
    enclosingWallMs,
    logicalUnits,
    physicalExecutions,
    workMultiplier,
    costPerLogicalUnitMs: ownerMs / logicalUnits,
    semantic: true,
  };
}

export async function acquireOwnedTimeControls(measurePhysicalExecution, options = {}) {
  const runBlocks = options.runBlocks ?? DESIGN.runBlocks;
  const orderSeed = options.orderSeed ?? PROFILE_PREREGISTRATION.statistics.orderSeed;
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const nextOrder = orderGenerator(orderSeed);
  const aa = { a: [], b: [] };
  const deliberate2x = { single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    let a;
    let b;
    if (nextOrder()) {
      b = await acquireOwnedTimeObservation(measurePhysicalExecution, 1, options);
      a = await acquireOwnedTimeObservation(measurePhysicalExecution, 1, options);
    } else {
      a = await acquireOwnedTimeObservation(measurePhysicalExecution, 1, options);
      b = await acquireOwnedTimeObservation(measurePhysicalExecution, 1, options);
    }
    aa.a.push(observation(run, a, `run ${run}/aa-a`));
    aa.b.push(observation(run, b, `run ${run}/aa-b`));

    let single;
    let doubled;
    if (nextOrder()) {
      doubled = await acquireOwnedTimeObservation(measurePhysicalExecution, 2, options);
      single = await acquireOwnedTimeObservation(measurePhysicalExecution, 1, options);
    } else {
      single = await acquireOwnedTimeObservation(measurePhysicalExecution, 1, options);
      doubled = await acquireOwnedTimeObservation(measurePhysicalExecution, 2, options);
    }
    deliberate2x.single.push(observation(run, single, `run ${run}/single`));
    deliberate2x.doubled.push(observation(run, doubled, `run ${run}/doubled`));
  }
  return { aa, deliberate2x };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

export function pairedBudgetRatioInterval(left, right, seed, iterations = PROFILE_PREREGISTRATION.statistics.bootstrapIterations) {
  invariant(Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.length > 1, 'paired ratio input mismatch');
  const a = left.map((cluster) => cluster.samples?.[0]);
  const b = right.map((cluster) => cluster.samples?.[0]);
  invariant(a.every((value) => Number.isFinite(value) && value > 0) && b.every((value) => Number.isFinite(value) && value > 0), 'paired ratio contains invalid sample');
  const random = lcg(seed);
  const ratios = new Array(iterations);
  const sampledA = new Array(a.length);
  const sampledB = new Array(b.length);
  for (let trial = 0; trial < iterations; trial++) {
    for (let index = 0; index < a.length; index++) {
      const chosen = Math.floor(random() * a.length);
      sampledA[index] = a[chosen];
      sampledB[index] = b[chosen];
    }
    ratios[trial] = median(sampledA) / median(sampledB);
  }
  return { ratio: median(a) / median(b), lower95: quantile(ratios, 0.025), upper95: quantile(ratios, 0.975) };
}

function validateClusterSet(clusters, workMultiplier, label) {
  invariant(Array.isArray(clusters) && clusters.length === DESIGN.runBlocks, `${label}: run-block count drifted`);
  for (let run = 0; run < clusters.length; run++) {
    const cluster = clusters[run];
    invariant(cluster?.run === run && cluster.semantic === true, `${label}: run identity/semantic drifted`);
    invariant(cluster.samples?.length === 1 && Number.isFinite(cluster.samples[0]) && cluster.samples[0] > 0, `${label}: normalized sample invalid`);
    invariant(cluster.ownerMs >= DESIGN.measurement.targetOwnedMs, `${label}: owner-time target escaped`);
    invariant(cluster.enclosingWallMs >= cluster.ownerMs && cluster.enclosingWallMs <= DESIGN.measurement.maximumEnclosingWallMs, `${label}: wall bound escaped`);
    invariant(Number.isSafeInteger(cluster.logicalUnits) && cluster.logicalUnits > 0 && cluster.logicalUnits <= DESIGN.measurement.maximumLogicalUnits, `${label}: logical-unit bound escaped`);
    invariant(cluster.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
    invariant(cluster.physicalExecutions === cluster.logicalUnits * workMultiplier, `${label}: physical-work count drifted`);
    invariant(Object.is(cluster.samples[0], cluster.ownerMs / cluster.logicalUnits), `${label}: raw/normalized mismatch`);
  }
}

export function buildOwnedTimePilotReceipt({ inventory, harnessRevision, preregRevision, cells, generatedAt = new Date().toISOString() }) {
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harnessRevision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'preregRevision must be exact SHA');
  return {
    schemaVersion: 1,
    node: 'PROFILE-01',
    profileId: PROFILE_PREREGISTRATION.profileId,
    designId: DESIGN.id,
    preregRevision,
    harnessRevision,
    baselineRevision: DESIGN.baselineRevision,
    generatedAt,
    candidateSamples: 0,
    inventorySha256: budgetReceiptSha256(inventory),
    design: DESIGN,
    cells,
  };
}

export function finalizeOwnedTimePilotReceipt(receipt) {
  validateOwnedTimeBudgetPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01', 'receipt identity drifted');
  invariant(receipt.profileId === PROFILE_PREREGISTRATION.profileId && receipt.designId === DESIGN.id, 'receipt design drifted');
  invariant(receipt.baselineRevision === DESIGN.baselineRevision, 'receipt baseline drifted');
  invariant(receipt.candidateSamples === 0, 'pilot observed candidate data');
  invariant(/^[0-9a-f]{40}$/u.test(receipt.preregRevision) && /^[0-9a-f]{40}$/u.test(receipt.harnessRevision), 'receipt exact revisions missing');
  invariant(/^[0-9a-f]{64}$/u.test(receipt.inventorySha256), 'inventory digest missing');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESIGN.engines.length, 'desktop cell matrix missing');

  const output = structuredClone(receipt);
  const [aaLow, aaHigh] = PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand;
  const [factorLow, factorHigh] = DESIGN.controls.factorTwoRatioBand;
  for (let cellIndex = 0; cellIndex < output.cells.length; cellIndex++) {
    const cell = output.cells[cellIndex];
    const engine = DESIGN.engines[cellIndex];
    invariant(cell?.id === `desktop-${engine}` && cell.engine === engine, `${engine}: cell identity drifted`);
    invariant(typeof cell.browserVersion === 'string' && cell.browserVersion.length > 0, `${engine}: browser version missing`);
    invariant(JSON.stringify(cell.scenes?.map(({ id }) => id)) === JSON.stringify(DESIGN.sceneIds), `${engine}: scene matrix drifted`);
    for (let sceneIndex = 0; sceneIndex < cell.scenes.length; sceneIndex++) {
      const scene = cell.scenes[sceneIndex];
      const label = `${cell.id}/${scene.id}`;
      validateClusterSet(scene.raw?.aa?.a, 1, `${label}/aa-a`);
      validateClusterSet(scene.raw?.aa?.b, 1, `${label}/aa-b`);
      validateClusterSet(scene.raw?.deliberate2x?.single, 1, `${label}/single`);
      validateClusterSet(scene.raw?.deliberate2x?.doubled, 2, `${label}/doubled`);
      scene.aa = pairedBudgetRatioInterval(
        scene.raw.aa.a,
        scene.raw.aa.b,
        PROFILE_PREREGISTRATION.statistics.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3),
      );
      scene.deliberate2x = pairedBudgetRatioInterval(
        scene.raw.deliberate2x.doubled,
        scene.raw.deliberate2x.single,
        PROFILE_PREREGISTRATION.statistics.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3) ^ 0x2a2a2a,
      );
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min, `${label}: deliberate-2x unresolved`);
      invariant(scene.deliberate2x.lower95 >= factorLow && scene.deliberate2x.upper95 <= factorHigh, `${label}: deliberate-2x escaped [${factorLow}, ${factorHigh}]`);
    }
  }
  return output;
}
