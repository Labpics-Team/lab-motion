import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 symmetric-crossover preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor to fixed-work-phase-owner-v1.
 *
 * Fixed semantic work removed timer-driven stopping, yet a fresh real-browser
 * pilot still failed A/A in direct manipulation. The remaining falsifier is
 * phase/order sensitivity inside a run-block. This design keeps the exact same
 * semantic work counts and owner boundary, but changes the estimator: each arm
 * is observed twice in a time-symmetric ABBA/BAAB crossover and reduced to one
 * geometric-mean sample per independent run-block. Under first-order drift in
 * log(cost), both arms have identical mean position (2.5), so order drift is
 * cancelled without treating the repeated observations as independent data.
 */
export const CROSSOVER_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'symmetric-crossover-owner-v1',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  predecessor: frozen({
    family: 'fixed-work-phase-owner-v1',
    outcome: 'NO-GO',
    acquisitionRun: 35405683775,
    artifactId: 10573256299,
    artifactSha256: '3dd3e763d6c7990872fbe2f3a2c8528366764a2aabb352d0724cd986a67a8dbe',
    rawReceiptSha256: '8cb5a5a943bae7ca7d0de8cf562264aabef844323149015125a8fd6152c2970c',
    falsifier: 'desktop-chromium/direct-manipulation-sheet A/A escaped the frozen [0.95, 1.05] band',
    lowerBound: 'fixed work alone does not remove phase/order instability; more repeats or a wider A/A band are inadmissible',
  }),
  premiseChange: frozen({
    from: 'one randomized observation per arm inside each paired run-block',
    to: 'two observations per arm in a symmetric ABBA/BAAB crossover, summarized once per run-block on the log scale',
    reopenFact: 'the predecessor falsifier is explicitly phase/order instability and a symmetric crossover cancels first-order log-cost drift without changing thresholds or semantic work',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen(['collection-reorder-100', 'direct-manipulation-sheet']),
  measurement: frozen({
    kind: 'fixed-semantic-work-symmetric-crossover-v1',
    liveBatchCalls: 128,
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
  failureRule: 'any semantic failure, fixed-work count drift, component below the frozen timing floor, wall bound, malformed crossover, A/A escape, unresolved deliberate-2x, or unpowered design at max N closes this family; do not increase work counts, widen thresholds, or repeat to green',
  attributionReview: 'independent review of exact source plus content-addressed raw receipt and powered design is required before candidate admission',
});

export function validateCrossoverPreregistration(design = CROSSOVER_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'symmetric-crossover-owner-v1', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(['collection-reorder-100', 'direct-manipulation-sheet']), 'scene roster drifted');
  invariant(design.measurement.liveBatchCalls === 128, 'live batch drifted');
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
  invariant(design.predecessor.rawReceiptSha256 === '8cb5a5a943bae7ca7d0de8cf562264aabef844323149015125a8fd6152c2970c', 'negative-evidence identity drifted');
  return true;
}
