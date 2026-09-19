import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 fresh-paired-block preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor after fresh-process-owner-ms-v1.
 *
 * The predecessor proved that process isolation removes cross-arm state carryover,
 * but per-arm fresh processes still leave direct-manipulation A/A too variable.
 * This family changes the independent observation: a run-block is one fresh
 * browser process containing exactly one counterbalanced pair. The two arms share
 * process/JIT state; the process is then destroyed before the next run-block.
 */
export const FRESH_PAIRED_BLOCK_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'fresh-paired-process-block-v1',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  predecessor: frozen({
    family: 'fresh-process-owner-ms-v1',
    outcome: 'NO-GO',
    acquisitionRun: 35422637261,
    artifactId: 10578565631,
    rawReceiptSha256: '7792f0077565e01d57b43e9d7d72ac3bf084d33c4cae7f9b8f763201ee9d7d7b',
    cleanupRevision: 'bfc7d798c57ab6e0511115103a5771641a36b38e',
    falsifier: 'Firefox/direct and WebKit/direct A/A escaped [0.95, 1.05] despite fresh process per arm',
    lowerBound: 'fresh-process isolation removes cross-arm carryover but does not make direct owner-time stable when each paired arm pays independent process-state nuisance',
  }),
  premiseChange: frozen({
    from: 'one independently launched browser process per formal arm',
    to: 'one fresh browser process per paired run-block; both formal arms execute in seeded counterbalanced order inside that process, then the process closes before the next pair',
    rationale: 'paired arms share process/JIT nuisance while process destruction between pairs preserves run-block independence; this targets the predecessor residual between-process variance',
    forbiddenReopen: 'no wider A/A band, extra run-blocks, lower timing floor, larger work count, retry-to-green, or long-lived process across run-blocks',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  measurement: frozen({
    kind: 'fresh-process-paired-run-block-owner-ms-v1',
    independentUnit: 'fresh-process-paired-run-block',
    liveBatchCallsByScene: frozen({
      'collection-reorder-100': 32,
      'direct-manipulation-sheet': 128,
    }),
    logicalUnitsByScene: frozen({
      'collection-reorder-100': 1,
      'direct-manipulation-sheet': 512,
    }),
    warmupLogicalUnitsByScene: frozen({
      'collection-reorder-100': 2,
      'direct-manipulation-sheet': 2,
    }),
    minimumOwnerMsPerArm: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    maximumEnclosingWallMsPerPair: 120_000,
    maximumPilotWallMs: 1_800_000,
    processRule: 'each A/A pair and each single/doubled pair gets exactly one fresh browser launch; both arms execute sequentially in the preregistered seeded order; the browser closes in finally before any next pair',
    warmupRule: 'each arm receives the same fixed baseline semantic warmup immediately before its formal measurement; warmup timings are diagnostics and never samples',
    workRule: 'each formal arm executes exactly logicalUnitsByScene × workMultiplier complete semantic units at the frozen live-batch size; no timer-driven stop, discovery, escalation or optional stopping',
    ownerBoundary: 'only Lab Motion-owned calls, library-owned callback dispatch and virtual-frame drains contribute to ownerMs; app DOM mutation/setup/render and semantic assertions remain outside ownerMs',
    sampleRule: 'sample = ownerMs / logicalUnits; launch/setup/warmup/teardown and pair wall time are diagnostics but are never subtracted from or added to ownerMs',
    pairIsolationRule: 'both arms in one formal pair must share exactly one isolation token; no isolation token may appear in any other formal pair',
  }),
  controls: frozen({
    runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
    orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
    bootstrapSeed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
    bootstrapIterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    statisticId: 'paired-run-block-log-ratio-median-v1',
    aaOrder: 'seeded AB/BA across independent fresh-process run-blocks',
    deliberateOrder: 'seeded SD/DS across independent fresh-process run-blocks',
    aaBand: frozen([...PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand]),
    deliberate2xLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    positiveControlRule: 'doubled arm executes exactly twice the formal semantic work at identical batch and per-arm warmup settings inside the same fresh pair process',
  }),
  calibration: frozen({
    required: true,
    source: 'canonical PROFILE-01 desktop calibration receipt acquired on the same exact head before this pilot',
    rule: 'all engines must PASS the unchanged 40ms A/A + deliberate-2x calibration before formal product controls run',
  }),
  power: PROFILE_PREREGISTRATION.statistics.powerContract,
  targetPower: PROFILE_PREREGISTRATION.statistics.targetPower,
  minimumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  maximumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.maximumIndependentBlocks,
  attributionReview: 'before candidate admission, independent review must verify exact owner boundaries and the one-fresh-process-per-pair lifecycle, including that consumer rendering remains outside ownerMs',
  failureRule: 'any semantic failure, pair-token mismatch/reuse, work/warmup drift, arm below the frozen 40ms owner floor, pair/pilot wall bound, malformed pair, A/A escape, unresolved deliberate-2x, invalid calibration binding or unpowered design at max N closes this family; no same-family retuning or repeat is admissible',
});

export function validateFreshPairedBlockPreregistration(design = FRESH_PAIRED_BLOCK_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'fresh-paired-process-block-v1', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds), 'scene roster drifted');
  invariant(design.measurement.independentUnit === 'fresh-process-paired-run-block', 'independent unit drifted');
  invariant(design.measurement.liveBatchCallsByScene['collection-reorder-100'] === 32, 'collection live batch drifted');
  invariant(design.measurement.liveBatchCallsByScene['direct-manipulation-sheet'] === 128, 'direct live batch drifted');
  invariant(design.measurement.logicalUnitsByScene['collection-reorder-100'] === 1, 'collection logical units drifted');
  invariant(design.measurement.logicalUnitsByScene['direct-manipulation-sheet'] === 512, 'direct logical units drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['collection-reorder-100'] === 2, 'collection warmup drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['direct-manipulation-sheet'] === 2, 'direct warmup drifted');
  invariant(design.measurement.minimumOwnerMsPerArm === 40, 'owner timing floor drifted');
  invariant(design.measurement.maximumEnclosingWallMsPerPair === 120_000, 'pair wall bound drifted');
  invariant(design.measurement.maximumPilotWallMs === 1_800_000, 'pilot wall bound drifted');
  invariant(/one fresh browser launch/.test(design.measurement.processRule), 'fresh pair process lifecycle is not frozen');
  invariant(/browser closes in finally/.test(design.measurement.processRule), 'unconditional process close is not frozen');
  invariant(/no timer-driven stop/.test(design.measurement.workRule), 'timer-driven work selection reintroduced');
  invariant(/both arms in one formal pair must share exactly one isolation token/.test(design.measurement.pairIsolationRule), 'pair isolation owner missing');
  invariant(design.controls.runBlocks === 20 && design.controls.bootstrapIterations === 10_000, 'control sample/bootstrap count drifted');
  invariant(JSON.stringify(design.controls.aaBand) === JSON.stringify([0.95, 1.05]), 'A/A band drifted');
  invariant(design.controls.deliberate2xLower95Min === 1.5, 'positive-control threshold drifted');
  invariant(design.power.id === 'm05-paired-log-ratio-holm-v1', 'power contract drifted');
  invariant(design.targetPower === 0.8 && design.minimumIndependentBlocks === 20 && design.maximumIndependentBlocks === 60, 'power bounds drifted');
  invariant(design.predecessor.rawReceiptSha256 === '7792f0077565e01d57b43e9d7d72ac3bf084d33c4cae7f9b8f763201ee9d7d7b', 'predecessor evidence drifted');
  invariant(/no same-family retuning or repeat/.test(design.failureRule), 'fail-closed retry law missing');
  return true;
}
