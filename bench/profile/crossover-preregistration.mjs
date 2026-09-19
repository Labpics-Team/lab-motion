import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 symmetric-crossover preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Bounded-work successor to symmetric-crossover-owner-v1.
 *
 * The v1 crossover was not scientifically falsified: its exact acquisition was
 * terminated by the 45-minute workflow carrier before a pilot receipt existed.
 * The closed fixed-work receipt already proves that uniform 128-copy replication
 * massively oversamples the collection scene. This successor keeps the crossover
 * estimator, semantic work counts, owner boundary, thresholds and run-block N,
 * but removes excluded replication work before fresh data: collection uses 32
 * copies while direct manipulation conservatively retains 128. The 32-copy choice
 * is frozen from immutable predecessor controls, not selected from this pilot.
 */
export const CROSSOVER_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'symmetric-crossover-bounded-work-v2',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  predecessor: frozen({
    family: 'symmetric-crossover-owner-v1',
    outcome: 'BLOCKED/UNPROVEN',
    acquisitionRun: 35411038127,
    artifactId: 10573714746,
    artifactSha256: '8fa63e448377a4e09a5fe92bb391ed689fee20349c8c47b1bf435449b5272dc0',
    headRevision: '5e377ca1aed5e4851c2f5d515951dd678ccd5247',
    blocker: '45-minute workflow carrier expired before crossover-pilot.json was written; preregistered scientific falsifiers did not fire',
  }),
  premiseChange: frozen({
    from: 'uniform 128-copy replication for both scenes with no whole-pilot wall budget',
    to: 'scene-specific frozen replication derived from an immutable null/control receipt plus an explicit whole-pilot wall budget',
    reopenFact: 'fixed-work receipt 8cb5a5a9… observed collection owner-time >=2376.8 ms at 128 copies, so 32 copies remove 75% of collection replication while retaining a 14.8x linear safety margin over the unchanged 40 ms floor; direct manipulation remains at 128 copies',
  }),
  batchingEvidence: frozen({
    sourceFamily: 'fixed-work-phase-owner-v1',
    acquisitionRun: 35405683775,
    artifactId: 10573256299,
    rawReceiptSha256: '8cb5a5a943bae7ca7d0de8cf562264aabef844323149015125a8fd6152c2970c',
    sourceBatchCalls: 128,
    observedMinimumOwnerMsByScene: frozen({
      'collection-reorder-100': 2376.79999999993,
      'direct-manipulation-sheet': 176,
    }),
    sourceSummedEnclosingWallMs: 1312465.3,
    sourceCollectionSummedEnclosingWallMs: 1128730.8,
    rule: 'remove only replication already shown unnecessary by immutable pre-pilot controls; no discovery or same-pilot batch escalation',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen(['collection-reorder-100', 'direct-manipulation-sheet']),
  measurement: frozen({
    kind: 'fixed-semantic-work-symmetric-crossover-v1',
    liveBatchCallsByScene: frozen({
      'collection-reorder-100': 32,
      'direct-manipulation-sheet': 128,
    }),
    maximumPilotWallMs: 1_800_000,
    logicalUnitsByScene: frozen({
      'collection-reorder-100': 1,
      'direct-manipulation-sheet': 512,
    }),
    minimumOwnedMsPerComponent: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    maximumEnclosingWallMsPerComponent: 60_000,
    workRule: 'every component executes exactly the frozen logical-unit count; no timer-driven stop, discovery, escalation, or optional stopping',
    ownerBoundary: 'library calls, library-owned callback dispatch, and virtual frame drains are timed; app DOM mutation/setup/render and semantic assertions are excluded',
  }),
  crossover: frozen({
    replicatesPerArm: 2,
    aaPatterns: frozen(['ABBA', 'BAAB']),
    deliberatePatterns: frozen(['SDDS', 'DSSD']),
    armSummary: 'geometric mean of the two positive component costs; equivalently arithmetic mean on log(cost)',
    independentUnit: 'run-block',
    cancellationInvariant: 'for either pattern the two arms occupy positions with equal position sum 3, cancelling any first-order drift in log(cost)',
    positiveControl: 'D executes two complete physical scene executions per frozen logical unit; S executes one; both use the same symmetric position balance',
  }),
  controls: frozen({
    runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
    orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
    bootstrapSeed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
    bootstrapIterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    statisticId: 'paired-run-block-log-ratio-median-v1',
    aaBand: PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand,
    deliberate2xLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    pairIdentity: 'the crossover collapses to one sample per arm per run-block before whole-block bootstrap; component observations are retained only for audit',
  }),
  power: PROFILE_PREREGISTRATION.statistics.powerContract,
  targetPower: PROFILE_PREREGISTRATION.statistics.targetPower,
  minimumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  maximumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.maximumIndependentBlocks,
  failureRule: 'any semantic failure, fixed-work count drift, component below the frozen timing floor, component wall bound, whole-pilot wall bound, malformed crossover, A/A escape, unresolved deliberate-2x, or unpowered design at max N closes this family; do not increase work/batch counts, widen thresholds, raise wall bounds, or repeat to green',
  attributionReview: 'independent review of exact source plus content-addressed raw receipt and powered design is required before candidate admission',
});

export function validateCrossoverPreregistration(design = CROSSOVER_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'symmetric-crossover-bounded-work-v2', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(['collection-reorder-100', 'direct-manipulation-sheet']), 'scene roster drifted');
  invariant(design.measurement.liveBatchCallsByScene['collection-reorder-100'] === 32, 'collection live batch drifted');
  invariant(design.measurement.liveBatchCallsByScene['direct-manipulation-sheet'] === 128, 'direct live batch drifted');
  invariant(design.measurement.maximumPilotWallMs === 1_800_000, 'whole-pilot wall bound drifted');
  invariant(design.measurement.logicalUnitsByScene['collection-reorder-100'] === 1, 'collection work count drifted');
  invariant(design.measurement.logicalUnitsByScene['direct-manipulation-sheet'] === 512, 'direct work count drifted');
  invariant(design.measurement.minimumOwnedMsPerComponent === 40, 'timing floor drifted');
  invariant(design.measurement.maximumEnclosingWallMsPerComponent === 60_000, 'wall bound drifted');
  invariant(design.crossover.replicatesPerArm === 2, 'crossover replication drifted');
  invariant(JSON.stringify(design.crossover.aaPatterns) === JSON.stringify(['ABBA', 'BAAB']), 'A/A crossover patterns drifted');
  invariant(JSON.stringify(design.crossover.deliberatePatterns) === JSON.stringify(['SDDS', 'DSSD']), 'positive-control crossover patterns drifted');
  invariant(design.controls.runBlocks === 20, 'run-block count drifted');
  invariant(design.controls.bootstrapIterations === 10_000, 'bootstrap count drifted');
  invariant(design.controls.aaBand[0] === 0.95 && design.controls.aaBand[1] === 1.05, 'A/A band drifted');
  invariant(design.controls.deliberate2xLower95Min === 1.5, 'positive-control threshold drifted');
  invariant(design.targetPower === 0.8 && design.minimumIndependentBlocks === 20 && design.maximumIndependentBlocks === 60, 'power bounds drifted');
  invariant(design.predecessor.artifactSha256 === '8fa63e448377a4e09a5fe92bb391ed689fee20349c8c47b1bf435449b5272dc0', 'blocked predecessor identity drifted');
  invariant(design.batchingEvidence.rawReceiptSha256 === '8cb5a5a943bae7ca7d0de8cf562264aabef844323149015125a8fd6152c2970c', 'batch evidence identity drifted');
  return true;
}
