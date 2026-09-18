import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 fixed-work preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor to paired-log-owner-budget-v2.
 *
 * The closed family stopped each observation when accumulated owner time crossed
 * a target. That stopping rule coupled the denominator to timer noise and failed
 * A/A after owner attribution was corrected. This design freezes semantic work
 * before a fresh pilot: every observation executes an exact scene-specific count
 * and timing can only decide PASS/FAIL after the work is complete.
 *
 * The work counts are derived only from immutable null/control evidence from the
 * closed family (artifact 10569319810, raw SHA-256 below), never candidate data:
 * - collection: one logical unit already had >=2257.7 ms owner time;
 * - direct manipulation: the slowest corrected single-work observation needed
 *   1052 adaptive units to reach 250 ms, so 512 fixed units imply ~121.7 ms at
 *   that historical lower-rate bound, >3x the frozen 40 ms calibration floor.
 */
export const FIXED_WORK_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'fixed-work-phase-owner-v1',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  predecessor: frozen({
    family: 'paired-log-owner-budget-v2',
    outcome: 'NO-GO',
    acquisitionRun: 35398927651,
    artifactId: 10569319810,
    artifactSha256: '4b93b1181c3a9db4a8a256fb1e42dc4cfb96cc95b9b7e902d73bac14d327e2da',
    rawReceiptSha256: '2bb3c99fb2e7e63c76f93e11dff04f68d355136b67b7a940b190a3fa5b8eb90d',
    lowerBound: 'owner-time adaptive stopping is not reusable; timing representation must change',
  }),
  premiseChange: frozen({
    from: 'adaptive owner-time target with variable completed logical units',
    to: 'fixed semantic work chosen before fresh pilot; timing is observation-only',
    reopenFact: 'closed corrected null/control receipt provides a conservative fixed-work sizing bound without candidate samples',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen(['collection-reorder-100', 'direct-manipulation-sheet']),
  measurement: frozen({
    kind: 'fixed-semantic-work-owner-phase-sum-v1',
    liveBatchCalls: 128,
    logicalUnitsByScene: frozen({
      'collection-reorder-100': 1,
      'direct-manipulation-sheet': 512,
    }),
    minimumOwnedMs: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    maximumEnclosingWallMs: 60_000,
    normalization: 'sum of library-owned timed phases / frozen logical units',
    workRule: 'execute exactly the preregistered logical-unit count; no timer-driven stop, discovery, escalation, or optional stopping',
    positiveControl: 'same logical-unit denominator; deliberate-2x executes two complete physical scene executions per logical unit',
    ownerBoundary: 'library calls, library-owned callback dispatch, and virtual frame drains are timed; app DOM mutation/setup/render and semantic assertions are excluded',
  }),
  controls: frozen({
    runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
    orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
    bootstrapSeed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
    bootstrapIterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    statisticId: 'paired-run-block-log-ratio-median-v1',
    aaBand: PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand,
    deliberate2xLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    pairIdentity: 'run-block identity is preserved; whole paired blocks are resampled',
  }),
  failureRule: 'any semantic failure, fixed-work count drift, owner-time below the frozen timing floor, wall bound, A/A escape, or unresolved deliberate-2x closes this family; do not raise work count or repeat to green',
  attributionReview: 'independent review of exact source plus content-addressed raw receipt is required before candidate admission',
});

export function validateFixedWorkPreregistration(design = FIXED_WORK_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'fixed-work-phase-owner-v1', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(['collection-reorder-100', 'direct-manipulation-sheet']), 'scene roster drifted');
  invariant(design.measurement.liveBatchCalls === 128, 'live batch drifted');
  invariant(design.measurement.logicalUnitsByScene['collection-reorder-100'] === 1, 'collection work count drifted');
  invariant(design.measurement.logicalUnitsByScene['direct-manipulation-sheet'] === 512, 'direct work count drifted');
  invariant(design.measurement.minimumOwnedMs === 40, 'timing floor drifted');
  invariant(design.measurement.maximumEnclosingWallMs === 60_000, 'wall bound drifted');
  invariant(design.controls.runBlocks === 20, 'run-block count drifted');
  invariant(design.controls.bootstrapIterations === 10_000, 'bootstrap count drifted');
  invariant(design.controls.aaBand[0] === 0.95 && design.controls.aaBand[1] === 1.05, 'A/A band drifted');
  invariant(design.controls.deliberate2xLower95Min === 1.5, 'positive-control threshold drifted');
  invariant(design.predecessor.rawReceiptSha256 === '2bb3c99fb2e7e63c76f93e11dff04f68d355136b67b7a940b190a3fa5b8eb90d', 'negative-evidence identity drifted');
  return true;
}
