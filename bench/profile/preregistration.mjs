const unavailable = (id, platform, refreshHz, affectedMetrics) => Object.freeze({
  id,
  class: 'physical-mobile',
  platform,
  refreshHz,
  availability: 'unavailable',
  binding: null,
  candidateEligible: false,
  affectedMetrics: Object.freeze(affectedMetrics),
  reason: 'no representative physical device is registered in the current inventory',
});

const desktop = (id, engine) => Object.freeze({
  id,
  class: 'desktop-browser',
  platform: 'linux-ci-runner',
  engine,
  refreshHz: 60,
  availability: 'bind-from-inventory-receipt',
  binding: null,
  candidateEligible: false,
  affectedMetrics: Object.freeze([]),
});

/**
 * PROFILE-01 preregistration. This file freezes the experiment before any
 * candidate A/B sample exists. Runtime inventory receipts may bind exact
 * browser/device versions, but they may not change scenes, controls, metrics,
 * sampling units, stopping rules or decision thresholds.
 */
export const PROFILE_PREREGISTRATION = Object.freeze({
  schemaVersion: 1,
  profileId: 'r11-profile-20260915-v1',
  node: 'PROFILE-01',
  registeredAt: '2026-09-15',
  candidateSamplesObservedAtRegistration: false,
  candidateAcquisitionGate: 'bound cell + powered design + PASS calibration receipt',

  baseline: Object.freeze({
    repository: 'Labpics-Team/lab-motion',
    revision: 'fe11daa407de396fad952be7679650f63dabd4dd',
    package: '@labpics/motion',
    packageVersion: '0.3.0',
    packageManager: 'pnpm@11.11.0',
    nodeRange: '>=22',
    compareManifestBlob: '51cc81e9d6e2499eff7bf628e99297f272ca0180',
    compareLockBlob: 'e0db76350590da520f883998fe3aee9eb3b3c553',
    methodologyBlob: '37b4072fb158426cab9fa4aed0466e96c2769cba',
    benchmarkRunnerBlob: 'ce87c13b9934abaf6f05753b069742bd1a54db8c',
    competitors: Object.freeze({
      motion: '12.42.2',
      gsap: '3.15.0',
      animejs: '4.5.0',
      playwright: '1.61.1',
      esbuild: '0.28.1',
      pngjs: '7.0.0',
    }),
  }),

  oldCostVector: Object.freeze({
    kind: 'hard-ceilings-not-current-measurements',
    source: 'scripts/size-gate.mjs@fe11daa407de396fad952be7679650f63dabd4dd',
    gzipBytes: Object.freeze({
      nano: 1024,
      compilerRuntime: 341,
      compilerSurface: 1024,
      fullAnimateConsumer: 15600,
      animateCompositorMixed: 17500,
    }),
    rule: 'candidate may not buy a profile win by raising or bypassing an old ceiling',
  }),

  scenes: Object.freeze([
    Object.freeze({
      id: 'collection-reorder-100',
      family: 'collection',
      purpose: 'heavy-scene-A',
      population: 100,
      viewport: Object.freeze({ width: 390, height: 844 }),
      dpr: 2,
      scheduleMs: Object.freeze([0, 250, 500, 750, 1000]),
      operations: Object.freeze([
        'initial stable-id 100-card grid',
        'reverse visible order',
        'remove every fifth item and insert equal stable-id replacements',
        'mid-flight reorder before prior transition settles',
        'restore canonical order',
      ]),
      requiredOutcomes: Object.freeze([
        'stable identity',
        'no teleport at retarget',
        'terminal geometry equals authored final DOM',
      ]),
      dominantRemovableCost: 'main-thread motion work excluding application mutation cost',
    }),
    Object.freeze({
      id: 'direct-manipulation-sheet',
      family: 'direct-manipulation',
      purpose: 'heavy-scene-B',
      viewport: Object.freeze({ width: 390, height: 844 }),
      dpr: 2,
      scheduleMs: Object.freeze([0, 160, 320, 480, 700, 1000]),
      operations: Object.freeze([
        'pointer-down on sheet handle',
        'three deterministic drag samples',
        'release with fixed velocity',
        'interrupt inertial continuation with a second target',
        'settle at authored terminal snap point',
      ]),
      requiredOutcomes: Object.freeze([
        'pickup continuity',
        'release continuity',
        'interrupt continuity',
        'terminal snap correctness',
      ]),
      dominantRemovableCost: 'main-thread motion work excluding synthetic input dispatch',
    }),
  ]),

  controls: Object.freeze([
    'absence-empty-raf',
    'native-waapi-equivalent-transform',
    'equal-linear-tween',
    'identical-serialized-plan-executor',
    'lab-motion-no-compiler',
    'aa-null',
    'deliberate-2x-work',
  ]),

  roster: Object.freeze([
    desktop('desktop-chromium', 'chromium'),
    desktop('desktop-firefox', 'firefox'),
    desktop('desktop-webkit', 'webkit'),
    unavailable('android-60', 'android', 60, ['M-04', 'M-05']),
    unavailable('android-120', 'android', 120, ['M-04', 'M-05']),
    unavailable('ios-60', 'ios', 60, ['M-04', 'M-05']),
    unavailable('ios-120', 'ios', 120, ['M-04', 'M-05']),
  ]),

  environmentPolicy: Object.freeze({
    physicalMobile: Object.freeze({
      power: 'AC or fixed battery band recorded before every block',
      thermal: 'thermal state recorded before every block; throttle transition invalidates block',
      display: 'fixed brightness, refresh mode and resolution; adaptive refresh disabled where platform permits',
      background: 'no user applications; background-service state recorded',
      network: 'offline after artifact acquisition unless scenario explicitly requires network',
    }),
    desktop: Object.freeze({
      cpuThrottle: 'diagnostic-only, never substitutes for M-04/M-05 mobile evidence',
      viewport: 'scene-defined',
      dpr: 'scene-defined',
      background: 'runner identity is recorded in receipt; exclusivity is not assumed without explicit receipt evidence',
    }),
  }),

  statistics: Object.freeze({
    independentUnit: 'run-block',
    neverTreatAsIndependent: Object.freeze(['frame', 'channel', 'target', 'animation']),
    confidenceLevel: 0.95,
    familyAlpha: 0.05,
    multiplicity: 'Holm',
    bootstrapIterations: 10000,
    bootstrapKind: 'paired-cluster',
    practicalRelativeThreshold: 0.05,
    targetPower: 0.8,
    orderSeed: 0x51f15e,
    bootstrapSeed: 0x50f11e,
    minimumIndependentBlocks: 20,
    maximumIndependentBlocks: 60,
    sampleCountRule: 'choose once from null/control pilot before candidate data; smallest complete balanced block count with estimated power >= 0.80, else cell is unpowered',
    stoppingRule: 'fixed chosen N; no optional stopping and no repeat-to-green',
    summaries: Object.freeze(['p50', 'p95', 'p99-when-N>=100', 'missed-frame-fraction']),
    m04: Object.freeze({
      scalarChannels: 100,
      ownCpuP99MsPerFrameMax: 0.5,
      fullScenario120HzMissedFrameUpper95Max: 0.001,
      note: '120 Hz claim is affected/unproven until a registered physical 120 Hz device and calibrated rare-event receipt exist',
    }),
    m05: Object.freeze({
      requiredSceneIds: Object.freeze(['collection-reorder-100', 'direct-manipulation-sheet']),
      candidateToBestComparatorUpper95Max: 0.5,
      zeroCostControlRule: 'use boundary plus another meaningful metric; never divide by zero',
    }),
    powerContract: Object.freeze({
      id: 'm05-paired-log-ratio-holm-v1',
      claim: 'M-05',
      familySceneIds: Object.freeze(['collection-reorder-100', 'direct-manipulation-sheet']),
      metricByScene: Object.freeze({
        'collection-reorder-100': 'dominant-removable-main-thread-cost-ms',
        'direct-manipulation-sheet': 'dominant-removable-main-thread-cost-ms',
      }),
      comparatorByScene: Object.freeze({
        'collection-reorder-100': 'best-ratio-eligible-preregistered-comparator',
        'direct-manipulation-sheet': 'best-ratio-eligible-preregistered-comparator',
      }),
      ratioEligibleComparators: Object.freeze(['motion', 'gsap', 'animejs', 'lab-motion-baseline']),
      boundaryOnlyComparators: Object.freeze(['waapi-control']),
      comparatorSelectionRule: 'select the lowest-cost semantically valid ratio-eligible comparator from comparator-only baseline data before candidate samples',
      noiseModel: 'paired run-block A/A log-ratio from the same scenario harness',
      effectScale: 'log-ratio',
      testRule: 'two-sided conservative superiority planning at Holm first-step alpha',
      familyAlpha: 0.05,
      holmFirstStepAlpha: 0.025,
      perTailAlpha: 0.0125,
      criticalZ: 2.241402727604947,
      aggregationRule: 'minimum-member-power',
      practicalRelativeThreshold: 0.05,
      targetPower: 0.8,
      degenerateNoiseRule: 'reject',
    }),
  }),

  calibration: Object.freeze({
    requiredBeforeCandidate: true,
    timingFloorMs: 40,
    aaNonInferiorityBand: Object.freeze([0.95, 1.05]),
    deliberateWorkMultiplier: 2,
    deliberateWorkDetectedLower95Min: 1.5,
    sameExperimentRetryPolicy: 'forbidden-after-invalid; change harness/root cause and register a new calibration identity',
  }),

  scenarioSelector: Object.freeze({
    kind: 'two-stage-floor-transfer-v1',
    formalFloorMs: 20,
    selectionFloorMs: 40,
    maximumBatchCalls: 512,
    discoveryProbeCount: 5,
    holdoutProbeCount: 59,
    holdoutCoverage: 0.95,
    holdoutConfidence: 0.95,
    selectionRule: 'smallest power-of-two batch whose discovery probes all clear selectionFloorMs; then a fresh holdout at the same batch must also clear selectionFloorMs',
    holdoutFailureRule: 'abort pilot; do not escalate batch size within the same pilot',
    rationale: 'selectionFloorMs reuses the independently calibrated 40ms control floor and is 2x the formal 20ms floor; 59/59 holdout successes give at least 95% one-sided confidence that at least 95% of exchangeable pre-acquisition measurements clear the 40ms margin',
  }),

  observationPolicy: Object.freeze({
    keepEverySample: true,
    keepFailures: true,
    keepStalls: true,
    keepMalformedReceipts: true,
    forcedGcDuringTiming: false,
    recordGcJitContextSwitchWhenAvailable: true,
    traceRequiredForClaims: Object.freeze(['cpu', 'paint', 'compositor']),
    separateDenominators: Object.freeze([
      'initial', 'total', 'cold', 'warm', 'start', 'interruption', 'frame',
      'teardown', 'import', 'build', 'memory',
    ]),
  }),
});
