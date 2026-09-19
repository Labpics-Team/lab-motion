import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 renderer-thread preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor after linux-browser-cgroup-cpu-v3.
 * Whole-browser cgroup CPU includes browser-root/IPC/rendering work unrelated to
 * the registered dominant removable main-thread cost. This design binds the
 * exact page execution thread before formal acquisition and reads that thread's
 * Linux scheduler CPU ledger. A semantically matched raw-control arm removes
 * application mutation/input-dispatch cost on the same clock.
 */
export const RENDERER_THREAD_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'linux-page-main-thread-schedstat-differential-v1',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  predecessor: frozen({
    family: 'linux-browser-cgroup-cpu-v3',
    outcome: 'NO-GO',
    acquisitionRun: 35429619583,
    artifactId: 10580961162,
    rawReceiptSha256: 'f1f81d31d3e135d4f37e1a61281bc88e46bc104f7cf313e9aae6d0b2cf46ccce',
    cleanupRevision: '1ffdedd444cb974bcb3b3839e749cb5d2e00cbfa',
    falsifier: 'Chromium/direct A/A escaped [0.95, 1.05]; Firefox/direct escaped A/A and failed deliberate-2x under fresh whole-browser cgroup CPU accounting',
    lowerBound: 'whole-browser cgroup CPU is not admission-stable/resolving for the direct M-05 cell under the frozen control contract',
  }),
  premiseChange: frozen({
    from: 'fresh-pair whole-browser cgroup CPU, which includes browser-root, IPC and unrelated process-tree work',
    to: 'fresh-pair exact page-main execution-thread schedstat CPU with a semantically matched raw-control subtraction on that same frozen thread identity',
    rationale: 'M-05 names dominant removable main-thread cost; binding the page execution thread removes whole-browser process noise, while matched control subtraction excludes the application mutation/input-dispatch work that the frozen scene contract explicitly excludes',
    forbiddenReopen: 'no performance.now formal samples, whole-browser CPU fallback, wider A/A band, extra run-blocks, changed work counts after observation, lower positive-control threshold, retry-to-green or candidate sampling before admission',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  measurement: frozen({
    kind: 'linux-page-main-thread-schedstat-differential-v1',
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
    minimumRawThreadCpuMsPerArm: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    minimumDifferentialCpuMsPerSample: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    maximumEnclosingWallMsPerPair: 120_000,
    maximumPilotWallMs: 1_800_000,
    platformRule: 'Linux /proc task schedstat is mandatory; formal samples use field 1 CPU-runtime deltas for one bound page execution TID and never performance.now',
    threadBindingRule: 'after harness install and before formal warmup, run one fixed pure-JS identity sentinel in the page; among non-browser-root descendants select the PID/TID with the largest monotonic schedstat delta; require >=100ms selected delta, >=4x the runner-up delta, pid/tid starttime stability and thread survival through the paired block',
    sentinelRule: 'identity sentinel is a preformal attribution probe only; it performs zero scene/candidate work, is never a metric sample and cannot select work count, threshold, comparator or stopping rule',
    processRule: 'each paired run-block gets one fresh BrowserServer; one bound page thread serves both formal arms; browser closes after the pair and no process/thread identity is reused across run-blocks',
    warmupRule: 'before each formal differential observation, execute equal fixed baseline motion and raw-control warmups on the bound page thread; warmup scheduler deltas are diagnostics and never samples',
    workRule: 'each formal observation executes exactly logicalUnitsByScene × workMultiplier complete motion semantic units and the same count of semantically matched raw-control units at the frozen live-batch size; subarm order is seeded and counterbalanced; no discovery or optional stopping',
    attributionBoundary: 'motionThreadCpuMs and controlThreadCpuMs are scheduler CPU deltas on the same prebound page execution thread; sample = (motionThreadCpuMs - controlThreadCpuMs) / logicalUnits; browser root, other content threads, GPU/IPC and enclosing wall-time never enter the sample',
    controlSemantics: 'collection raw control performs the identical authored DOM reorder/replace/restore mutations without capture/animate/frame work; direct raw control performs the identical authored transform target sequence without createDrag/solver/frame work',
    positivityRule: 'each emitted differential sample must be finite and >= minimumDifferentialCpuMsPerSample; otherwise the representation is unresolved/falsified, never clamped or discarded',
  }),
  controls: frozen({
    runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
    orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
    bootstrapSeed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
    bootstrapIterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    statisticId: 'paired-run-block-log-ratio-median-v1',
    aaOrder: 'seeded AB/BA across independent fresh-process run-blocks',
    deliberateOrder: 'seeded SD/DS across independent fresh-process run-blocks',
    subarmOrder: 'seeded motion/control vs control/motion inside every differential observation',
    aaBand: frozen([...PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand]),
    deliberate2xLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    positiveControlRule: 'doubled observation executes exactly twice BOTH motion and matched raw-control semantic units at identical batch/thread/process settings; the removable scheduler-CPU differential must therefore resolve the 2x control',
  }),
  calibration: frozen({
    required: true,
    source: 'canonical PROFILE-01 desktop timer calibration remains a source/environment guard; it does not define schedstat sample values',
    rule: 'all engines must PASS the unchanged canonical calibration on the same exact head before formal renderer-thread controls run',
  }),
  power: PROFILE_PREREGISTRATION.statistics.powerContract,
  targetPower: PROFILE_PREREGISTRATION.statistics.targetPower,
  minimumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  maximumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.maximumIndependentBlocks,
  attributionReview: 'before candidate admission, independent review must verify page-thread binding/dominance, stable pid+tid identity, schedstat ownership, matched-control semantics and that subtraction isolates the frozen M-05 dominant removable main-thread cost rather than hiding protected browser/application work',
  failureRule: 'any semantic failure, unavailable schedstat, ambiguous sentinel, thread identity drift/death, non-monotonic scheduler CPU, raw arm below frozen 40ms, differential below frozen 40ms, pair/pilot wall bound, malformed pair, A/A escape, unresolved deliberate-2x, invalid calibration binding or unpowered design closes or blocks this family according to whether the failure falsifies the representation or only the carrier; no same-family retuning or repeat after a valid formal receipt',
});

export function validateRendererThreadPreregistration(design = RENDERER_THREAD_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'linux-page-main-thread-schedstat-differential-v1', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(design.predecessor.rawReceiptSha256 === 'f1f81d31d3e135d4f37e1a61281bc88e46bc104f7cf313e9aae6d0b2cf46ccce', 'predecessor evidence drifted');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds), 'scene roster drifted');
  invariant(design.measurement.kind === 'linux-page-main-thread-schedstat-differential-v1', 'measurement representation drifted');
  invariant(design.measurement.independentUnit === 'fresh-process-paired-run-block', 'independent unit drifted');
  invariant(design.measurement.liveBatchCallsByScene['collection-reorder-100'] === 32, 'collection live batch drifted');
  invariant(design.measurement.liveBatchCallsByScene['direct-manipulation-sheet'] === 128, 'direct live batch drifted');
  invariant(design.measurement.logicalUnitsByScene['collection-reorder-100'] === 1, 'collection logical units drifted');
  invariant(design.measurement.logicalUnitsByScene['direct-manipulation-sheet'] === 512, 'direct logical units drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['collection-reorder-100'] === 2, 'collection warmup drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['direct-manipulation-sheet'] === 2, 'direct warmup drifted');
  invariant(design.measurement.minimumRawThreadCpuMsPerArm === 40 && design.measurement.minimumDifferentialCpuMsPerSample === 40, 'timing floor drifted');
  invariant(design.measurement.maximumEnclosingWallMsPerPair === 120_000 && design.measurement.maximumPilotWallMs === 1_800_000, 'wall bound drifted');
  invariant(/schedstat/.test(design.measurement.platformRule) && /field 1/.test(design.measurement.platformRule), 'scheduler clock owner missing');
  invariant(/non-browser-root descendants/.test(design.measurement.threadBindingRule) && />=4x/.test(design.measurement.threadBindingRule), 'thread identity/dominance rule missing');
  invariant(/preformal attribution probe/.test(design.measurement.sentinelRule) && /zero scene\/candidate work/.test(design.measurement.sentinelRule), 'sentinel leaked into formal experiment');
  invariant(/same prebound page execution thread/.test(design.measurement.attributionBoundary), 'matched scheduler CPU owner missing');
  invariant(/never enter the sample/.test(design.measurement.attributionBoundary), 'whole-browser/wall leakage not excluded');
  invariant(design.controls.runBlocks === 20 && design.controls.bootstrapIterations === 10_000, 'control sample/bootstrap count drifted');
  invariant(JSON.stringify(design.controls.aaBand) === JSON.stringify([0.95, 1.05]), 'A/A band drifted');
  invariant(design.controls.deliberate2xLower95Min === 1.5, 'positive-control threshold drifted');
  invariant(design.power.id === 'm05-paired-log-ratio-holm-v1', 'power contract drifted');
  invariant(design.targetPower === 0.8 && design.minimumIndependentBlocks === 20 && design.maximumIndependentBlocks === 60, 'power bounds drifted');
  invariant(/no same-family retuning or repeat/.test(design.failureRule), 'fail-closed retry law missing');
  return true;
}
