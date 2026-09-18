import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

/**
 * Premise-changing PROFILE-01 timing design registered after
 * independent-arm-normalized-difference-v1 was falsified. The failed family
 * proved that subtracting two independently timed arms can cross zero even
 * after each arm independently clears the clock floor. Candidate A/B samples
 * remain forbidden.
 *
 * This family changes the measured representation, not a threshold: the
 * primary quantity is the directly clocked enclosing wall-time of the full
 * semantic Lab Motion scene. A structurally matched no-owner arm is retained
 * as raw attribution evidence, resolved on its own clock, but is never
 * subtracted from the primary observation. Owner attribution must be closed by
 * browser trace/callgraph evidence before candidate admission.
 */
export const ENCLOSING_TIMING_PREREGISTRATION = Object.freeze({
  schemaVersion: 1,
  node: 'PROFILE-01',
  id: 'whole-scene-enclosing-wall-v1',
  registeredAt: '2026-09-18',
  registeredAgainstMain: '2c947007168d4964124db8ce8079bbfabc975687',
  supersedesTimingFamily: 'independent-arm-normalized-difference-v1',
  premiseChange: 'measure direct enclosing semantic-scene wall-time; retain separately resolved raw control for attribution without subtraction',
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
    quantity: 'whole-semantic-scene-wall-ms-per-frozen-repeat',
    representation: 'direct-enclosing-motion-wall-ratio-with-separately-resolved-raw-control',
    primaryArm: 'full semantic scene with Lab Motion owner enabled',
    controlArm: 'same scene setup/application mutations/input schedule with Lab Motion owner absent',
    factorOneEstimate: 'motionWallMs / frozenMotionRepeats',
    rawControlEstimate: 'controlWallMs / frozenControlRepeats',
    subtractionRule: 'forbidden: raw control is never subtracted from the primary observation',
    armOrder: 'counterbalanced from preregistered orderSeed',
    aaRule: 'two independent factor-1 primary enclosing wall observations per run-block',
    positiveControlRule: 'factor-2 executes twice the real semantic scene work in both arms while normalization stays anchored to frozen factor-1 repeat counts',
    factorTwoRatioBand: Object.freeze(PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand.map((bound) => bound * 2)),
  }),
  selector: Object.freeze({
    rule: 'for each arm independently choose the smallest preregistered repeat count whose five fresh direct wall-times all clear timingFloorMs',
    holdoutRule: 'for each chosen arm count, 59 fresh direct wall-times must all clear timingFloorMs before any null/control run-block is acquired',
    holdoutFailureRule: 'abort the pilot; never escalate or retune either arm after holdout data',
    normalizationRule: 'divide each wall-time only by that arm own frozen selected repeat count; do not subtract arms',
    rationale: 'timer resolution is established on contiguous enclosing epochs while the primary estimator remains a directly observed wall-time ratio',
  }),
  attribution: Object.freeze({
    rawControlRole: 'diagnostic structural-cost evidence only; never a correction term',
    requiredBeforeCandidateAdmission: 'browser trace/callgraph/breakdown must independently isolate Lab Motion as the dominant removable owner cost for each required scene',
    failureRule: 'if independent attribution cannot isolate dominant owner-controlled removable cost, candidate admission remains closed even when timing calibration passes',
  }),
  admission: Object.freeze({
    candidateSamples: 0,
    requireAllEngines: true,
    requireAllScenes: true,
    requireIndependentArmFloors: true,
    requireDirectPrimaryObservation: true,
    requireIndependentOwnerAttribution: true,
    nextEvidence: 'real null/control pilot -> independent owner trace attribution -> trusted power/N -> content-addressed admission',
  }),
});
