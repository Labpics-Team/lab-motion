import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 proc-cpu preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor after fresh-paired-process-block-v1.
 * The predecessor exhausted performance.now()-based owner-time pairing on the
 * direct scene. This family changes both clock and attribution envelope: the
 * sample is Linux scheduler-accounted CPU runtime for the exact browser process
 * tree while a complete semantic arm executes. Fresh paired processes remain
 * only as the independent-unit boundary, not as the noise-removal mechanism.
 */
export const PROC_CPU_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'linux-browser-tree-schedstat-cpu-v2',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  preAcquisitionCorrection: frozen({
    priorDesign: 'linux-browser-tree-schedstat-cpu-v1',
    cancelledRun: 35428169833,
    outcome: 'CANCELLED-BEFORE-FORMAL-PILOT',
    reason: 'pre-acquisition accounting review proved that reading only /proc/<pid>/schedstat accounts the thread-group leader rather than the complete multithreaded browser process; v2 sums every /proc/<pid>/task/<tid>/schedstat and freezes task identity as part of the experimental unit',
  }),
  predecessor: frozen({
    family: 'fresh-paired-process-block-v1',
    outcome: 'NO-GO',
    acquisitionRun: 35425198994,
    artifactId: 10578929647,
    rawReceiptSha256: '94f5071af52849de2a0b10b362e154f621498294e69df325ebf7d51f428ae0',
    cleanupRevision: '542d4f5643aeeacd55718ed9eae7f998c587c93d',
    falsifier: 'all direct A/A cells escaped [0.95, 1.05]; Firefox/direct also failed deliberate-2x despite shared-process pairing',
    lowerBound: 'performance.now()-summed direct owner time is not admission-stable under fresh-process or fresh-paired-process nuisance control',
  }),
  premiseChange: frozen({
    from: 'sum of browser performance.now() owner regions, paired across fresh process/JIT units',
    to: 'kernel scheduler-accounted CPU runtime delta summed across every stable task/thread in the browser process tree around each complete semantic arm',
    rationale: 'per-task schedstat accounts actual on-CPU runtime instead of elapsed phase/order jitter and timer-region accumulation; summing every task avoids the pre-acquisition v1 undercount of non-leader browser threads',
    forbiddenReopen: 'no performance.now owner-time fallback, wider A/A band, extra run-blocks, work-count escalation, retry-to-green, or threshold tuning',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  measurement: frozen({
    kind: 'linux-proc-browser-tree-task-schedstat-cpu-ms-v2',
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
    minimumCpuMsPerArm: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    maximumEnclosingWallMsPerPair: 120_000,
    maximumPilotWallMs: 1_800_000,
    platformRule: 'Linux /proc is mandatory; /proc/<pid>/task/<tid>/schedstat field 1 is cumulative task on-CPU runtime nanoseconds and every task value must be readable, non-negative and monotonic',
    processRule: 'each A/A pair and each single/doubled pair gets exactly one Playwright BrowserServer process; both arms execute sequentially in seeded order; server/browser close in finally before any next pair',
    treeRule: 'browser-server root plus every recursive /proc child and every /proc/<pid>/task/<tid> member is snapshotted immediately before and after each formal arm; exact process pid+starttime and task tid+starttime identity sets must remain unchanged or the pilot fails closed',
    warmupRule: 'each arm receives identical fixed semantic warmup before the pre-arm scheduler snapshot; warmup and launch CPU are excluded from formal samples',
    workRule: 'each formal arm executes exactly logicalUnitsByScene × workMultiplier complete semantic units at the frozen live-batch size; no timer-driven stop, discovery, escalation or optional stopping',
    attributionBoundary: 'sample is total scheduler CPU summed over every stable task/thread in the browser process tree during the complete semantic arm; Node runner, launch, setup before warmup, warmup and teardown are excluded; no performance.now owner timing contributes to the sample',
    sampleRule: 'sample = browserTreeCpuMs / logicalUnits; enclosing wall time, per-process scheduler deltas and process identities are diagnostics and integrity evidence only',
    conservativeClaimRule: 'this is a whole-browser CPU envelope for the frozen semantic workload; it may power candidate acquisition only after independent attribution review confirms it is an admissible conservative representation of M-05 dominant removable cost',
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
    positiveControlRule: 'doubled arm executes exactly twice the complete semantic work at identical batch/warmup/process-accounting settings inside the same fresh pair process',
  }),
  calibration: frozen({
    required: true,
    source: 'canonical PROFILE-01 desktop timer calibration remains a source/environment guard; it does not define schedstat sample values',
    rule: 'all engines must PASS the unchanged canonical calibration on the same exact head before formal process-CPU controls run',
  }),
  power: PROFILE_PREREGISTRATION.statistics.powerContract,
  targetPower: PROFILE_PREREGISTRATION.statistics.targetPower,
  minimumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  maximumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.maximumIndependentBlocks,
  attributionReview: 'before candidate admission, independent review must verify /proc process-tree ownership, stable pid+starttime accounting, excluded runner/launch/warmup work, and whether the whole-browser CPU envelope validly represents the registered M-05 cost; unresolved attribution stays UNPROVEN even if controls pass',
  failureRule: 'any semantic failure, process/task identity drift, missing/non-monotonic schedstat, work/warmup drift, arm below the frozen 40ms CPU floor, pair/pilot wall bound, malformed pair, A/A escape, unresolved deliberate-2x, invalid calibration binding or unpowered design closes this family; no same-family retuning or repeat is admissible',
});

export function validateProcCpuPreregistration(design = PROC_CPU_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'linux-browser-tree-schedstat-cpu-v2', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(design.preAcquisitionCorrection.cancelledRun === 35428169833 && design.preAcquisitionCorrection.outcome === 'CANCELLED-BEFORE-FORMAL-PILOT', 'pre-acquisition correction receipt drifted');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds), 'scene roster drifted');
  invariant(design.measurement.kind === 'linux-proc-browser-tree-task-schedstat-cpu-ms-v2', 'measurement representation drifted');
  invariant(design.measurement.independentUnit === 'fresh-process-paired-run-block', 'independent unit drifted');
  invariant(design.measurement.liveBatchCallsByScene['collection-reorder-100'] === 32, 'collection live batch drifted');
  invariant(design.measurement.liveBatchCallsByScene['direct-manipulation-sheet'] === 128, 'direct live batch drifted');
  invariant(design.measurement.logicalUnitsByScene['collection-reorder-100'] === 1, 'collection logical units drifted');
  invariant(design.measurement.logicalUnitsByScene['direct-manipulation-sheet'] === 512, 'direct logical units drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['collection-reorder-100'] === 2, 'collection warmup drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['direct-manipulation-sheet'] === 2, 'direct warmup drifted');
  invariant(design.measurement.minimumCpuMsPerArm === 40, 'CPU timing floor drifted');
  invariant(design.measurement.maximumEnclosingWallMsPerPair === 120_000, 'pair wall bound drifted');
  invariant(design.measurement.maximumPilotWallMs === 1_800_000, 'pilot wall bound drifted');
  invariant(/task<\/tid>\/schedstat field 1/.test(design.measurement.platformRule), 'scheduler clock owner missing');
  invariant(/exact process pid\+starttime and task tid\+starttime identity sets/.test(design.measurement.treeRule), 'process-tree stability rule missing');
  invariant(/no performance\.now owner timing/.test(design.measurement.attributionBoundary), 'exhausted owner clock leaked into sample');
  invariant(/whole-browser CPU envelope/.test(design.measurement.conservativeClaimRule), 'claim-boundary caveat missing');
  invariant(design.controls.runBlocks === 20 && design.controls.bootstrapIterations === 10_000, 'control sample/bootstrap count drifted');
  invariant(JSON.stringify(design.controls.aaBand) === JSON.stringify([0.95, 1.05]), 'A/A band drifted');
  invariant(design.controls.deliberate2xLower95Min === 1.5, 'positive-control threshold drifted');
  invariant(design.power.id === 'm05-paired-log-ratio-holm-v1', 'power contract drifted');
  invariant(design.targetPower === 0.8 && design.minimumIndependentBlocks === 20 && design.maximumIndependentBlocks === 60, 'power bounds drifted');
  invariant(design.predecessor.rawReceiptSha256 === '94f5071af52849de2a0b10b362e154f621498294e69df325ebf7d51f428ae0', 'predecessor evidence drifted');
  invariant(/no same-family retuning or repeat/.test(design.failureRule), 'fail-closed retry law missing');
  return true;
}
