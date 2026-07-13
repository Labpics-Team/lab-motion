import { describe, expect, it } from 'vitest';
import {
  startClock,
  TIMER_ORIGIN_MS,
  timerEvidence,
} from './benchmark-clock-fixture.js';
import {
  movementStats,
  makeRoundRobinOrders,
  scoreAgainstBaseline,
  BENCHMARK_TIMER_ISOLATION_POLICY,
  deriveFirstPresentedElapsedMs,
  deriveWarmStartCalibration,
  evaluateStartSemanticEvidence,
  START_SCENARIO_MANIFEST,
  summarizeReportSamples,
  summarizeMedianSamples,
  WARM_TIMER_CALIBRATION_POLICY,
} from '../bench/compare/methodology.mjs';
import {
  assertAllowedPostReportChanges,
  benchmarkNoReportStatement,
  createBenchmarkClaims,
  parseBenchmarkDocumentationState,
  renderBenchmarkMarkdown,
  renderBenchmarkEnvironment,
  sha256Text,
  validateBenchmarkReportPair,
} from '../bench/compare/report-contract.mjs';

const START = ['lab', 'motion', 'gsap', 'anime'];
const FREEZE = [
  ...START,
  'waapi-ctl',
  'lab-spring',
  'lab-native',
  'motion-mini',
  'anime-waapi',
];
const SHA = (digit: string) => digit.repeat(64);
function freezeRun() {
  const baseline = Array.from({ length: 6 }, (_, index) => ({
    t: (index + 1) / 10,
    x: (index + 1) * 10,
  }));
  const blocked = baseline.map((point) => ({ ...point }));
  const grid = baseline.slice(0, 5).map((point) => point.t);
  const scored = scoreAgainstBaseline(blocked, baseline, grid);
  return {
    valid: true,
    score: scored.score,
    samples: scored.samples,
    movement: movementStats(blocked),
    baselineMovement: movementStats(baseline),
    finalX: 600,
    baselineFinalX: 600,
    blockStart: 0,
    blockEnd: 0.7,
    rawFrames: { baseline: 6, blocked: 6 },
    evidence: { blocked, baseline, grid },
  };
}

function semanticEvidence(scenario: keyof typeof START_SCENARIO_MANIFEST, calls: number) {
  const config = START_SCENARIO_MANIFEST[scenario];
  const checkpointTimes = config.staggerGapMs > 0
    ? [0.2, 0.5, 0.8].map((fraction) => config.staggerGapMs * (config.targetsPerCall - 1) * fraction)
    : [config.durationMs * 0.25];
  const evidence: any = {
    topology: {
      calls,
      targetsPerCall: config.targetsPerCall,
      staggerGapMs: config.staggerGapMs,
      durationMs: config.durationMs,
      toPx: config.toPx,
    },
    callStartedAtMs: Array.from({ length: calls }, () => 0),
    checkpoints: checkpointTimes.map((elapsedMs) => ({
      groups: Array.from({ length: calls }, () => ({
        readStartedMs: elapsedMs,
        readEndedMs: elapsedMs,
        positions: Array.from({ length: config.targetsPerCall }, (_, target) => {
          const progress = config.staggerGapMs === 0
            ? elapsedMs / config.durationMs
            : (elapsedMs - target * config.staggerGapMs) / config.durationMs;
          return config.toPx * Math.max(0, Math.min(1, progress));
        }),
      })),
    })),
    terminal: Array.from({ length: calls }, () => (
      Array.from({ length: config.targetsPerCall }, () => config.toPx)
    )),
  };
  evidence.valid = evaluateStartSemanticEvidence(evidence, config, calls);
  return evidence;
}

function result(
  id: string,
  index: number,
  startRuns: number,
  scenarioManifest: typeof START_SCENARIO_MANIFEST,
) {
  const isStart = START.includes(id);
  const clusters = (
    offset: number,
    samples: number,
    scenario: keyof typeof START_SCENARIO_MANIFEST,
    calls: number,
  ) => isStart
    ? Array.from({ length: startRuns }, (_, run) => {
      const batchElapsedMs = Array.from(
        { length: samples },
        (_, sample) => (offset + run + sample / 10) * calls,
      );
      return {
        run,
        samples: batchElapsedMs.map((batch) => batch / calls),
        batchElapsedMs,
        timerEvidence: timerEvidence(),
        measurementTimeOriginMs: TIMER_ORIGIN_MS,
        semantic: true,
        semanticEvidence: semanticEvidence(scenario, calls),
      };
    })
    : [];
  const warm = {
    s1: clusters(index + 1, 7, 's1', scenarioManifest.s1.warmCalls),
    s2: clusters(index + 2, 7, 's2', scenarioManifest.s2.warmCalls),
    s3: clusters(index + 3, 7, 's3', scenarioManifest.s3.warmCalls),
    s4: clusters(index + 4, 7, 's4', scenarioManifest.s4.warmCalls),
  };
  const cold = {
    s2: clusters(index + 5, 1, 's2', 1),
    s3: clusters(index + 6, 1, 's3', 1),
    s4: clusters(index + 7, 1, 's4', 1),
    firstPresented: isStart
      ? Array.from({ length: startRuns }, (_, run) => {
        const clock = startClock();
        const startedAtSeconds = clock.cdpRuntimeTimestampMs / 1000;
        const evidence = {
          startedAtSeconds,
          timerEvidence: timerEvidence(),
          startClock: clock,
          movementThresholdPx: scenarioManifest.s1.movementThresholdPx,
          rawFrames: 3,
          frames: [
            { timestampSeconds: startedAtSeconds - 0.01, x: 0 },
            { timestampSeconds: startedAtSeconds + 0.01 + (index + run) / 1000, x: 0 },
            { timestampSeconds: startedAtSeconds + 0.02 + (index + run) / 1000, x: 1 },
          ],
        };
        return {
          run,
          samples: [deriveFirstPresentedElapsedMs(
            evidence,
            scenarioManifest.s1.movementThresholdPx,
          )],
          semantic: true,
          semanticEvidence: semanticEvidence('s1', 1),
          presentedEvidence: evidence,
        };
      })
      : [],
  };
  const flatten = (values: Array<{ samples: number[] }>) => values.flatMap((cluster) => cluster.samples);
  const freeze = Array.from({ length: 9 }, freezeRun);
  return {
    version: id === 'waapi-ctl'
      ? 'платформа Chromium (без библиотеки)'
      : ['lab', 'lab-spring', 'lab-native'].includes(id)
        ? '@labpics/motion@0.3.0 (локальный dist)'
        : ['motion', 'motion-mini'].includes(id)
          ? 'motion@12.42.2'
          : id === 'gsap'
            ? 'gsap@3.15.0'
            : 'animejs@4.5.0',
    group: ['lab', 'motion', 'gsap', 'anime'].includes(id)
      ? 'transform-linear-start+stagger-adapter'
      : id === 'waapi-ctl'
        ? 'transform-linear-waapi-control'
        : ['lab-spring', 'lab-native'].includes(id)
          ? 'transform-spring-start-adapter'
          : 'transform-linear-native-start-adapter',
    size: { raw: 10, gz: 9, br: 8, sha256: SHA(String((index + 2) % 10)) },
    adapterSha256: SHA(String((index + 1) % 10)),
    summary: {
      warm: Object.fromEntries(Object.entries(warm).map(([name, values]) => [name, summarizeReportSamples(flatten(values))])),
      cold: Object.fromEntries(Object.entries(cold).map(([name, values]) => [name, summarizeReportSamples(flatten(values), { strict: true })])),
      freeze: {
        score: summarizeMedianSamples(freeze.map((run) => run.score)),
        frames: summarizeMedianSamples(freeze.map((run) => run.movement.frames)),
        distinct: summarizeMedianSamples(freeze.map((run) => run.movement.distinctPositions)),
        net: summarizeMedianSamples(freeze.map((run) => run.movement.netAdvancement)),
        total: summarizeMedianSamples(freeze.map((run) => run.movement.totalAdvancement)),
        finalX: summarizeMedianSamples(freeze.map((run) => run.finalX)),
      },
    },
    raw: { warm, cold, freeze },
  };
}

function fixture(startRuns = 20, warmCalls: Partial<Record<keyof typeof START_SCENARIO_MANIFEST, number>> = {}) {
  const generatedAt = '2026-07-13T00:00:00.000Z';
  const revision = 'a'.repeat(40);
  const dist = SHA('b');
  const stem = `2026-07-13-${revision.slice(0, 12)}-${dist.slice(0, 12)}`;
  const timerStepMs = 0.1;
  const minimumElapsedMs = timerStepMs * WARM_TIMER_CALIBRATION_POLICY.minimumElapsedQuanta;
  const warmStartPilots = Object.fromEntries(Object.entries(START_SCENARIO_MANIFEST).map(([id, config]) => {
    const targetCalls = warmCalls[id as keyof typeof START_SCENARIO_MANIFEST] ?? config.warmCalls;
    const rounds = [];
    for (let calls = config.warmCalls; calls <= targetCalls; calls *= 2) {
      rounds.push({
        calls,
        measurements: Object.fromEntries(START.map((participant) => [
          participant,
          Array.from({ length: WARM_TIMER_CALIBRATION_POLICY.pilotClusters }, () => (
            {
              batchElapsedMs: Array.from({ length: config.warmSamples }, () => (
                calls === targetCalls || participant !== 'gsap' ? minimumElapsedMs : 0
              )),
              timerEvidence: timerEvidence(timerStepMs),
              measurementTimeOriginMs: TIMER_ORIGIN_MS,
            }
          )),
        ])),
      });
    }
    return [id, rounds];
  }));
  const calibrated = deriveWarmStartCalibration(warmStartPilots, START);
  const scenarioManifest = calibrated.scenarioManifest as typeof START_SCENARIO_MANIFEST;
  const results = Object.fromEntries(FREEZE.map((id, index) => [
    id,
    result(id, index, startRuns, scenarioManifest),
  ]));
  const rootPackage = {
    name: '@labpics/motion',
    version: '0.3.0',
    packageManager: 'pnpm@11.11.0',
  };
  const benchmarkPackage = {
    packageManager: 'pnpm@11.11.0',
    devDependencies: {
      animejs: '4.5.0',
      gsap: '3.15.0',
      motion: '12.42.2',
      playwright: '1.61.1',
    },
  };
  const payload: any = {
    schema: 7,
    package: { name: rootPackage.name, version: rootPackage.version },
    generatedAt,
    companion: { markdownFile: `${stem}.md`, markdownSha256: '' },
    environment: [],
    system: {
      cpu: 'Fixture CPU',
      logicalCpus: 8,
      memoryGiB: 16,
      osType: 'FixtureOS',
      osRelease: '1.0',
    },
    provenance: {
      revision,
      shortRevision: revision.slice(0, 12),
      revisionLabel: revision.slice(0, 12),
      dirty: false,
      worktreeSha256: SHA('c'),
      builtAt: generatedAt,
      inputs: {
        'root/package.json': SHA('d'),
        'root/pnpm-lock.yaml': SHA('e'),
        'bench/package.json': SHA('f'),
        'bench/pnpm-lock.yaml': SHA('1'),
        'bench/bench.mjs': SHA('6'),
        'bench/methodology.mjs': SHA('7'),
        'bench/provenance.mjs': SHA('8'),
        'bench/report-contract.mjs': SHA('9'),
      },
      distRuntime: { files: 2, sha256: dist },
      environment: {
        node: 'v24.4.0',
        nodeExecutableSha256: SHA('2'),
        pnpm: '11.11.0',
        packages: {
          motion: { version: '12.42.2', files: 5, sha256: SHA('3') },
          playwright: { version: '1.61.1', files: 5, sha256: SHA('4') },
          animejs: { version: '4.5.0', files: 5, sha256: SHA('6') },
          gsap: { version: '3.15.0', files: 5, sha256: SHA('7') },
        },
      },
    },
    browser: {
      name: 'chromium',
      version: 'fixture',
      revision: '1234',
      files: 20,
      treeSha256: SHA('0'),
      executableSha256: SHA('5'),
    },
    calibration: {
      raw: {
        referenceTimerEvidence: timerEvidence(timerStepMs),
        warmStartPilots,
      },
      referenceTimerStepMs: timerStepMs,
      referenceClockUncertaintyMs: timerStepMs,
      isolation: structuredClone(BENCHMARK_TIMER_ISOLATION_POLICY),
      policy: structuredClone(WARM_TIMER_CALIBRATION_POLICY),
      effectiveWarmCalls: structuredClone(calibrated.effectiveWarmCalls),
    },
    scenarioManifest: structuredClone(scenarioManifest),
    orderSeed: 1,
    participants: { start: START, freeze: FREEZE },
    startOrders: makeRoundRobinOrders(START, startRuns, 1),
    freezeOrders: makeRoundRobinOrders(FREEZE, 9, 2),
    results,
  };
  payload.claims = createBenchmarkClaims(results, {
    seed: payload.orderSeed,
    iterations: 200,
    scenarioManifest: payload.scenarioManifest,
  });
  payload.environment = renderBenchmarkEnvironment(payload);
  const markdown = renderBenchmarkMarkdown(payload);
  payload.companion.markdownSha256 = sha256Text(markdown);
  return { stem, markdown, payload, rootPackage, benchmarkPackage, now: Date.parse(generatedAt) };
}

describe('paired comparative benchmark report', () => {
  it('accepts a clean paired report whose summaries and freeze evidence recompute', () => {
    expect(() => validateBenchmarkReportPair(fixture())).not.toThrow();
    expect(() => validateBenchmarkReportPair(fixture(40))).not.toThrow();
  });

  it('publishes scoped ratio intervals and verdicts without an overall score', () => {
    const { payload, markdown } = fixture();
    expect(payload.claims.performance).toHaveLength(24);
    expect(payload.claims.performance[0]).toMatchObject({
      metric: 'warm.s1',
      competitor: 'motion',
      evidence: { p50: { ratio: expect.any(Number), low: expect.any(Number), high: expect.any(Number) } },
      verdict: expect.stringMatching(/win|inconclusive/),
    });
    expect(payload.claims.size).toHaveLength(3);
    expect(payload.claims.performance.find((claim: any) => claim.id === 'warm.s1:motion').absoluteThresholdMs)
      .toBe(0.2 / 40);
    expect(payload.claims.performance.find((claim: any) => claim.id === 'warm.s4:motion').absoluteThresholdMs)
      .toBe(0.2);
    expect(payload.claims.method).toMatchObject({
      p95NonInferiorityMargin: 0.05,
      p95NonInferiorityMarginProvenance: 'product-tail-noninferiority-policy',
      absoluteThresholdBasis: 'sum-of-participant-max-observed-clock-uncertainty',
      intervalObservedBoundsPerParticipant: 1,
      minimumTimedBatchSteps: 4,
      calibrationPilotClusters: 3,
      effectiveWarmCalls: { s1: 40, s2: 5, s3: 3, s4: 1 },
      relativeThresholdProvenance: 'product-practical-significance-policy',
    });
    expect(markdown).toContain('95% CI отношения Lab / конкурент');
    expect(markdown).not.toMatch(/overall score|общий балл/i);
  });

  it('uses the shared calibrated calls in samples, thresholds and canonical markdown', () => {
    const calibrated = fixture(20, { s1: 80 });
    expect(() => validateBenchmarkReportPair(calibrated)).not.toThrow();
    expect(calibrated.payload.scenarioManifest.s1.warmCalls).toBe(80);
    expect(calibrated.payload.results.lab.raw.warm.s1[0].semanticEvidence.topology.calls).toBe(80);
    expect(calibrated.payload.claims.performance.find((claim: any) => claim.id === 'warm.s1:motion').absoluteThresholdMs)
      .toBe(0.2 / 80);
    expect(calibrated.markdown).toContain('S1: 1 элемент × 80 вызовов');
    expect(calibrated.markdown).not.toContain('батч 40 вызовов');
  });

  it('diagnoses the exact claim, competitor, cluster and invalid sample', () => {
    const { payload } = fixture();
    payload.results.motion.raw.warm.s1[0].samples[0] = 0;
    expect(() => createBenchmarkClaims(payload.results, {
      seed: payload.orderSeed,
      iterations: 200,
      scenarioManifest: payload.scenarioManifest,
    })).toThrow(/warm\.s1:motion.*competitor.*cluster 1.*sample 1.*0/i);
  });

  it('rejects a publish warm batch below the calibrated timer floor before claims', () => {
    const f = fixture() as any;
    const calls = f.payload.scenarioManifest.s1.warmCalls;
    const minimumElapsedMs = (
      f.payload.calibration.referenceTimerStepMs *
      f.payload.calibration.policy.minimumElapsedQuanta
    );
    const cluster = f.payload.results.lab.raw.warm.s1[0];
    cluster.batchElapsedMs[0] = minimumElapsedMs - Number.EPSILON;
    cluster.samples[0] = cluster.batchElapsedMs[0] / calls;

    expect(() => createBenchmarkClaims(f.payload.results, {
      seed: f.payload.orderSeed,
      iterations: 200,
      scenarioManifest: f.payload.scenarioManifest,
    })).toThrow(/warm\.s1.*ниже|timer.*floor|квант/i);
    expect(() => validateBenchmarkReportPair(f)).toThrow(/warm\.s1.*ниже|timer.*floor|квант/i);
  });

  it('uses separate participant maxima even when worst realms are in different runs', () => {
    const f = fixture() as any;
    f.payload.results.lab.raw.warm.s1[0].timerEvidence = timerEvidence(0.2);
    f.payload.results.motion.raw.warm.s1[1].timerEvidence = timerEvidence(0.3);
    const claims = createBenchmarkClaims(f.payload.results, {
      seed: f.payload.orderSeed,
      iterations: 200,
      scenarioManifest: f.payload.scenarioManifest,
    });
    const claim = claims.performance.find((entry: any) => entry.id === 'warm.s1:motion');
    expect(claim.realmObservedUpperMs).toEqual({ lab: 0.2, competitor: 0.3 });
    expect(claim.absoluteThresholdMs).toBe((0.2 + 0.3) / 40);
  });

  it('keeps harmonic probe mass in the superiority uncertainty, not the warm floor', () => {
    const f = fixture() as any;
    const harmonicEvidence = () => {
      const evidence = timerEvidence(0.005);
      for (const probe of evidence.probes) {
        probe.performanceNowDeltasMs = [
          ...Array.from({ length: 48 }, () => 0.005),
          ...Array.from({ length: 16 }, () => 0.01),
        ];
      }
      return evidence;
    };
    for (const [id, sample] of [['lab', 0.185], ['motion', 0.2]] as const) {
      for (const cluster of f.payload.results[id].raw.cold.s2) {
        cluster.samples = [sample];
        cluster.batchElapsedMs = [sample];
        cluster.timerEvidence = harmonicEvidence();
      }
    }

    const claims = createBenchmarkClaims(f.payload.results, {
      seed: f.payload.orderSeed,
      iterations: 200,
      scenarioManifest: f.payload.scenarioManifest,
    });
    const claim = claims.performance.find((entry: any) => entry.id === 'cold.s2:motion');
    expect(claim.realmObservedUpperMs).toEqual({ lab: 0.01, competitor: 0.01 });
    expect(claim.absoluteThresholdMs).toBe(0.02);
    expect(claim.absoluteGainMs).toBeCloseTo(0.015, 12);
    expect(claim.gates.clockResolved).toBe(false);
    expect(claim.verdict).toBe('inconclusive');
  });

  it.each([
    ['dirty claim', (f: any) => { f.payload.provenance.dirty = true; }],
    ['future date', (f: any) => { f.now -= 10 * 60_000; }],
    ['package drift', (f: any) => { f.payload.package.version = '0.2.0'; }],
    ['orphan markdown', (f: any) => { f.payload.companion.markdownFile = 'other.md'; }],
    ['markdown mutation', (f: any) => { f.markdown += '\nmanual'; }],
    ['coordinated table forgery', (f: any) => {
      f.markdown = f.markdown.replace(
        /^(\| S1: 1 элемент[^\n]*?\| )\d+\.\d{3}/m,
        '$10.001',
      );
      f.payload.companion.markdownSha256 = sha256Text(f.markdown);
    }],
    ['coordinated environment forgery', (f: any) => {
      f.payload.environment[2] = 'Машина: Quantum';
      f.markdown = f.markdown.replace(/^- Машина:.*$/m, '- Машина: Quantum');
      f.payload.companion.markdownSha256 = sha256Text(f.markdown);
    }],
    ['adapter hash', (f: any) => { f.payload.results.lab.adapterSha256 = 'fake'; }],
    ['competitor version', (f: any) => { f.payload.results.motion.version = 'motion@99.0.0'; }],
    ['capability group', (f: any) => { f.payload.results['lab-native'].group = 'linear-full'; }],
    ['size bytes', (f: any) => { f.payload.results.gsap.size.gz = -1; }],
    ['summary mutation', (f: any) => { f.payload.results.lab.summary.freeze.score.p50 = 0; }],
    ['evidence mutation', (f: any) => { f.payload.results.lab.raw.freeze[0].score = 0; }],
    ['unbalanced start order', (f: any) => { f.payload.startOrders[1] = [...f.payload.startOrders[0]]; }],
    ['missing tool hash', (f: any) => { delete f.payload.provenance.environment.nodeExecutableSha256; }],
    ['missing Chromium tree hash', (f: any) => { delete f.payload.browser.treeSha256; }],
    ['forged timer step', (f: any) => { f.payload.calibration.referenceTimerStepMs = 0.001; }],
    ['forged clock uncertainty', (f: any) => { f.payload.calibration.referenceClockUncertaintyMs = 0.001; }],
    ['missing timer isolation', (f: any) => { f.payload.calibration.isolation.crossOriginIsolated = false; }],
    ['missing publish realm evidence', (f: any) => { delete f.payload.results.lab.raw.warm.s1[0].timerEvidence; }],
    ['publish measurement realm drift', (f: any) => {
      f.payload.results.lab.raw.warm.s1[0].measurementTimeOriginMs += 1;
    }],
    ['cross-realm publish evidence', (f: any) => {
      f.payload.results.lab.raw.warm.s1[0].timerEvidence.probes[1].timeOriginMs += 1;
    }],
    ['forged calibration policy', (f: any) => { f.payload.calibration.policy.minimumElapsedQuanta = 1; }],
    ['forged effective calls', (f: any) => { f.payload.calibration.effectiveWarmCalls.s1 *= 2; }],
    ['forged pilot elapsed', (f: any) => {
      f.payload.calibration.raw.warmStartPilots.s1[0].measurements.gsap[0].batchElapsedMs[0] = 0;
    }],
    ['per-library pilot shape', (f: any) => {
      f.payload.calibration.raw.warmStartPilots.s1[0].measurements.gsap = { calls: 80, elapsedMs: 4 };
    }],
    ['missing pilot participant', (f: any) => {
      delete f.payload.calibration.raw.warmStartPilots.s1[0].measurements.anime;
    }],
    ['scenario manifest drift', (f: any) => { f.payload.scenarioManifest.s4.targetsPerCall = 999; }],
    ['missing package fingerprint', (f: any) => { delete f.payload.provenance.environment.packages.motion; }],
    ['missing cold sample', (f: any) => { f.payload.results.lab.raw.cold.s2.pop(); }],
    ['null cold sample', (f: any) => { f.payload.results.lab.raw.cold.s2[0].samples[0] = null; }],
    ['presented sample forgery', (f: any) => {
      f.payload.results.lab.raw.cold.firstPresented[0].samples[0] += 1;
    }],
    ['presented frame forgery', (f: any) => {
      f.payload.results.lab.raw.cold.firstPresented[0].presentedEvidence.frames[2].x = 0;
    }],
    ['presented start token forgery', (f: any) => {
      f.payload.results.lab.raw.cold.firstPresented[0].presentedEvidence.startClock.cdpToken = 'other';
    }],
    ['presented start realm drift', (f: any) => {
      f.payload.results.lab.raw.cold.firstPresented[0].presentedEvidence.startClock.pageTimeOriginMs += 1;
    }],
    ['presented clock unit forgery', (f: any) => {
      f.payload.results.lab.raw.cold.firstPresented[0].presentedEvidence.startClock.frameTimestampUnit = 'milliseconds';
    }],
    ['survivor-filtered warm cluster', (f: any) => { f.payload.results.lab.raw.warm.s1[0] = null; }],
    ['semantic failure hidden from verdict', (f: any) => {
      const cluster = f.payload.results.lab.raw.warm.s1[0];
      cluster.semanticEvidence.checkpoints[0].groups.forEach((group: any) => group.positions.fill(300));
      cluster.semanticEvidence.valid = false;
      cluster.semantic = false;
    }],
    ['claim interval forgery', (f: any) => { f.payload.claims.performance[0].evidence.p50.high = 0; }],
    ['fake valid freeze', (f: any) => { f.payload.results.lab.raw.freeze[0].finalX = 100; }],
  ])('rejects %s', (_label, mutate) => {
    const f = fixture() as any;
    mutate(f);
    expect(() => validateBenchmarkReportPair(f)).toThrow();
  });

  it('allows only the report pair and methodology pointer after measured revision', () => {
    const { stem } = fixture();
    expect(() => assertAllowedPostReportChanges([
      `bench/compare/results/${stem}.md`,
      `bench/compare/results/${stem}.json`,
      'docs/бенчмарк.md',
    ], stem)).not.toThrow();
    expect(() => assertAllowedPostReportChanges(['src/spring.ts'], stem)).toThrow(/src\/spring\.ts/);
    expect(() => assertAllowedPostReportChanges(['package.json'], stem)).toThrow(/package\.json/);
  });
});

describe('benchmark documentation evidence state', () => {
  const pkg = {
    name: '@labpics/motion',
    version: '0.3.0',
    repository: { url: 'git+https://github.com/Labpics-Team/lab-motion.git' },
  };
  const stem = '2026-07-13-aaaaaaaaaaaa-bbbbbbbbbbbb';
  const permalink = `https://github.com/Labpics-Team/lab-motion/blob/v0.3.0/bench/compare/results/${stem}.md`;
  const none = benchmarkNoReportStatement(pkg);

  it('accepts either version-bound absence or one exact tagged report', () => {
    expect(parseBenchmarkDocumentationState(none, pkg)).toEqual({ kind: 'none' });
    expect(parseBenchmarkDocumentationState(`[Отчёт](${permalink})`, pkg)).toEqual({
      kind: 'report',
      stem,
      permalink,
    });
  });

  it.each([
    ['none plus report', `${none}\n${permalink}`],
    ['root-only URL', 'https://github.com/Labpics-Team/lab-motion/blob/v0.3.0/bench/compare/results/'],
    ['wrong version', permalink.replace('/v0.3.0/', '/v0.2.0/')],
    ['orphan relative path', `bench/compare/results/${stem}.md`],
    ['extra report', `${permalink}\n${permalink.replace(stem, `${stem}-extra`)}`],
  ])('rejects %s', (_label, document) => {
    expect(() => parseBenchmarkDocumentationState(document, pkg)).toThrow();
  });
});
