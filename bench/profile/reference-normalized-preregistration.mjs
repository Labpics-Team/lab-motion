import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 reference-normalized preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor after fixed-work and symmetric-crossover owner-time
 * both failed the frozen direct-manipulation A/A band. The new representation
 * does not add repetitions or relax admission. Instead, every fixed semantic
 * packet is bracketed by the already-required synthetic calibration workload,
 * and inference uses owner cost in contemporaneous reference-time units.
 *
 * The reference is a precision covariate only. It is never subtracted from the
 * reported owner cost, never counted as product work, and cannot hide raw data:
 * raw owner/wall/reference times remain in the immutable receipt.
 */
export const REFERENCE_NORMALIZED_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'precalibration-standardized-owner-ms-v3',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  supersedes: frozen({ design: 'calibration-bracket-standardized-owner-ms-v2', outcome: 'superseded-before-pilot', reason: 'static attribution review found that a post-packet reference could absorb product-induced GC or other protected resource cost; acquisition was cancelled before any result was inspected or admitted' }),
  predecessor: frozen({
    family: 'symmetric-crossover-bounded-work-v2',
    outcome: 'NO-GO',
    acquisitionRun: 35414049878,
    artifactId: 10575611266,
    rawReceiptSha256: 'bdf08653819eec4ef8dba6033d68e659784050d35a64a4fdaa0c9bd2822f59b0',
    headRevision: 'afb6174d405c6efe3031ffdbb7edbbfea32e8692',
    falsifier: 'desktop-firefox/direct-manipulation-sheet A/A upper95 1.060785 exceeded frozen 1.05 despite symmetric ABBA/BAAB first-order log-drift cancellation',
  }),
  premiseChange: frozen({
    from: 'raw owner-time ratio with phase/order cancellation as the only drift control',
    to: 'fixed semantic owner work standardized in milliseconds by a validated same-engine calibration workload measured in two consecutive pre-packet references immediately before each packet',
    rationale: 'the surviving direct-cell variance can arise from multiplicative browser/runner speed changes that first-order order balancing cannot remove; a pre-treatment covariate measures that nuisance scale without changing product work',
    forbiddenReopen: 'no extra run blocks, batch escalation, wider A/A band, higher wall bound, or retry-to-green',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen(['collection-reorder-100', 'direct-manipulation-sheet']),
  measurement: frozen({
    kind: 'fixed-semantic-work-precalibration-standardized-ms-v3',
    liveBatchCallsByScene: frozen({
      'collection-reorder-100': 32,
      'direct-manipulation-sheet': 128,
    }),
    logicalUnitsByScene: frozen({
      'collection-reorder-100': 1,
      'direct-manipulation-sheet': 512,
    }),
    maximumPilotWallMs: 1_800_000,
    maximumEnclosingWallMsPerPacket: 60_000,
    minimumOwnerMsPerPacket: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    referenceFloorMs: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    workRule: 'every packet executes exactly the frozen logical-unit and live-batch counts; no timer-driven stop, discovery, work escalation, or optional stopping',
    ownerBoundary: 'library calls, library-owned callback dispatch, and virtual frame drains are timed; app DOM mutation/setup/render and semantic assertions remain outside ownerMs',
  }),
  reference: frozen({
    owner: 'canonical PROFILE-01 desktop calibration receipt',
    source: 'the same deterministic synthetic loop and per-engine batchCopies selected by the mandatory PASS calibration immediately before this pilot',
    bindingRule: 'pilot must validate the exact calibration receipt, then bind iterationsPerCopy and batchCopiesByEngine without changing them',
    anchorRule: 'referenceAnchorMs is the deterministic median of all 1x samples in that engine calibration (A/A a+b plus deliberate single), frozen before formal pilot acquisition',
    preReferenceRule: 'measure two fixed reference packets consecutively before each semantic packet; both must independently clear the unchanged 40 ms floor and no reference may execute after product work',
    standardizationRule: 'standardizedCostMs = (ownerMs / logicalUnits) * referenceAnchorMs / sqrt(referenceLeadMs * referenceBeforeMs)',
    reportingRule: 'retain raw ownerMs, enclosingWallMs, referenceLeadMs, referenceBeforeMs, referenceAnchorMs, logicalUnits, batchCalls and standardizedCostMs; reference time is never subtracted from ownerMs',
    independenceRule: 'reference workload contains no Lab Motion calls, DOM/layout reads, scene state or candidate code and is prewarmed before formal acquisition',
  }),
  controls: frozen({
    runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
    orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
    bootstrapSeed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
    bootstrapIterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    statisticId: 'paired-run-block-log-ratio-median-v1',
    aaOrder: 'seeded AB/BA within each run-block',
    deliberateOrder: 'seeded SD/DS within each run-block',
    aaBand: PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand,
    deliberate2xLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    pairIdentity: 'one standardized-ms sample per arm per run-block; raw owner and reference timings and the frozen calibration anchor remain attached to that arm',
  }),
  power: PROFILE_PREREGISTRATION.statistics.powerContract,
  targetPower: PROFILE_PREREGISTRATION.statistics.targetPower,
  minimumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  maximumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.maximumIndependentBlocks,
  failureRule: 'any semantic failure, work-count drift, raw owner packet below the frozen 40 ms floor, either pre-packet reference below 40 ms, packet/whole-pilot wall bound, malformed pair, A/A escape, unresolved deliberate-2x, invalid calibration binding, or unpowered design at max N closes this family; no same-family retuning or repeat is admissible',
  attributionReview: 'independent review must verify both the exact owner boundary and that reference standardization is a pre-treatment nuisance-scale covariate and cannot absorb post-treatment product cost before candidate admission',
});

export function validateReferenceNormalizedPreregistration(design = REFERENCE_NORMALIZED_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'precalibration-standardized-owner-ms-v3', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds), 'scene roster drifted');
  invariant(design.measurement.liveBatchCallsByScene['collection-reorder-100'] === 32, 'collection live batch drifted');
  invariant(design.measurement.liveBatchCallsByScene['direct-manipulation-sheet'] === 128, 'direct live batch drifted');
  invariant(design.measurement.logicalUnitsByScene['collection-reorder-100'] === 1, 'collection logical-unit count drifted');
  invariant(design.measurement.logicalUnitsByScene['direct-manipulation-sheet'] === 512, 'direct logical-unit count drifted');
  invariant(design.measurement.minimumOwnerMsPerPacket === 40 && design.measurement.referenceFloorMs === 40, 'timing floor drifted');
  invariant(design.measurement.maximumEnclosingWallMsPerPacket === 60_000, 'packet wall bound drifted');
  invariant(design.measurement.maximumPilotWallMs === 1_800_000, 'whole-pilot wall bound drifted');
  invariant(/sqrt\(referenceLeadMs \* referenceBeforeMs\)/.test(design.reference.standardizationRule), 'reference standardization law drifted');
  invariant(/no reference may execute after product work/.test(design.reference.preReferenceRule), 'post-treatment reference leaked into design');
  invariant(/median of all 1x samples/.test(design.reference.anchorRule), 'reference anchor law drifted');
  invariant(/never subtracted/.test(design.reference.reportingRule), 'reference became a cost subtraction');
  invariant(/no Lab Motion calls/.test(design.reference.independenceRule), 'reference independence missing');
  invariant(design.controls.runBlocks === 20 && design.controls.bootstrapIterations === 10_000, 'control sample/bootstrap count drifted');
  invariant(JSON.stringify(design.controls.aaBand) === JSON.stringify([0.95, 1.05]), 'A/A band drifted');
  invariant(design.controls.deliberate2xLower95Min === 1.5, 'positive-control threshold drifted');
  invariant(design.power.id === 'm05-paired-log-ratio-holm-v1', 'power contract drifted');
  invariant(design.targetPower === 0.8 && design.minimumIndependentBlocks === 20 && design.maximumIndependentBlocks === 60, 'power bounds drifted');
  invariant(design.predecessor.rawReceiptSha256 === 'bdf08653819eec4ef8dba6033d68e659784050d35a64a4fdaa0c9bd2822f59b0', 'predecessor evidence drifted');
  invariant(/no same-family retuning or repeat/.test(design.failureRule), 'fail-closed retry law missing');
  return true;
}
