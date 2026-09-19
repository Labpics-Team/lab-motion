import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 proc-cpu preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor after fresh-paired-process-block-v1.
 * The predecessor exhausted performance.now()-based owner-time pairing on the
 * direct scene. Pre-acquisition inspection then falsified two /proc endpoint
 * accounting variants. This family changes the attribution owner to a fresh
 * cgroup-v2 CPU ledger whose inherited membership survives transient tasks.
 */
export const PROC_CPU_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'linux-browser-cgroup-cpu-v3',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  preAcquisitionCorrections: frozen([
    frozen({ priorDesign: 'linux-browser-tree-schedstat-cpu-v1', cancelledRun: 35428169833, outcome: 'CANCELLED-BEFORE-FORMAL-PILOT', reason: 'process-leader schedstat undercounts multithreaded browser CPU' }),
    frozen({ priorDesign: 'linux-browser-tree-schedstat-cpu-v2', inspectedHead: 'b10001775bc85fff4791412ec8fa072e19142c24', outcome: 'CANCELLED-BEFORE-FORMAL-PILOT', reason: 'endpoint task snapshots miss tasks born and exited entirely inside an arm; implementation inspection also found process-leader schedstat still in use' }),
  ]),
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
    from: 'endpoint /proc task snapshots around each arm, which cannot observe transient task lifetimes',
    to: 'delta of cpu.stat usage_usec in one fresh dedicated cgroup-v2 containing the complete browser process tree for the entire paired run-block',
    rationale: 'cgroup accounting follows inherited membership and accumulates CPU for members that exit during the arm, removing the endpoint-snapshot hole without returning to performance.now owner timing',
    forbiddenReopen: 'no performance.now owner-time fallback, wider A/A band, extra run-blocks, work-count escalation, retry-to-green, or threshold tuning',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  measurement: frozen({
    kind: 'linux-cgroup-v2-browser-cpu-usage-us-v3',
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
    platformRule: 'Linux cgroup v2 is mandatory; a fresh dedicated cgroup must expose cpu.stat usage_usec and be writable through non-interactive sudo on the ephemeral acquisition runner',
    processRule: 'each pair gets one BrowserServer and one unique cgroup; the complete existing browser tree is moved into it before warmup, descendants inherit membership, both arms execute sequentially, and browser/server close before cgroup removal',
    treeRule: 'before warmup, recursive descendants discovered through every task children file must all resolve inside the unique pair cgroup; formal CPU accounting comes only from monotonic cgroup cpu.stat usage_usec deltas, so task/process birth and exit during an arm remain accounted',
    warmupRule: 'each arm receives identical fixed semantic warmup before the pre-arm cgroup cpu.stat snapshot; warmup and launch CPU are excluded from formal samples',
    workRule: 'each formal arm executes exactly logicalUnitsByScene × workMultiplier complete semantic units at the frozen live-batch size; no timer-driven stop, discovery, escalation or optional stopping',
    attributionBoundary: 'sample is the dedicated browser cgroup CPU-usage delta during the complete semantic arm; Node runner stays outside the cgroup and launch/setup-before-warmup, warmup and teardown are excluded by before/after cpu.stat snapshots; no performance.now owner timing contributes to the sample',
    sampleRule: 'sample = browserCgroupCpuMs / logicalUnits; enclosing wall time and cgroup membership snapshots are diagnostics/integrity evidence only',
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
  attributionReview: 'before candidate admission, independent review must verify dedicated-cgroup ownership/inheritance, runner exclusion, complete pre-warmup tree migration, excluded launch/setup/warmup work, and whether the whole-browser CPU envelope validly represents the registered M-05 cost; unresolved attribution stays UNPROVEN even if controls pass',
  failureRule: 'any semantic failure, unavailable/non-writable cgroup-v2 accounting, incomplete pre-warmup tree migration, non-monotonic cpu.stat, runner leakage into the browser cgroup, work/warmup drift, arm below the frozen 40ms CPU floor, pair/pilot wall bound, malformed pair, A/A escape, unresolved deliberate-2x, invalid calibration binding or unpowered design closes or blocks this family according to whether the failure falsifies the representation or only the carrier; no same-family retuning or repeat is admissible',
});

export function validateProcCpuPreregistration(design = PROC_CPU_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'linux-browser-cgroup-cpu-v3', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(design.preAcquisitionCorrections.length === 2 && design.preAcquisitionCorrections.every((entry) => entry.outcome === 'CANCELLED-BEFORE-FORMAL-PILOT'), 'pre-acquisition correction receipts drifted');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds), 'scene roster drifted');
  invariant(design.measurement.kind === 'linux-cgroup-v2-browser-cpu-usage-us-v3', 'measurement representation drifted');
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
  invariant(/cgroup v2/.test(design.measurement.platformRule) && /cpu\.stat usage_usec/.test(design.measurement.platformRule), 'cgroup CPU owner missing');
  invariant(/every task children file/.test(design.measurement.treeRule) && /birth and exit/.test(design.measurement.treeRule), 'dynamic-tree accounting rule missing');
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
