import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

export const POWER_METHOD_ID = PROFILE_PREREGISTRATION.statistics.powerContract.id;
export const POWER_TRIALS = 10_000;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DESKTOP = Object.freeze([
  ['desktop-chromium', 'chromium'],
  ['desktop-firefox', 'firefox'],
  ['desktop-webkit', 'webkit'],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01: ${message}`);
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'content-addressed receipt contains non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  invariant(value && typeof value === 'object', 'content-addressed receipt contains unsupported value');  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function receiptSha256(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

function finiteEqual(actual, expected, label) {
  invariant(Number.isFinite(actual), `${label} missing`);
  invariant(Object.is(actual, expected), `${label} drifted from raw evidence`);
}

function singleSampleValues(left, right, label) {
  invariant(Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.length >= 2, `${label}: paired clusters missing`);
  const a = new Array(left.length);
  const b = new Array(right.length);
  for (let index = 0; index < left.length; index++) {
    invariant(left[index]?.run === right[index]?.run, `${label}: run pairing drifted`);
    invariant(left[index]?.semantic === true && right[index]?.semantic === true, `${label}: semantic control failed`);
    invariant(left[index]?.samples?.length === 1 && right[index]?.samples?.length === 1, `${label}: control requires one sample per run-block`);
    a[index] = left[index].samples[0];
    b[index] = right[index].samples[0];
    invariant(Number.isFinite(a[index]) && a[index] > 0 && Number.isFinite(b[index]) && b[index] > 0, `${label}: invalid sample`);
  }
  return { a, b };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}


function controlInterval(left, right, seed, profile) {
  const { a, b } = singleSampleValues(left, right, 'scenario control');
  const iterations = profile.statistics.bootstrapIterations;
  const random = lcg(seed);
  const ratios = new Array(iterations);
  const sampledA = new Array(a.length);
  const sampledB = new Array(b.length);
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let cluster = 0; cluster < a.length; cluster++) {
      const index = Math.floor(random() * a.length);
      sampledA[cluster] = a[index];
      sampledB[cluster] = b[index];
    }
    ratios[iteration] = median(sampledA) / median(sampledB);
  }
  return {
    ratio: median(a) / median(b),
    lower95: quantile(ratios, 0.025),
    upper95: quantile(ratios, 0.975),
  };
}

function validateClusters(clusters, runBlocks, floorMs, label) {
  invariant(Array.isArray(clusters) && clusters.length === runBlocks, `${label}: run-block count drifted`);
  for (let run = 0; run < clusters.length; run++) {
    const cluster = clusters[run];
    invariant(cluster?.run === run, `${label}: run identity drifted`);
    invariant(cluster.semantic === true, `${label}: semantic oracle failed`);
    invariant(Array.isArray(cluster.samples) && cluster.samples.length === 1, `${label}: pilot cluster must contain one sample`);
    invariant(
      Number.isFinite(cluster.samples[0]) && cluster.samples[0] >= floorMs,
      `${label}: pilot sample below ${floorMs}ms timing floor`,
    );
  }
}

function validateSelectorReceipt(selector, unitBatchCalls, serialRepeats, profile, label) {
  const expected = profile.scenarioSelector;
  invariant(selector?.kind === expected.kind, `${label}: selector kind drifted`);
  invariant(selector.unitBatchCalls === unitBatchCalls, `${label}: selector live-batch binding drifted`);
  invariant(selector.serialRepeats === serialRepeats, `${label}: selector serial-repeat binding drifted`);
  invariant(unitBatchCalls === expected.unitBatchCalls, `${label}: live-batch bound drifted`);
  invariant(Number.isSafeInteger(serialRepeats) && serialRepeats > 0, `${label}: serial repeats invalid`);
  invariant((serialRepeats & (serialRepeats - 1)) === 0, `${label}: serial repeats must be a power of two`);
  invariant(serialRepeats <= expected.maximumSerialRepeats, `${label}: serial repeats exceed preregistered maximum`);
  for (const key of [
    'formalFloorMs',
    'selectionFloorMs',
    'maximumSerialRepeats',
    'discoveryProbeCount',
    'holdoutProbeCount',
    'holdoutCoverage',
    'holdoutConfidence',
    'aggregationRule',
    'positiveControlRule',
  ]) {
    invariant(Object.is(selector[key], expected[key]), `${label}: selector ${key} drifted`);
  }
  invariant(
    1 - expected.holdoutCoverage ** expected.holdoutProbeCount >= expected.holdoutConfidence,
    `${label}: selector holdout bound is weaker than preregistered confidence`,
  );
  invariant(
    Array.isArray(selector.discoveryHistory) && selector.discoveryHistory.length > 0,
    `${label}: selector discovery history missing`,
  );
  const expectedRepeats = selector.discoveryHistory.map(({ serialRepeats }) => serialRepeats);
  invariant(
    JSON.stringify(expectedRepeats) === JSON.stringify(
      Array.from({ length: Math.log2(serialRepeats) + 1 }, (_, index) => 2 ** index),
    ),
    `${label}: selector did not prove minimal power-of-two search`,
  );
  for (const [index, entry] of selector.discoveryHistory.entries()) {
    invariant(
      Array.isArray(entry.samples) && entry.samples.length === expected.discoveryProbeCount,
      `${label}: selector discovery history sample count drifted`,
    );
    const clears = entry.samples.every((sample) => Number.isFinite(sample) && sample >= expected.selectionFloorMs);
    if (index < selector.discoveryHistory.length - 1) {
      invariant(!clears, `${label}: selector skipped an earlier admissible serial repeat count`);
    } else {
      invariant(clears, `${label}: selected discovery evidence does not clear timing floor`);
      invariant(JSON.stringify(entry.samples) === JSON.stringify(selector.discovery), `${label}: selected discovery bytes drifted from history`);
    }
  }
  invariant(
    Array.isArray(selector.discovery) && selector.discovery.length === expected.discoveryProbeCount,
    `${label}: selector discovery evidence missing`,
  );
  invariant(
    Array.isArray(selector.holdout) && selector.holdout.length === expected.holdoutProbeCount,
    `${label}: selector holdout evidence missing`,
  );
  for (const [kind, samples] of [['discovery', selector.discovery], ['holdout', selector.holdout]]) {
    invariant(
      samples.every((sample) => Number.isFinite(sample) && sample >= expected.selectionFloorMs),
      `${label}: selector ${kind} escaped ${expected.selectionFloorMs}ms selection floor`,
    );
  }
}

function sceneSeed(profile, cellIndex, sceneIndex, salt = 0) {
  return (
    profile.statistics.bootstrapSeed ^
    Math.imul(cellIndex + 1, 0x45d9f3b) ^
    Math.imul(sceneIndex + 1, 0x119de1f3) ^
    salt
  ) >>> 0;
}

export function validatePilotReceipt(receipt, profile = PROFILE_PREREGISTRATION) {
  invariant(receipt?.schemaVersion === 1, 'pilot schema mismatch');
  invariant(receipt.profileId === profile.profileId && receipt.baselineRevision === profile.baseline.revision, 'pilot provenance mismatch');
  invariant(typeof receipt.pilotId === 'string' && receipt.pilotId.length > 0, 'pilot identity missing');
  invariant(typeof receipt.generatedAt === 'string' && !Number.isNaN(Date.parse(receipt.generatedAt)), 'pilot timestamp invalid');
  invariant(receipt.candidateSamples === 0, 'pilot observed candidate data');
  invariant(SHA256.test(receipt.inventoryArtifactSha256), 'pilot inventory digest missing');
  invariant(receipt.methodologyBlob === profile.baseline.methodologyBlob, 'pilot methodology drifted');
  invariant(receipt.harness?.kind === 'scenario-null-control-v3', 'pilot harness kind drifted');
  invariant(SHA40.test(receipt.harness.harnessRevision), 'pilot harness revision missing');
  invariant(receipt.harness.baselineRevision === profile.baseline.revision, 'pilot did not execute frozen baseline');
  invariant(receipt.harness.independentUnit === profile.statistics.independentUnit, 'pilot sampling unit drifted');
  invariant(receipt.harness.runBlocks === profile.statistics.minimumIndependentBlocks, 'pilot must use preregistered minimum run-blocks');  invariant(receipt.harness.samplesPerCluster === 1, 'pilot cluster cardinality drifted');
  invariant(receipt.harness.orderSeed === profile.statistics.orderSeed, 'pilot order seed drifted');
  invariant(receipt.harness.aggregateFloorMs === profile.scenarioSelector.formalFloorMs, 'pilot aggregate timing floor drifted');
  invariant(receipt.harness.selectorKind === profile.scenarioSelector.kind, 'pilot selector kind drifted');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESKTOP.length, 'pilot desktop cell matrix missing');
  invariant(
    JSON.stringify(receipt.cells.map(({ id, engine }) => [id, engine])) === JSON.stringify(DESKTOP),
    'pilot desktop cell identity drifted',
  );

  const requiredScenes = profile.statistics.m05.requiredSceneIds;
  for (let cellIndex = 0; cellIndex < receipt.cells.length; cellIndex++) {
    const cell = receipt.cells[cellIndex];
    invariant(typeof cell.browserVersion === 'string' && cell.browserVersion.length > 0, `${cell.id}: pilot browser version missing`);
    invariant(
      Array.isArray(cell.scenes) && JSON.stringify(cell.scenes.map(({ id }) => id)) === JSON.stringify(requiredScenes),
      `${cell.id}: pilot scene matrix drifted`,
    );
    for (let sceneIndex = 0; sceneIndex < cell.scenes.length; sceneIndex++) {
      const scene = cell.scenes[sceneIndex];
      const label = `${cell.id}/${scene.id}`;
      validateSelectorReceipt(scene.selector, scene.unitBatchCalls, scene.serialRepeats, profile, label);
      const blocks = receipt.harness.runBlocks;
      const floorMs = profile.scenarioSelector.formalFloorMs;
      validateClusters(scene.raw?.aa?.a, blocks, floorMs, `${label}/aa-a`);
      validateClusters(scene.raw?.aa?.b, blocks, floorMs, `${label}/aa-b`);
      validateClusters(scene.raw?.deliberate2x?.single, blocks, floorMs, `${label}/single`);
      validateClusters(scene.raw?.deliberate2x?.doubled, blocks, floorMs, `${label}/doubled`);
      const aa = controlInterval(
        scene.raw.aa.a,
        scene.raw.aa.b,
        sceneSeed(profile, cellIndex, sceneIndex),
        profile,
      );
      const deliberate = controlInterval(
        scene.raw.deliberate2x.doubled,
        scene.raw.deliberate2x.single,
        sceneSeed(profile, cellIndex, sceneIndex, 0x2a2a2a),
        profile,
      );
      for (const key of ['ratio', 'lower95', 'upper95']) {
        finiteEqual(scene.aa?.[key], aa[key], `${cell.id}/${scene.id}/aa.${key}`);
        finiteEqual(scene.deliberate2x?.[key], deliberate[key], `${cell.id}/${scene.id}/deliberate2x.${key}`);
      }
      const [aaLow, aaHigh] = profile.calibration.aaNonInferiorityBand;
      invariant(
        aa.lower95 >= aaLow && aa.upper95 <= aaHigh,
        `${cell.id}/${scene.id}: scenario A/A escaped non-inferiority band`,
      );
      invariant(
        deliberate.lower95 >= profile.calibration.deliberateWorkDetectedLower95Min,
        `${cell.id}/${scene.id}: scenario positive control unresolved`,
      );
    }
  }
  return receipt;
}export function finalizePilotReceipt(receipt, profile = PROFILE_PREREGISTRATION) {
  const output = structuredClone(receipt);
  for (let cellIndex = 0; cellIndex < output.cells.length; cellIndex++) {
    const cell = output.cells[cellIndex];
    for (let sceneIndex = 0; sceneIndex < cell.scenes.length; sceneIndex++) {
      const scene = cell.scenes[sceneIndex];
      scene.aa = controlInterval(
        scene.raw.aa.a,
        scene.raw.aa.b,
        sceneSeed(profile, cellIndex, sceneIndex),
        profile,
      );
      scene.deliberate2x = controlInterval(
        scene.raw.deliberate2x.doubled,
        scene.raw.deliberate2x.single,
        sceneSeed(profile, cellIndex, sceneIndex, 0x2a2a2a),
        profile,
      );
    }
  }
  validatePilotReceipt(output, profile);
  return output;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1))];
}
function normalCdf(x) {
  const absolute = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute);
  const tail = density * t * (
    0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
  );
  const positive = 1 - tail;
  return x >= 0 ? positive : 1 - positive;
}

function blockLogRatios(scene) {
  const left = scene.raw.aa.a;
  const right = scene.raw.aa.b;
  invariant(left.length === right.length, `${scene.id}: A/A block count mismatch`);
  return left.map((cluster, index) => {
    const other = right[index];
    invariant(cluster.run === other.run, `${scene.id}: A/A run pairing drifted`);
    const a = cluster.samples[0];
    const b = other.samples[0];
    invariant(a > 0 && b > 0, `${scene.id}: A/A sample must be positive`);
    return Math.log(a / b);
  });
}

function sigmaUpper95(scene, seed) {
  const values = blockLogRatios(scene);
  const random = lcg(seed);
  const sigmas = new Array(POWER_TRIALS);
  for (let trial = 0; trial < POWER_TRIALS; trial++) {    const resample = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      resample[i] = values[Math.floor(random() * values.length)];
    }
    sigmas[trial] = sampleStandardDeviation(resample);
  }
  return quantile(sigmas, 0.95);
}

function estimatePowerFromSigma(sigma, blocks, profile, label = 'scene') {
  invariant(
    Number.isSafeInteger(blocks) &&
      blocks >= profile.statistics.minimumIndependentBlocks &&
      blocks <= profile.statistics.maximumIndependentBlocks,
    `${label}: power block count outside preregistered bounds`,
  );
  const contract = profile.statistics.powerContract;
  invariant(contract?.id === POWER_METHOD_ID, `${label}: power method is not preregistered`);
  invariant(contract.familySceneIds.includes(label), `${label}: scene is outside the preregistered power family`);
  invariant(Number.isFinite(sigma) && sigma > 0, `${label}: degenerate A/A noise cannot support a power estimate`);
  const alphaPerScene = contract.holmFirstStepAlpha;
  invariant(alphaPerScene === contract.familyAlpha / contract.familySceneIds.length, 'power Holm alpha drifted');
  invariant(contract.perTailAlpha === alphaPerScene / 2, 'power two-sided tail alpha drifted');
  const effect = -Math.log(1 - contract.practicalRelativeThreshold);
  const critical = contract.criticalZ;
  const signal = effect * Math.sqrt(blocks) / sigma;
  const estimatedPower = normalCdf(signal - critical) + normalCdf(-signal - critical);
  return {
    estimatedPower,
    noiseSigmaUpper95: sigma,
    alphaPerScene,
  };
}

export function estimateScenePower(scene, blocks, seed, profile = PROFILE_PREREGISTRATION) {
  return estimatePowerFromSigma(sigmaUpper95(scene, seed), blocks, profile, scene?.id ?? 'scene');
}

export function derivePoweredCells(pilot, profile = PROFILE_PREREGISTRATION) {
  validatePilotReceipt(pilot, profile);
  return pilot.cells.map((cell, cellIndex) => {
    // The null/control pilot fixes one noise estimate per scene. N changes only
    // the analytic power term, so bootstrapping again for every candidate N adds
    // work without adding evidence. Compute the deterministic sigma once.
    const sceneNoise = cell.scenes.map((scene, sceneIndex) => ({
      id: scene.id,
      sigma: sigmaUpper95(scene, sceneSeed(profile, cellIndex, sceneIndex, 0x6d2b79f5)),
    }));
    let last = null;
    for (
      let blocks = profile.statistics.minimumIndependentBlocks;
      blocks <= profile.statistics.maximumIndependentBlocks;
      blocks++
    ) {
      const scenePowers = sceneNoise.map(({ id, sigma }) => ({
        id,
        ...estimatePowerFromSigma(sigma, blocks, profile, id),
      }));
      invariant(profile.statistics.powerContract.aggregationRule === 'minimum-member-power', 'unsupported power aggregation rule');
      const estimatedPower = Math.min(...scenePowers.map(({ estimatedPower: power }) => power));
      last = { blocks, estimatedPower, scenePowers };
      if (estimatedPower >= profile.statistics.targetPower) break;
    }
    return {
      id: cell.id,
      chosenIndependentBlocks: last.blocks,
      practicalRelativeThreshold: profile.statistics.practicalRelativeThreshold,
      estimatedPower: last.estimatedPower,
      pilotKind: 'null-control',
      powerMethod: POWER_METHOD_ID,
      powerTrials: POWER_TRIALS,
      scenePowers: last.scenePowers,
      status: last.estimatedPower >= profile.statistics.targetPower ? 'powered' : 'unpowered-at-max-N',
    };
  });
}
export function derivePoweredDesign(
  pilot,
  inventory,
  calibration,
  generatedAt = new Date().toISOString(),
  profile = PROFILE_PREREGISTRATION,
) {
  return {
    schemaVersion: 2,
    profileId: profile.profileId,
    baselineRevision: profile.baseline.revision,
    designId: `${pilot.pilotId}-powered-design-v1`,
    generatedAt,
    candidateSamples: 0,
    methodologyBlob: profile.baseline.methodologyBlob,
    powerMethod: POWER_METHOD_ID,
    powerTrials: POWER_TRIALS,
    inventoryArtifactSha256: receiptSha256(inventory),
    calibrationArtifactSha256: receiptSha256(calibration),
    pilotArtifactSha256: receiptSha256(pilot),
    cells: derivePoweredCells(pilot, profile),
  };}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const pilotPath = arg('--pilot');
  const inventoryPath = arg('--inventory');
  const calibrationPath = arg('--calibration');
  const outPath = arg('--out');
  invariant(
    pilotPath && inventoryPath && calibrationPath && outPath,
    'power-design CLI requires --pilot --inventory --calibration --out',
  );
  const [pilot, inventory, calibration] = await Promise.all([
    readFile(pilotPath, 'utf8').then(JSON.parse),
    readFile(inventoryPath, 'utf8').then(JSON.parse),
    readFile(calibrationPath, 'utf8').then(JSON.parse),
  ]);
  const design = derivePoweredDesign(pilot, inventory, calibration);
  const { eligibleDesktopCells } = await import('./validate.mjs');
  eligibleDesktopCells(inventory, calibration, design, pilot);
  await writeFile(outPath, `${JSON.stringify(design, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    designId: design.designId,
    cells: design.cells.map(({ id, chosenIndependentBlocks, estimatedPower, status }) => ({
      id, chosenIndependentBlocks, estimatedPower, status,
    })),
  })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
