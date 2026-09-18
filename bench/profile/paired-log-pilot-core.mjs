import { createHash } from 'node:crypto';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  PAIRED_LOG_PREREGISTRATION as DESIGN,
  validatePairedLogPreregistration,
} from './paired-log-preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 paired-log pilot: ${message}`);
}

export class PairedLogBudgetFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 paired-log pilot: ${message}`);
    this.name = 'PairedLogBudgetFailure';
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

export function pairedLogReceiptSha256(receipt) {
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

export async function acquirePairedLogObservation(measurePhysicalExecution, workMultiplier = 1, options = {}) {
  validatePairedLogPreregistration();
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
      throw new PairedLogBudgetFailure('owner-time target not reached before logical-unit bound', {
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
        throw new PairedLogBudgetFailure('owner-time target not reached before enclosing wall-time bound', {
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

export async function acquirePairedLogControls(measurePhysicalExecution, options = {}) {
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
      b = await acquirePairedLogObservation(measurePhysicalExecution, 1, options);
      a = await acquirePairedLogObservation(measurePhysicalExecution, 1, options);
    } else {
      a = await acquirePairedLogObservation(measurePhysicalExecution, 1, options);
      b = await acquirePairedLogObservation(measurePhysicalExecution, 1, options);
    }
    aa.a.push(observation(run, a, `run ${run}/aa-a`));
    aa.b.push(observation(run, b, `run ${run}/aa-b`));

    let single;
    let doubled;
    if (nextOrder()) {
      doubled = await acquirePairedLogObservation(measurePhysicalExecution, 2, options);
      single = await acquirePairedLogObservation(measurePhysicalExecution, 1, options);
    } else {
      single = await acquirePairedLogObservation(measurePhysicalExecution, 1, options);
      doubled = await acquirePairedLogObservation(measurePhysicalExecution, 2, options);
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

function pairedLogRatios(left, right, label) {
  invariant(Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.length > 1, `${label}: paired ratio input mismatch`);
  return left.map((cluster, index) => {
    const other = right[index];
    invariant(cluster?.run === other?.run, `${label}: run pairing drifted`);
    invariant(cluster.semantic === true && other.semantic === true, `${label}: semantic oracle failed`);
    invariant(cluster.samples?.length === 1 && other.samples?.length === 1, `${label}: one sample per run-block required`);
    const a = cluster.samples[0];
    const b = other.samples[0];
    invariant(Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0, `${label}: invalid paired sample`);
    return Math.log(a / b);
  });
}

export function pairedLogRatioInterval(left, right, seed, iterations = DESIGN.controls.bootstrapIterations) {
  const logRatios = pairedLogRatios(left, right, 'paired-log control');
  invariant(Number.isSafeInteger(iterations) && iterations > 0, 'bootstrap iterations invalid');
  const random = lcg(seed);
  const centers = new Array(iterations);
  const resample = new Array(logRatios.length);
  for (let trial = 0; trial < iterations; trial++) {
    for (let index = 0; index < logRatios.length; index++) {
      resample[index] = logRatios[Math.floor(random() * logRatios.length)];
    }
    centers[trial] = median(resample);
  }
  return {
    ratio: Math.exp(median(logRatios)),
    lower95: Math.exp(quantile(centers, 0.025)),
    upper95: Math.exp(quantile(centers, 0.975)),
  };
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

export function buildPairedLogPilotReceipt({ inventory, harnessRevision, preregRevision, cells, generatedAt = new Date().toISOString() }) {
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
    inventorySha256: pairedLogReceiptSha256(inventory),
    design: DESIGN,
    cells,
  };
}

export function finalizePairedLogPilotReceipt(receipt) {
  validatePairedLogPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01', 'receipt identity drifted');
  invariant(receipt.profileId === PROFILE_PREREGISTRATION.profileId && receipt.designId === DESIGN.id, 'receipt design drifted');
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
      validateClusterSet(scene.raw?.aa?.a, 1, `${label}/aa-a`);
      validateClusterSet(scene.raw?.aa?.b, 1, `${label}/aa-b`);
      validateClusterSet(scene.raw?.deliberate2x?.single, 1, `${label}/single`);
      validateClusterSet(scene.raw?.deliberate2x?.doubled, 2, `${label}/doubled`);
      scene.aa = pairedLogRatioInterval(
        scene.raw.aa.a,
        scene.raw.aa.b,
        DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3),
      );
      scene.deliberate2x = pairedLogRatioInterval(
        scene.raw.deliberate2x.doubled,
        scene.raw.deliberate2x.single,
        DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3) ^ 0x2a2a2a,
      );
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  return output;
}
