import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  REFERENCE_NORMALIZED_PREREGISTRATION as DESIGN,
  validateReferenceNormalizedPreregistration,
} from './reference-normalized-preregistration.mjs';
import { finalizeReferenceNormalizedPilotReceipt } from './reference-normalized-pilot-core.mjs';
import { pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';
import { estimateScenePower } from './power-design.mjs';
import { validateCalibrationReceipt } from './validate.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 reference-normalized power: ${message}`);
}

function normalCdf(x) {
  const absolute = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const positive = 1 - tail;
  return x >= 0 ? positive : 1 - positive;
}

function powerFromSigma(sigma, blocks, sceneId) {
  const contract = PROFILE_PREREGISTRATION.statistics.powerContract;
  invariant(contract.familySceneIds.includes(sceneId), `${sceneId}: outside frozen power family`);
  invariant(Number.isFinite(sigma) && sigma > 0, `${sceneId}: degenerate A/A noise cannot support power`);
  const effect = -Math.log(1 - contract.practicalRelativeThreshold);
  const signal = effect * Math.sqrt(blocks) / sigma;
  return normalCdf(signal - contract.criticalZ) + normalCdf(-signal - contract.criticalZ);
}

function sceneSeed(cellIndex, sceneIndex) {
  return (PROFILE_PREREGISTRATION.statistics.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3) ^ 0x6d2b79f5) >>> 0;
}

export function deriveReferenceNormalizedPoweredDesign(pilot, inventory, calibration, generatedAt = new Date().toISOString()) {
  validateReferenceNormalizedPreregistration();
  validateCalibrationReceipt(calibration);
  const acceptedPilot = finalizeReferenceNormalizedPilotReceipt(pilot);
  invariant(acceptedPilot.inventorySha256 === pairedLogReceiptSha256(inventory), 'inventory content address does not match pilot');
  invariant(acceptedPilot.calibrationSha256 === pairedLogReceiptSha256(calibration), 'calibration content address does not match pilot');

  const cells = acceptedPilot.cells.map((cell, cellIndex) => {
    const noise = cell.scenes.map((scene, sceneIndex) => {
      const initial = estimateScenePower(scene, DESIGN.minimumIndependentBlocks, sceneSeed(cellIndex, sceneIndex), PROFILE_PREREGISTRATION);
      return { id: scene.id, sigma: initial.noiseSigmaUpper95 };
    });
    let chosen = null;
    for (let blocks = DESIGN.minimumIndependentBlocks; blocks <= DESIGN.maximumIndependentBlocks; blocks++) {
      const scenePowers = noise.map(({ id, sigma }) => ({ id, noiseSigmaUpper95: sigma, estimatedPower: powerFromSigma(sigma, blocks, id) }));
      const estimatedPower = Math.min(...scenePowers.map(({ estimatedPower: value }) => value));
      chosen = { blocks, estimatedPower, scenePowers };
      if (estimatedPower >= DESIGN.targetPower) break;
    }
    invariant(chosen, `${cell.id}: missing power result`);
    const previousEstimatedPower = chosen.blocks === DESIGN.minimumIndependentBlocks
      ? null
      : Math.min(...noise.map(({ id, sigma }) => powerFromSigma(sigma, chosen.blocks - 1, id)));
    if (chosen.estimatedPower >= DESIGN.targetPower && previousEstimatedPower !== null) {
      invariant(previousEstimatedPower < DESIGN.targetPower, `${cell.id}: chosen N is not minimal`);
    }
    return {
      id: cell.id,
      chosenIndependentBlocks: chosen.blocks,
      previousIndependentBlocks: chosen.blocks === DESIGN.minimumIndependentBlocks ? null : chosen.blocks - 1,
      previousEstimatedPower,
      estimatedPower: chosen.estimatedPower,
      practicalRelativeThreshold: PROFILE_PREREGISTRATION.statistics.practicalRelativeThreshold,
      powerMethod: PROFILE_PREREGISTRATION.statistics.powerContract.id,
      scenePowers: chosen.scenePowers,
      status: chosen.estimatedPower >= DESIGN.targetPower ? 'powered' : 'unpowered-at-max-N',
    };
  });

  return {
    schemaVersion: 1,
    node: 'PROFILE-01',
    designId: `${DESIGN.id}-powered-design-v1`,
    generatedAt,
    candidateSamples: 0,
    baselineRevision: DESIGN.baselineRevision,
    preregRevision: acceptedPilot.preregRevision,
    harnessRevision: acceptedPilot.harnessRevision,
    powerMethod: PROFILE_PREREGISTRATION.statistics.powerContract.id,
    targetPower: DESIGN.targetPower,
    inventoryArtifactSha256: pairedLogReceiptSha256(inventory),
    calibrationArtifactSha256: pairedLogReceiptSha256(calibration),
    pilotArtifactSha256: pairedLogReceiptSha256(acceptedPilot),
    cells,
  };
}

async function main() {
  const [pilotPath, inventoryPath, calibrationPath, outputPath] = process.argv.slice(2);
  invariant(pilotPath && inventoryPath && calibrationPath && outputPath, 'expected pilot, inventory, calibration and output paths');
  const [pilot, inventory, calibration] = await Promise.all([
    readFile(pilotPath, 'utf8').then(JSON.parse),
    readFile(inventoryPath, 'utf8').then(JSON.parse),
    readFile(calibrationPath, 'utf8').then(JSON.parse),
  ]);
  const design = deriveReferenceNormalizedPoweredDesign(pilot, inventory, calibration);
  await writeFile(outputPath, `${JSON.stringify(design, null, 2)}\n`, 'utf8');
  const pass = design.cells.every(({ status }) => status === 'powered');
  process.stdout.write(`${JSON.stringify({ status: pass ? 'PASS' : 'FAIL', designId: design.designId, candidateSamples: 0, sha256: pairedLogReceiptSha256(design), cells: design.cells.map(({ id, chosenIndependentBlocks, previousIndependentBlocks, previousEstimatedPower, estimatedPower, status }) => ({ id, chosenIndependentBlocks, previousIndependentBlocks, previousEstimatedPower, estimatedPower, status })) }, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
