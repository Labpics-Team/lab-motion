import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 process-reset preregistration: ${message}`);
}

const frozen = (value) => Object.freeze(value);

/**
 * Premise-changing successor after precalibration-standardized-owner-ms-v3.
 *
 * Static attribution review of the predecessor found that all formal packets
 * reused one stateful page/browser. A later A/A arm was therefore downstream of
 * earlier product work and could inherit JIT/GC/browser-state carryover. This
 * family moves the formal observation boundary to a fresh browser process per
 * arm. Each process receives the same fixed semantic warmup before one formal
 * packet, then is closed. No result may tune work counts, warmup, bands or N.
 */
export const PROCESS_RESET_PREREGISTRATION = frozen({
  schemaVersion: 1,
  id: 'fresh-process-owner-ms-v1',
  node: 'PROFILE-01',
  registeredAt: '2026-09-19',
  registeredMainRevision: '2c947007168d4964124db8ce8079bbfabc975687',
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  candidateSamples: 0,
  predecessor: frozen({
    family: 'precalibration-standardized-owner-ms-v3',
    outcome: 'NO-GO',
    acquisitionRun: 35420475309,
    artifactId: 10577102726,
    rawReceiptSha256: 'bc27574a45d2193cc0a8e2afd51183e0b97fc324e26b07c11b2d5ab393b2334d',
    cleanupRevision: 'baec7190311943b4adf0a2975c79dfaa6c23b7bc',
    falsifier: 'desktop-chromium/direct-manipulation-sheet A/A escaped [0.95, 1.05]',
    independentReview: 'formal packets reused one stateful page/browser, so later pre-treatment references and owner packets could inherit product-induced JIT/GC/browser-state carryover',
  }),
  premiseChange: frozen({
    from: 'multiple formal packets acquired sequentially inside one long-lived browser/page state',
    to: 'one fresh browser process per formal arm, fixed scene warmup in that process, exactly one measured packet, then unconditional process close',
    rationale: 'process reset removes cross-arm product-state carryover instead of trying to model or normalize it after the fact',
    forbiddenReopen: 'no extra blocks, wider A/A band, timer-floor reduction, retry-to-green, or reusing a browser/page across formal arms',
  }),
  engines: frozen(['chromium', 'firefox', 'webkit']),
  sceneIds: frozen([...PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds]),
  measurement: frozen({
    kind: 'fresh-browser-process-fixed-owner-ms-v1',
    independentUnit: PROFILE_PREREGISTRATION.statistics.independentUnit,
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
    minimumOwnerMsPerPacket: PROFILE_PREREGISTRATION.calibration.timingFloorMs,
    maximumEnclosingWallMsPerPacket: 60_000,
    maximumPilotWallMs: 1_800_000,
    processRule: 'every formal arm calls browserType.launch exactly once, creates one context/page, performs only the frozen warmup plus one formal packet, and closes the browser in finally before another arm starts',
    warmupRule: 'warmup executes the same baseline scene and live-batch size for the frozen warmupLogicalUnitsByScene count; warmup timings are never samples and warmup performs no candidate work',
    workRule: 'formal packet executes exactly logicalUnitsByScene × workMultiplier complete semantic units at the frozen live-batch size; no timer-driven stop, discovery, escalation or optional stopping',
    ownerBoundary: 'only Lab Motion-owned calls, library-owned callback dispatch and virtual-frame drains contribute to ownerMs; app DOM mutation/setup/render and semantic assertions remain outside ownerMs',
    sampleRule: 'sample = ownerMs / logicalUnits; launch/setup/warmup/teardown are retained as wall diagnostics but never subtracted from or added to ownerMs',
  }),
  controls: frozen({
    runBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
    orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
    bootstrapSeed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
    bootstrapIterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    statisticId: 'paired-run-block-log-ratio-median-v1',
    aaOrder: 'seeded AB/BA; every A and B arm is a distinct fresh browser process',
    deliberateOrder: 'seeded SD/DS; every single and doubled arm is a distinct fresh browser process',
    aaBand: frozen([...PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand]),
    deliberate2xLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    positiveControlRule: 'doubled arm executes exactly twice the formal semantic work at identical batch/warmup settings; process launch/setup/warmup remain one-per-arm and outside ownerMs',
    processReuseFalsifier: 'receipt validation rejects any repeated isolation token across formal arms; code review must additionally verify launch/close ownership because a token alone is not OS-process proof',
  }),
  calibration: frozen({
    required: true,
    source: 'canonical PROFILE-01 desktop calibration receipt acquired on the same exact head before the process-reset pilot',
    rule: 'all engines must PASS the unchanged 40ms A/A + deliberate-2x calibration before formal product controls run',
  }),
  power: PROFILE_PREREGISTRATION.statistics.powerContract,
  targetPower: PROFILE_PREREGISTRATION.statistics.targetPower,
  minimumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
  maximumIndependentBlocks: PROFILE_PREREGISTRATION.statistics.maximumIndependentBlocks,
  attributionReview: 'before candidate admission, independent review must verify the exact owner boundary and prove that each formal arm owns a fresh launch→warmup→measure→close lifecycle with no cross-arm product state',
  failureRule: 'any semantic failure, process-token reuse, work/warmup drift, packet below the frozen 40ms owner floor, packet/whole-pilot wall bound, malformed pair, A/A escape, unresolved deliberate-2x, invalid calibration binding or unpowered design at max N closes this family; no same-family retuning or repeat is admissible',
});

export function validateProcessResetPreregistration(design = PROCESS_RESET_PREREGISTRATION) {
  invariant(design.schemaVersion === 1 && design.id === 'fresh-process-owner-ms-v1', 'identity drifted');
  invariant(design.node === 'PROFILE-01', 'node drifted');
  invariant(design.registeredMainRevision === '2c947007168d4964124db8ce8079bbfabc975687', 'registered main drifted');
  invariant(design.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(design.candidateSamples === 0, 'candidate samples observed before registration');
  invariant(JSON.stringify(design.engines) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'engine roster drifted');
  invariant(JSON.stringify(design.sceneIds) === JSON.stringify(PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds), 'scene roster drifted');
  invariant(design.measurement.independentUnit === 'run-block', 'independent unit drifted');
  invariant(design.measurement.liveBatchCallsByScene['collection-reorder-100'] === 32, 'collection live batch drifted');
  invariant(design.measurement.liveBatchCallsByScene['direct-manipulation-sheet'] === 128, 'direct live batch drifted');
  invariant(design.measurement.logicalUnitsByScene['collection-reorder-100'] === 1, 'collection logical units drifted');
  invariant(design.measurement.logicalUnitsByScene['direct-manipulation-sheet'] === 512, 'direct logical units drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['collection-reorder-100'] === 2, 'collection warmup drifted');
  invariant(design.measurement.warmupLogicalUnitsByScene['direct-manipulation-sheet'] === 2, 'direct warmup drifted');
  invariant(design.measurement.minimumOwnerMsPerPacket === 40, 'owner timing floor drifted');
  invariant(design.measurement.maximumEnclosingWallMsPerPacket === 60_000, 'packet wall bound drifted');
  invariant(design.measurement.maximumPilotWallMs === 1_800_000, 'pilot wall bound drifted');
  invariant(/browserType\.launch exactly once/.test(design.measurement.processRule), 'fresh-process lifecycle is not frozen');
  invariant(/closes the browser in finally/.test(design.measurement.processRule), 'unconditional process close is not frozen');
  invariant(/no timer-driven stop/.test(design.measurement.workRule), 'timer-driven work selection reintroduced');
  invariant(/never subtracted from or added to ownerMs/.test(design.measurement.sampleRule), 'wall/setup cost leaked into owner sample');
  invariant(design.controls.runBlocks === 20 && design.controls.bootstrapIterations === 10_000, 'control sample/bootstrap count drifted');
  invariant(JSON.stringify(design.controls.aaBand) === JSON.stringify([0.95, 1.05]), 'A/A band drifted');
  invariant(design.controls.deliberate2xLower95Min === 1.5, 'positive-control threshold drifted');
  invariant(/repeated isolation token/.test(design.controls.processReuseFalsifier), 'process-reuse falsifier missing');
  invariant(design.power.id === 'm05-paired-log-ratio-holm-v1', 'power contract drifted');
  invariant(design.targetPower === 0.8 && design.minimumIndependentBlocks === 20 && design.maximumIndependentBlocks === 60, 'power bounds drifted');
  invariant(design.predecessor.rawReceiptSha256 === 'bc27574a45d2193cc0a8e2afd51183e0b97fc324e26b07c11b2d5ab393b2334d', 'predecessor evidence drifted');
  invariant(/no same-family retuning or repeat/.test(design.failureRule), 'fail-closed retry law missing');
  return true;
}
