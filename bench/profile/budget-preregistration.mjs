import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

/**
 * Premise-changing PROFILE-01 timing family registered after
 * whole-scene-enclosing-wall-v1 falsified discovery -> floor transfer even
 * without cross-arm subtraction.
 *
 * There is deliberately no discovery selector. Every formal observation
 * accumulates the same frozen amount of owner-attributed semantic work before
 * it may emit a sample. The resulting sample is cost per logical semantic
 * unit. The inner unit count is not an independent sample and is never used as
 * candidate evidence.
 */
export const OWNED_TIME_BUDGET_PREREGISTRATION = Object.freeze({
  schemaVersion: 1,
  node: 'PROFILE-01',
  id: 'owned-time-budget-v1',
  registeredAt: '2026-09-18',
  registeredAgainstMain: '2c947007168d4964124db8ce8079bbfabc975687',
  supersedesTimingFamily: 'whole-scene-enclosing-wall-v1',
  premiseChange: 'replace discovery/holdout repeat selection with a fixed owner-time budget inside every formal observation',
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
    aaRule: 'two independently acquired factor-1 budget observations per run-block, counterbalanced by the frozen order seed',
    positiveControlRule: 'one logical factor-2 unit executes two complete semantic scene executions; normalization remains per logical unit, so real owned work should scale by two',
    factorTwoRatioBand: Object.freeze(PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand.map((bound) => bound * 2)),
    candidateSamples: 0,
  }),
  attribution: Object.freeze({
    ownerClock: 'existing scene harness times only Lab Motion-owned calls and virtual-frame callbacks; application mutation/setup remains outside the owner accumulator',
    enclosingWallRole: 'diagnostic bound proving the budget loop itself remains finite; never subtracted from the primary owner-time observation',
    requiredBeforeCandidateAdmission: 'browser trace/callgraph evidence independently verifies that the timed owner regions contain the dominant removable Lab Motion work for each required scene',
    failureRule: 'if owner attribution cannot be independently verified, candidate admission remains closed even when A/A and deliberate-2x controls pass',
  }),
  admission: Object.freeze({
    candidateSamples: 0,
    requireAllEngines: true,
    requireAllScenes: true,
    requireAaCalibration: true,
    requireDeliberate2xCalibration: true,
    requireIndependentOwnerAttribution: true,
    nextEvidence: 'real null/control pilot -> deterministic powered N -> content-addressed admission tuple -> independent PROFILE review',
  }),
});

export function validateOwnedTimeBudgetPreregistration(
  design = OWNED_TIME_BUDGET_PREREGISTRATION,
  profile = PROFILE_PREREGISTRATION,
) {
  const fail = (condition, message) => {
    if (!condition) throw new Error(`PROFILE-01 owned-time preregistration: ${message}`);
  };
  fail(design?.schemaVersion === 1 && design.node === 'PROFILE-01', 'identity drifted');
  fail(design.id === 'owned-time-budget-v1', 'design id drifted');
  fail(design.candidateSamplesObservedAtRegistration === false, 'candidate data contaminated preregistration');
  fail(design.baselineRevision === profile.baseline.revision, 'baseline drifted');
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
  fail(design.controls?.candidateSamples === 0, 'candidate samples admitted by control design');
  fail(JSON.stringify(design.controls.factorTwoRatioBand) === JSON.stringify([1.9, 2.1]), 'factor-2 band drifted');
  fail(/two complete semantic scene executions/.test(design.controls.positiveControlRule), 'positive control does not execute real doubled work');
  fail(/never subtracted/.test(design.attribution?.enclosingWallRole ?? ''), 'wall diagnostic became a subtraction estimator');
  fail(design.admission?.requireIndependentOwnerAttribution === true, 'owner attribution gate missing');
  return design;
}
