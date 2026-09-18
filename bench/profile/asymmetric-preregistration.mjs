import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

/**
 * Premise-changing PROFILE-01 timing design registered after
 * paired-coarse-arm-difference-v1 was falsified. The failed null/control pilot
 * showed that the semantically equivalent control arm is materially cheaper
 * than the motion arm, so requiring one shared repeat count destroys clock
 * resolvability. Candidate A/B data remains forbidden.
 */
export const ASYMMETRIC_TIMING_PREREGISTRATION = Object.freeze({
  schemaVersion: 1,
  node: 'PROFILE-01',
  id: 'independent-arm-normalized-difference-v1',
  registeredAt: '2026-09-18',
  registeredAgainstMain: '2c947007168d4964124db8ce8079bbfabc975687',
  supersedesTimingFamily: 'paired-coarse-arm-difference-v1',
  premiseChange: 'select resolved repeat counts independently per arm, then compare normalized per-scene costs',
  candidateSamplesObservedAtRegistration: false,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  engines: Object.freeze(['chromium', 'firefox', 'webkit']),
  sceneIds: Object.freeze([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  liveBatchCalls: 128,
  armRepeatCandidates: Object.freeze([1, 2, 4, 8, 16, 32, 64, 128, 256]),
  timingFloorMs: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
  discoveryProbeCount: 5,
  holdoutProbeCount: 59,
  holdoutCoverage: 0.95,
  holdoutConfidence: 0.95,
  runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  estimator: Object.freeze({
    quantity: 'dominant-removable-main-thread-cost-ms-per-semantic-scene',
    representation: 'difference-of-independently-resolved-arm-normalized-wall-times',
    motionArm: 'full semantic scene with Lab Motion owner enabled',
    controlArm: 'same scene setup/application mutations/input schedule with Lab Motion owner absent',
    factorOneEstimate: 'motionWallMs / motionRepeats - controlWallMs / controlRepeats',
    armOrder: 'counterbalanced from preregistered orderSeed',
    aaRule: 'two independent factor-1 normalized differences per run-block',
    positiveControlRule: 'factor-2 executes twice the real scene work in BOTH arms while normalization stays anchored to the selected factor-1 repeat counts',
    factorTwoRatioBand: Object.freeze(PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand.map((bound) => bound * 2)),
    factorTwoRatioRule: 'the paired-bootstrap 95% interval for factor-2 / factor-1 normalized differential must stay inside 2x the preregistered A/A non-inferiority band',
    positivityRule: 'every admitted normalized differential must be finite and > 0; otherwise the estimator is unresolved',
  }),
  selector: Object.freeze({
    rule: 'for each arm independently choose the smallest preregistered repeat count whose five fresh discovery wall-times all clear timingFloorMs',
    holdoutRule: 'for each chosen arm count, 59 fresh wall-times must all clear timingFloorMs before any null/control run-block is acquired',
    holdoutFailureRule: 'abort the pilot; never escalate or retune either arm after holdout data',
    normalizationRule: 'divide each factor-1 wall-time by that arm own frozen selected repeat count before subtraction',
    rationale: 'direct clock regions stay >=40ms without forcing unequal-cost arms to share a repeat count; the estimand returns to per-semantic-scene owner cost rather than batch wall-time',
  }),
  admission: Object.freeze({
    candidateSamples: 0,
    requireAllEngines: true,
    requireAllScenes: true,
    requireIndependentArmFloors: true,
    requirePositiveNormalizedDifferentials: true,
    nextEvidence: 'real null/control pilot -> trusted power/N -> content-addressed admission',
  }),
});
