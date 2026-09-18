import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

/**
 * Premise-changing PROFILE-01 timing design registered after the bounded
 * owned-time aggregation family was falsified. Candidate data is forbidden
 * before this contract is frozen.
 */
export const DIFFERENTIAL_TIMING_PREREGISTRATION = Object.freeze({
  schemaVersion: 1,
  node: 'PROFILE-01',
  id: 'paired-coarse-arm-difference-v1',
  registeredAt: '2026-09-18',
  registeredAgainstMain: '2c947007168d4964124db8ce8079bbfabc975687',
  supersedesTimingFamily: 'bounded-serial-own-work-v1',
  candidateSamplesObservedAtRegistration: false,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  engines: Object.freeze(['chromium', 'firefox', 'webkit']),
  sceneIds: Object.freeze([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  liveBatchCalls: 128,
  armRepeatCandidates: Object.freeze([1, 2, 4, 8, 16, 32]),
  timingFloorMs: 40,
  discoveryProbeCount: 5,
  holdoutProbeCount: 59,
  holdoutCoverage: 0.95,
  holdoutConfidence: 0.95,
  runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  estimator: Object.freeze({
    quantity: 'dominant-removable-main-thread-cost-ms',
    representation: 'paired-difference-of-coarse-contiguous-arm-wall-times',
    motionArm: 'full semantic scene with Lab Motion owner enabled',
    controlArm: 'same scene setup/application mutations/input schedule with Lab Motion owner absent',
    estimate: 'motionArmWallMs - controlArmWallMs',
    armOrder: 'counterbalanced from preregistered orderSeed',
    aaRule: 'two independent factor-1 paired-difference estimates per run-block',
    positiveControlRule: 'factor-2 repeats BOTH motion and control arms, so application work is differenced out rather than added to the signal',
    positivityRule: 'every admitted differential sample must be finite and > 0; otherwise the estimator is unresolved',
  }),
  selector: Object.freeze({
    rule: 'choose the smallest preregistered armRepeatCandidates value whose five fresh discovery probes keep BOTH complete arm wall-times >= timingFloorMs',
    holdoutRule: 'at the chosen repeat count, 59 fresh probes must keep BOTH arms >= timingFloorMs',
    holdoutFailureRule: 'abort the pilot; never escalate or retune repeats after holdout data',
    rationale: 'the 40ms floor applies to directly clocked contiguous arms, not to an artificial sum of sub-resolution owner regions; subtraction then estimates the removable owner cost from two resolved measurements',
  }),
  admission: Object.freeze({
    candidateSamples: 0,
    requireAllEngines: true,
    requireAllScenes: true,
    requireArmFloor: true,
    requirePositiveDifferentials: true,
    nextEvidence: 'null/control pilot -> trusted power/N -> content-addressed admission',
  }),
});
