import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

/**
 * PROFILE-01 measurement-family preregistration.
 *
 * The prior owned-time-budget-v1 experiment is not reclassified. Its null/control
 * decision used a ratio of separately summarized marginals even though the frozen
 * M-05 power contract defines noise as a paired run-block log-ratio. This family
 * changes that representation before any candidate A/B sample: every formal
 * observation still resolves on a coarse owner-time budget, but null/control
 * inference preserves pair identity end-to-end.
 */
export const PAIRED_LOG_PREREGISTRATION = Object.freeze({
  schemaVersion: 1,
  node: 'PROFILE-01',
  id: 'paired-log-owner-budget-v2',
  registeredAt: '2026-09-18',
  registeredAgainstMain: '2c947007168d4964124db8ce8079bbfabc975687',
  supersedesMeasurementFamily: 'owned-time-budget-v1',
  premiseChange: 'align null/control inference with the already-preregistered paired run-block A/A log-ratio noise representation instead of ratio-of-marginal-medians',
  candidateSamplesObservedAtRegistration: false,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  engines: Object.freeze(['chromium', 'firefox', 'webkit']),
  sceneIds: Object.freeze([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  liveBatchCalls: 128,
  runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,

  measurement: Object.freeze({
    quantity: 'owner-attributed-ms-per-logical-semantic-unit',
    targetOwnedMs: 250,
    minimumCalibrationMargin: 5,
    maximumLogicalUnits: 4096,
    maximumEnclosingWallMs: 60_000,
    stoppingRule: 'within each run-block, execute fresh complete semantic units until accumulated owner-attributed time first reaches targetOwnedMs; then stop exactly once',
    normalizationRule: 'sample = accumulatedOwnerMs / completedLogicalUnits; logical-unit count is diagnostic only and never an independent observation',
    boundFailureRule: 'abort the pilot if targetOwnedMs is not reached before maximumLogicalUnits or maximumEnclosingWallMs; do not change any bound in the same pilot',
    timingResolutionRule: 'every emitted formal sample carries accumulatedOwnerMs >= targetOwnedMs; no discovery-to-holdout timing-floor transfer exists',
  }),

  controls: Object.freeze({
    statisticId: 'paired-run-block-log-ratio-median-v1',
    pairUnit: PROFILE_PREREGISTRATION.statistics.independentUnit,
    aaRule: 'for each run-block compute log(a/b); estimate exp(median(block log-ratios)); bootstrap whole paired block log-ratios, never the marginals separately',
    positiveControlRule: 'for each run-block compute log(doubled/single), where doubled executes two complete semantic scene executions per logical unit; bootstrap the paired block log-ratios',
    aaBand: Object.freeze([...PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand]),
    deliberate2xLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    bootstrapIterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    bootstrapSeed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
    candidateSamples: 0,
    pairingMutationFalsifier: 'permuting right-arm run identities while preserving both marginal multisets must be observable by the estimator',
  }),

  attribution: Object.freeze({
    ownerClock: 'existing scene harness times only Lab Motion-owned calls and virtual-frame callbacks; application mutation/setup remains outside the owner accumulator',
    enclosingWallRole: 'diagnostic finite-work bound only; never subtracted from the primary owner-time observation',
    requiredBeforeCandidateAdmission: 'browser trace/callgraph evidence independently verifies that timed owner regions contain the dominant removable Lab Motion work for each required scene',
    failureRule: 'if owner attribution cannot be independently verified, candidate admission remains closed even when null/positive controls pass',
  }),

  retryPolicy: 'a failed fresh pilot closes this family; do not change targetOwnedMs, bands, bootstrap rule, run count or estimator after observing the receipt',
  admission: Object.freeze({
    candidateSamples: 0,
    requireAllEngines: true,
    requireAllScenes: true,
    requireAaCalibration: true,
    requireDeliberate2xCalibration: true,
    requireIndependentOwnerAttribution: true,
    nextEvidence: 'fresh real null/control pilot -> deterministic powered N -> content-addressed admission tuple -> independent PROFILE review',
  }),
});

export function validatePairedLogPreregistration(
  design = PAIRED_LOG_PREREGISTRATION,
  profile = PROFILE_PREREGISTRATION,
) {
  const fail = (condition, message) => {
    if (!condition) throw new Error(`PROFILE-01 paired-log preregistration: ${message}`);
  };
  fail(design?.schemaVersion === 1 && design.node === 'PROFILE-01', 'identity drifted');
  fail(design.id === 'paired-log-owner-budget-v2', 'design id drifted');
  fail(design.candidateSamplesObservedAtRegistration === false, 'candidate data contaminated preregistration');
  fail(design.baselineRevision === profile.baseline.revision, 'baseline drifted');
  fail(design.registeredAgainstMain === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  fail(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  fail(JSON.stringify(design.sceneIds) === JSON.stringify(profile.statistics.m05.requiredSceneIds), 'scene roster drifted');
  fail(design.runBlocks === profile.statistics.minimumIndependentBlocks, 'run-block count drifted');
  fail(Number.isSafeInteger(design.liveBatchCalls) && design.liveBatchCalls > 0, 'live batch must be positive');

  const measurement = design.measurement;
  fail(Number.isFinite(measurement?.targetOwnedMs) && measurement.targetOwnedMs > 0, 'target owner-time budget missing');
  fail(measurement.targetOwnedMs >= profile.calibration.timingFloorMs * measurement.minimumCalibrationMargin, 'owner-time budget does not materially clear calibrated floor');
  fail(measurement.minimumCalibrationMargin >= 5, 'calibration margin weakened');
  fail(Number.isSafeInteger(measurement.maximumLogicalUnits) && measurement.maximumLogicalUnits > 0, 'logical-unit bound missing');
  fail(Number.isFinite(measurement.maximumEnclosingWallMs) && measurement.maximumEnclosingWallMs > measurement.targetOwnedMs, 'wall-time bound missing');
  fail(/stop exactly once/.test(measurement.stoppingRule), 'inner stopping law is not frozen');
  fail(/do not change any bound/.test(measurement.boundFailureRule), 'same-pilot retuning is not forbidden');
  fail(/no discovery-to-holdout/.test(measurement.timingResolutionRule), 'selector transfer was reintroduced');

  const controls = design.controls;
  fail(controls?.statisticId === 'paired-run-block-log-ratio-median-v1', 'control statistic drifted');
  fail(controls.pairUnit === profile.statistics.independentUnit, 'pair unit drifted');
  fail(profile.statistics.powerContract.noiseModel === 'paired run-block A/A log-ratio from the same scenario harness', 'power contract premise changed');
  fail(/log\(a\/b\)/.test(controls.aaRule) && /whole paired block log-ratios/.test(controls.aaRule), 'A/A does not preserve pairing');
  fail(/log\(doubled\/single\)/.test(controls.positiveControlRule), 'positive control does not preserve pairing');
  fail(JSON.stringify(controls.aaBand) === JSON.stringify(profile.calibration.aaNonInferiorityBand), 'A/A band drifted');
  fail(controls.deliberate2xLower95Min === profile.calibration.deliberateWorkDetectedLower95Min, 'positive-control threshold drifted');
  fail(controls.bootstrapIterations === profile.statistics.bootstrapIterations, 'bootstrap iterations drifted');
  fail(controls.candidateSamples === 0, 'candidate samples admitted by control design');
  fail(/permuting right-arm run identities/.test(controls.pairingMutationFalsifier), 'pair-identity falsifier missing');
  fail(/never subtracted/.test(design.attribution?.enclosingWallRole ?? ''), 'wall diagnostic became a subtraction estimator');
  fail(design.admission?.requireIndependentOwnerAttribution === true, 'owner attribution gate missing');
  fail(/failed fresh pilot closes this family/.test(design.retryPolicy), 'retry policy is not fail-closed');
  return design;
}
