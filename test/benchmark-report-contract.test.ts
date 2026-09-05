import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  createBenchmarkMotionConformance,
  parseBenchmarkDocumentationState,
  renderBenchmarkMarkdown,
  renderBenchmarkEnvironment,
  sha256Text,
  S5_MOTION_REQUIREMENTS,
  validateBenchmarkReportPair,
  validateBenchmarkReportForPublication,
} from '../bench/compare/report-contract.mjs';
import { S5_MOTION_CONTRACT } from '../bench/compare/motion-conformance.mjs';
import { revisionFingerprint, sha256Bytes } from '../bench/compare/provenance.mjs';

const START = ['lab', 'motion', 'gsap', 'anime'];
const FREEZE = [
  ...START,
  'waapi-ctl',
  'lab-spring',
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
  const freeze = Array.from({ length: FREEZE.length }, freezeRun);
  return {
    version: id === 'waapi-ctl'
      ? 'платформа Chromium (без библиотеки)'
      : ['lab', 'lab-spring'].includes(id)
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
        : id === 'lab-spring'
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
    devDependencies: { pako: '3.0.1' },
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
    schema: 9,
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
        'root/scripts/compression-policy.mjs': SHA('4'),
        'root/scripts/compression-oracle.mjs': SHA('5'),
        'bench/package.json': SHA('f'),
        'bench/pnpm-lock.yaml': SHA('1'),
        'bench/bench.mjs': SHA('6'),
        'bench/methodology.mjs': SHA('7'),
        'bench/provenance.mjs': SHA('8'),
        'bench/report-contract.mjs': SHA('9'),
        'bench/entries/lab.entry.mjs': SHA('1'),
        'bench/entries/motion.entry.mjs': SHA('2'),
        'bench/entries/gsap.entry.mjs': SHA('3'),
        'bench/entries/anime.entry.mjs': SHA('4'),
        'bench/entries/waapi-control.entry.mjs': SHA('5'),
        'bench/entries/lab-spring.entry.mjs': SHA('6'),
        'bench/entries/motion-mini.entry.mjs': SHA('7'),
        'bench/entries/anime-waapi.entry.mjs': SHA('8'),
      },
      distRuntime: { files: 2, sha256: dist },
      environment: {
        node: 'v24.4.0',
        nodeExecutableSha256: SHA('2'),
        pnpm: '11.11.0',
        rootPackages: {
          pako: { version: '3.0.1', files: 5, sha256: SHA('5') },
        },
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
    freezeOrders: makeRoundRobinOrders(FREEZE, FREEZE.length, 2),
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

type MotionPoint = { t: number; x: number };
type MotionClock = {
  startClock: ReturnType<typeof startClock>;
  timerEvidence: ReturnType<typeof timerEvidence>;
};
type MotionEvidence = {
  baseline: MotionPoint[];
  blocked: MotionPoint[];
  baselineWitness?: MotionPoint[];
  blockedWitness?: MotionPoint[];
  baselineClock?: MotionClock;
  blockedClock?: MotionClock;
  grid: number[];
};
type MotionFreezeRun = {
  valid: boolean;
  score: number | null;
  samples: number;
  movement: ReturnType<typeof movementStats>;
  baselineMovement: ReturnType<typeof movementStats>;
  finalX: number;
  baselineFinalX: number;
  blockStart: number;
  blockEnd: number;
  rawFrames: { baseline: number; blocked: number };
  evidence: MotionEvidence;
};

const linearMotionPoints = (): MotionPoint[] => Array.from(
  { length: 121 }, (_, index) => ({ t: index / 50, x: index * 5 }),
);

// Независимая численная фикстура исходного ОДУ; production solver не импортируется.
function springMotionPoints(): MotionPoint[] {
  const points = [{ t: 0, x: 0 }];
  const step = 0.0005;
  const acceleration = (x: number, velocity: number) => 40 * (600 - x) - 8 * velocity;
  let x = 0;
  let velocity = 0;
  for (let tick = 1; tick <= 4800; tick++) {
    const dx1 = velocity;
    const dv1 = acceleration(x, velocity);
    const dx2 = velocity + dv1 * step / 2;
    const dv2 = acceleration(x + dx1 * step / 2, dx2);
    const dx3 = velocity + dv2 * step / 2;
    const dv3 = acceleration(x + dx2 * step / 2, dx3);
    const dx4 = velocity + dv3 * step;
    const dv4 = acceleration(x + dx3 * step, dx4);
    x += step * (dx1 + 2 * dx2 + 2 * dx3 + dx4) / 6;
    velocity += step * (dv1 + 2 * dv2 + 2 * dv3 + dv4) / 6;
    if (tick % 40 === 0) points.push({ t: tick / 2000, x });
  }
  return points;
}

function motionFreezeRun(id: string): MotionFreezeRun {
  const baseline = id === 'lab-spring' ? springMotionPoints() : linearMotionPoints();
  const evidence: MotionEvidence = {
    baseline,
    blocked: structuredClone(baseline),
    baselineWitness: linearMotionPoints(),
    blockedWitness: linearMotionPoints(),
    baselineClock: { startClock: startClock(), timerEvidence: timerEvidence() },
    blockedClock: { startClock: startClock(), timerEvidence: timerEvidence() },
    grid: baseline.filter((point) => point.t >= 0.38 && point.t <= 1.12).map((point) => point.t),
  };
  const run: MotionFreezeRun = {
    valid: false, score: 0, samples: 0,
    movement: movementStats([]), baselineMovement: movementStats([]),
    finalX: baseline[baseline.length - 1]!.x,
    baselineFinalX: baseline[baseline.length - 1]!.x,
    blockStart: 0.3, blockEnd: 1.2,
    rawFrames: { baseline: baseline.length, blocked: baseline.length },
    evidence,
  };
  refreshMotionRun(run);
  return run;
}

function refreshMotionRun(run: MotionFreezeRun) {
  const scored = scoreAgainstBaseline(run.evidence.blocked, run.evidence.baseline, run.evidence.grid);
  const inWindow = (point: MotionPoint) => point.t >= run.blockStart + 0.08
    && point.t <= run.blockEnd - 0.08;
  run.score = scored.score;
  run.samples = scored.samples;
  run.movement = movementStats(run.evidence.blocked.filter(inWindow));
  run.baselineMovement = movementStats(run.evidence.baseline.filter(inWindow));
  run.rawFrames = { baseline: run.evidence.baseline.length, blocked: run.evidence.blocked.length };
  run.valid = Math.abs(run.baselineFinalX - 600) <= 2 && Math.abs(run.finalX - 600) <= 2
    && Number.isFinite(run.score) && run.samples >= 5
    && run.baselineMovement.distinctPositions >= 5 && run.baselineMovement.totalAdvancement >= 10;
}

function renderMotionPair(report: ReturnType<typeof fixture>) {
  report.markdown = renderBenchmarkMarkdown(report.payload);
  report.payload.companion.markdownSha256 = sha256Text(report.markdown);
}

function refreshMotionReport(report: ReturnType<typeof fixture>) {
  for (const id of FREEZE) {
    const result = report.payload.results[id];
    const runs: MotionFreezeRun[] = result.raw.freeze;
    runs.forEach(refreshMotionRun);
    result.summary.freeze = {
      score: summarizeMedianSamples(runs.map((run) => run.score)),
      frames: summarizeMedianSamples(runs.map((run) => run.movement.frames)),
      distinct: summarizeMedianSamples(runs.map((run) => run.movement.distinctPositions)),
      net: summarizeMedianSamples(runs.map((run) => run.movement.netAdvancement)),
      total: summarizeMedianSamples(runs.map((run) => run.movement.totalAdvancement)),
      finalX: summarizeMedianSamples(runs.map((run) => run.finalX)),
    };
  }
  report.payload.motionConformance = createBenchmarkMotionConformance(report.payload.results);
  renderMotionPair(report);
  return report;
}

function motionFixture() {
  const report = fixture();
  report.payload.schema = 10;
  report.payload.motionContract = structuredClone(S5_MOTION_CONTRACT);
  report.payload.provenance.inputs['bench/motion-conformance.mjs'] = SHA('a');
  for (const id of FREEZE) {
    report.payload.results[id].raw.freeze = Array.from({ length: 8 }, () => motionFreezeRun(id));
  }
  return { ...refreshMotionReport(report), revisionInputs: structuredClone(report.payload.provenance.inputs) };
}

const REVISION_INPUTS = {
  'root/package.json': 'package.json',
  'root/pnpm-lock.yaml': 'pnpm-lock.yaml',
  'root/pnpm-workspace.yaml': 'pnpm-workspace.yaml',
  'root/scripts/compression-policy.mjs': 'scripts/compression-policy.mjs',
  'root/scripts/compression-oracle.mjs': 'scripts/compression-oracle.mjs',
  'bench/package.json': 'bench/compare/package.json',
  'bench/pnpm-lock.yaml': 'bench/compare/pnpm-lock.yaml',
  'bench/pnpm-workspace.yaml': 'bench/compare/pnpm-workspace.yaml',
  'bench/bench.mjs': 'bench/compare/bench.mjs',
  'bench/methodology.mjs': 'bench/compare/methodology.mjs',
  'bench/provenance.mjs': 'bench/compare/provenance.mjs',
  'bench/report-contract.mjs': 'bench/compare/report-contract.mjs',
  'bench/motion-conformance.mjs': 'bench/compare/motion-conformance.mjs',
  'bench/input-manifest.mjs': 'bench/compare/input-manifest.mjs',
  ...Object.fromEntries([
    'lab', 'motion', 'gsap', 'anime', 'waapi-control', 'lab-spring', 'motion-mini', 'anime-waapi',
  ].map((name) => [`bench/entries/${name}.entry.mjs`, `bench/compare/entries/${name}.entry.mjs`])),
};

function withRevisionReport(run: (fixture: {
  report: ReturnType<typeof motionFixture>;
  root: string;
  git: (args: string[]) => Buffer;
  verify: () => void;
  verifyPublication: () => void;
  verifyRevision: () => void;
}) => void, { absent = [], nonRegular }: { absent?: string[]; nonRegular?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lab-motion-report-inputs-'));
  try {
    const report = motionFixture();
    const files = [...Object.values(REVISION_INPUTS), 'scripts/check-docs-facts.mjs', 'scripts/git-path-list.mjs'];
    for (const file of files) {
      if (absent.includes(file)) continue;
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(resolve(file), join(root, file));
    }
    const packageMetadata = { ...report.rootPackage, repository: { url: 'git+https://github.com/Labpics-Team/lab-motion.git' } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageMetadata));
    writeFileSync(join(root, 'bench/compare/package.json'), JSON.stringify(report.benchmarkPackage));
    writeFileSync(join(root, 'README.md'), 'pnpm add @labpics/motion\n');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/benchmark.md'), benchmarkNoReportStatement(packageMetadata));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: join(root, 'no-global-config'), GIT_CONFIG_SYSTEM: join(root, 'no-system-config'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TEMPLATE_DIR: join(root, 'no-template'),
    });
    const git = (args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    });
    git(['init', '--quiet']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '.']);
    if (nonRegular !== undefined) {
      const object = git(['hash-object', nonRegular]).toString().trim();
      git(['update-index', '--cacheinfo', `120000,${object},${nonRegular}`]);
    }
    git(['-c', 'user.name=Benchmark fixture', '-c', 'user.email=benchmark@example.invalid',
      '-c', `core.hooksPath=${join(root, 'no-hooks')}`, 'commit', '--quiet', '-m', 'report inputs']);
    const revision = git(['rev-parse', 'HEAD']).toString().trim();
    const provenance = report.payload.provenance;
    Object.assign(provenance, {
      revision, shortRevision: revision.slice(0, 12), revisionLabel: revision.slice(0, 12),
      worktreeSha256: revisionFingerprint(root, revision),
      inputs: Object.fromEntries(Object.entries(REVISION_INPUTS).filter(([, file]) => !absent.includes(file))
        .map(([label, file]) => [label, sha256Bytes(git(['show', `${revision}:${file}`]))])),
    });
    report.payload.generatedAt = new Date().toISOString();
    report.now = Date.parse(report.payload.generatedAt);
    report.stem = `${report.payload.generatedAt.slice(0, 10)}-${provenance.shortRevision}-${provenance.distRuntime.sha256.slice(0, 12)}`;
    report.payload.companion.markdownFile = `${report.stem}.md`;
    mkdirSync(join(root, 'bench/compare/results'));
    writeFileSync(join(root, 'docs/benchmark.md'), `https://github.com/Labpics-Team/lab-motion/blob/v0.3.0/bench/compare/results/${report.stem}.md`);
    report.revisionInputs = structuredClone(provenance.inputs);
    const writePair = () => {
      report.payload.environment = renderBenchmarkEnvironment(report.payload);
      renderMotionPair(report);
      writeFileSync(join(root, `bench/compare/results/${report.stem}.md`), report.markdown);
      writeFileSync(join(root, `bench/compare/results/${report.stem}.json`), JSON.stringify(report.payload));
    };
    const verifyPublication = () => { writePair(); validateBenchmarkReportForPublication(report); };
    const verifyRevision = () => {
      writePair();
      const output = execFileSync(process.execPath, ['scripts/check-docs-facts.mjs'], {
        cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
      });
      expect(output).toContain('docs-facts: check PASS');
    };
    const verify = () => { verifyPublication(); verifyRevision(); };
    run({ report, root, git, verify, verifyPublication, verifyRevision });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('publication and Git revision input attestation', { timeout: 30_000 }, () => {
  it('rejects omitted workspace inputs even with canonical Markdown and companion SHA', () => {
    withRevisionReport(({ report, verify }) => {
      verify();
      delete report.payload.provenance.inputs['root/pnpm-workspace.yaml'];
      delete report.payload.provenance.inputs['bench/pnpm-workspace.yaml'];
      expect(verify).toThrow();
    });
  });

  it.each([
    'bench/input-manifest.mjs',
    ...Object.keys(REVISION_INPUTS).filter((label) => label.includes('/entries/')),
  ])(
    'rejects a forged %s hash in both publication and revision validators', (label) => {
    withRevisionReport(({ report, verify, verifyPublication, verifyRevision }) => {
      verify();
      report.payload.provenance.inputs[label] = SHA('f');
      expect(verifyPublication).toThrow(/Git revision/);
      expect(verifyRevision).toThrow(/Git revision/);
    });
  });

  it.each(['root/pnpm-workspace.yaml', 'bench/pnpm-workspace.yaml'].flatMap((label) =>
    ['omit', 'mismatch'].map((fault) => ({ label, fault }))))('rejects $fault of $label', ({ label, fault }) => {
    withRevisionReport(({ report, verify, verifyPublication, verifyRevision }) => {
      verify();
      if (fault === 'omit') delete report.payload.provenance.inputs[label];
      else report.payload.provenance.inputs[label] = SHA('f');
      expect(verifyPublication).toThrow(/Git revision/);
      expect(verifyRevision).toThrow(/Git revision/);
    });
  });

  it('the release reader enforces motion admission, not only revision input hashes', () => {
    withRevisionReport(({ report, verify, verifyRevision }) => {
      verify();
      report.payload.results['motion-mini'].raw.freeze[0].evidence.blocked = freeze25To65();
      refreshMotionReport(report);
      expect(verifyRevision).toThrow(/motion-mini.blocked = fail/);
    });
  });

  it.each([
    { label: 'root/pnpm-workspace.yaml', file: 'pnpm-workspace.yaml' },
    { label: 'bench/pnpm-workspace.yaml', file: 'bench/compare/pnpm-workspace.yaml' },
  ])('accepts an absent $label only when the declared Git revision also lacks it', ({ label, file }) => {
    withRevisionReport(({ report, verify, verifyPublication, verifyRevision }) => {
      verify();
      report.payload.provenance.inputs[label] = SHA('f');
      expect(verifyPublication).toThrow(/Git revision/);
      expect(verifyRevision).toThrow(/Git revision/);
    }, { absent: [file] });
  });

  it.each(['absent', 'non-regular'])('rejects an %s required entry in the actual revision', (boundary) => {
    const file = 'bench/compare/entries/lab.entry.mjs';
    withRevisionReport(({ report, verifyRevision }) => {
      report.payload.provenance.inputs['bench/entries/lab.entry.mjs'] = SHA('f');
      expect(verifyRevision).toThrow(/input bench\/entries\/lab.entry.mjs не является обычным файлом Git revision/);
    }, boundary === 'absent' ? { absent: [file] } : { nonRegular: file });
  });

  it('rejects unsupported declared inputs and unsupported revision schemas', () => {
    withRevisionReport(({ report, verify, verifyPublication, verifyRevision }) => {
      verify();
      report.payload.provenance.inputs['bench/unknown-build-input.mjs'] = SHA('f');
      expect(verifyPublication).toThrow(/неподдерживаемый input/);
      expect(verifyRevision).toThrow(/неподдерживаемый input/);
      delete report.payload.provenance.inputs['bench/unknown-build-input.mjs'];
      report.payload.schema = 11;
      expect(verifyPublication).toThrow(/schema 11/);
      expect(verifyRevision).toThrow(/schema 11/);
    });
  });

  it('ignores replacement refs when proving revision ancestry and changed paths', () => {
    withRevisionReport(({ report, root, git, verifyRevision }) => {
      const tree = git(['rev-parse', 'HEAD^{tree}']).toString().trim();
      const identity = ['-c', 'user.name=Benchmark fixture', '-c', 'user.email=benchmark@example.invalid'];
      const unrelated = git([...identity, 'commit-tree', tree, '-m', 'unrelated report revision']).toString().trim();
      const replacement = git([
        ...identity, 'commit-tree', tree, '-p', unrelated, '-m', 'replacement descendant',
      ]).toString().trim();
      git(['replace', 'HEAD', replacement]);

      Object.assign(report.payload.provenance, {
        revision: unrelated,
        shortRevision: unrelated.slice(0, 12),
        revisionLabel: unrelated.slice(0, 12),
        worktreeSha256: revisionFingerprint(root, unrelated),
      });
      report.payload.generatedAt = new Date(Date.now() + 2_000).toISOString();
      report.now = Date.parse(report.payload.generatedAt);
      report.stem = `${report.payload.generatedAt.slice(0, 10)}-${unrelated.slice(0, 12)}-${report.payload.provenance.distRuntime.sha256.slice(0, 12)}`;
      report.payload.companion.markdownFile = `${report.stem}.md`;
      writeFileSync(
        join(root, 'docs/benchmark.md'),
        `https://github.com/Labpics-Team/lab-motion/blob/v0.3.0/bench/compare/results/${report.stem}.md`,
      );

      expect(verifyRevision).toThrow(/предком HEAD/);
    });
  });

  it('does not let replacement refs hide executable changes after the report revision', () => {
    withRevisionReport(({ report, root, git, verifyRevision }) => {
      const revision = report.payload.provenance.revision;
      const revisionTree = git(['rev-parse', `${revision}^{tree}`]).toString().trim();
      writeFileSync(join(root, 'unexpected-runtime.mjs'), 'export const changed = true;\n');
      git(['add', 'unexpected-runtime.mjs']);
      git(['-c', 'user.name=Benchmark fixture', '-c', 'user.email=benchmark@example.invalid',
        '-c', `core.hooksPath=${join(root, 'no-hooks')}`, 'commit', '--quiet', '-m', 'unexpected runtime change']);
      const identity = ['-c', 'user.name=Benchmark fixture', '-c', 'user.email=benchmark@example.invalid'];
      const replacement = git([
        ...identity, 'commit-tree', revisionTree, '-p', revision, '-m', 'replacement without change',
      ]).toString().trim();
      git(['replace', 'HEAD', replacement]);

      expect(verifyRevision).toThrow(/unexpected-runtime\.mjs/);
    });
  });

  it('keeps schema 9/10 additional inputs readable while publication requires revision inputs', () => {
    for (const readable of [fixture(), motionFixture()]) {
      readable.payload.provenance.inputs['legacy/custom-input.mjs'] = SHA('f');
      renderMotionPair(readable);
      expect(() => validateBenchmarkReportPair(readable)).not.toThrow();
    }
    const report = motionFixture();
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportForPublication({ ...report, revisionInputs: undefined }))
      .toThrow(/отсутствует объект input SHA-256/);
  });
});

function freeze25To65(): MotionPoint[] {
  return linearMotionPoints().map((point) => point.t >= 0.6 && point.t <= 1.54
    ? { ...point, x: 150 } : point);
}

describe('schema 10 motion conformance admission', () => {
  it('публикация требует качества и не позволяет ослабить требования вызывающему', () => {
    const report = motionFixture();
    expect(() => validateBenchmarkReportForPublication(report)).not.toThrow();
    expect(() => validateBenchmarkReportForPublication(fixture())).toThrow(/motion conformance/);
    report.payload.results['motion-mini'].raw.freeze[0].evidence.blocked = freeze25To65();
    refreshMotionReport(report);
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportForPublication({ ...report, motionRequirements: undefined }))
      .toThrow(/motion-mini\.blocked = fail/);
    expect(() => validateBenchmarkReportForPublication({
      ...report, motionRequirements: { baseline: ['lab'], blocked: [] },
    })).toThrow(/motion-mini\.blocked = fail/);
  });

  it('принимает полный отчёт с 8 × 8 траекториями и независимой пружиной', () => {
    const report = motionFixture();
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).not.toThrow();
    expect(Object.keys(report.payload.motionConformance)).toEqual(FREEZE);
    for (const id of FREEZE) {
      const conformance = report.payload.motionConformance[id];
      expect(conformance).toMatchObject({ baseline: 'pass', blocked: 'pass', capture: 'pass' });
      expect(conformance.runs).toHaveLength(8);
      for (const run of conformance.runs) {
        expect(run.baseline.samples).toBe(121);
        expect(run.blocked.samples).toBe(121);
      }
    }
    expect(report.payload.motionConformance['lab-spring'].runs[0].baseline.maxErrorPx)
      .toBeLessThan(0.000001);
    expect(report.markdown).toContain('Независимый контракт движения');
    expect(report.markdown).toContain('не выполнение требований движения');
    expect(report.payload.companion.markdownSha256).toBe(sha256Text(report.markdown));
  });

  it('фиксирует scoped требования: baseline для всех и blocked для четырёх native-путей', () => {
    expect(S5_MOTION_REQUIREMENTS).toEqual({
      baseline: FREEZE, blocked: ['waapi-ctl', 'lab-spring', 'motion-mini', 'anime-waapi'],
    });
    expect(Object.isFrozen(S5_MOTION_REQUIREMENTS)).toBe(true);
    expect(Object.isFrozen(S5_MOTION_REQUIREMENTS.baseline)).toBe(true);
    expect(Object.isFrozen(S5_MOTION_REQUIREMENTS.blocked)).toBe(true);
  });

  it('сохраняет наблюдаемое JS-зависание как валидную диагностику, отклоняя blocked quality claim', () => {
    const report = motionFixture();
    const run = report.payload.results.lab.raw.freeze[0];
    run.evidence.blocked = linearMotionPoints().map((point) => point.t >= 0.3 && point.t <= 1.2
      ? { ...point, x: 75 } : point);
    refreshMotionReport(report);
    expect(run.valid).toBe(true);
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(report.payload.motionConformance.lab).toMatchObject({
      baseline: 'pass', blocked: 'fail', capture: 'pass',
    });
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: { baseline: ['lab'], blocked: ['lab'] },
    })).toThrow(/motion conformance: lab\.blocked = fail/);
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).not.toThrow();
  });

  it('отклоняет одинаковое неверное движение baseline и blocked при score 100 и valid=true', () => {
    const report = motionFixture();
    for (const run of report.payload.results.lab.raw.freeze) {
      run.evidence.baseline = freeze25To65();
      run.evidence.blocked = freeze25To65();
    }
    refreshMotionReport(report);
    expect(report.payload.results.lab.summary.freeze.score.p50).toBe(100);
    expect(report.payload.results.lab.raw.freeze.every((run: { valid: boolean }) => run.valid)).toBe(true);
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(report.payload.motionConformance.lab).toMatchObject({
      baseline: 'fail', blocked: 'fail', capture: 'pass',
    });
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion conformance: lab\.baseline = fail/);
  });

  it('один плохой native-прогон не исчезает за медианой score 100', () => {
    const report = motionFixture();
    report.payload.results['motion-mini'].raw.freeze[7].evidence.blocked = freeze25To65();
    refreshMotionReport(report);
    expect(report.payload.results['motion-mini'].summary.freeze.score.p50).toBe(100);
    expect(report.payload.motionConformance['motion-mini'].runs.filter(
      (run: { blocked: { verdict: string } }) => run.blocked.verdict === 'pass',
    )).toHaveLength(7);
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion conformance: motion-mini\.blocked = fail/);
  });

  it('не принимает подделанный cached PASS даже с каноническими Markdown и SHA', () => {
    const report = motionFixture();
    report.payload.results['motion-mini'].raw.freeze[0].evidence.blocked = freeze25To65();
    refreshMotionReport(report);
    const forged = report.payload.motionConformance['motion-mini'];
    forged.blocked = 'pass';
    forged.runs[0].blocked.verdict = 'pass';
    forged.runs[0].blocked.reason = 'within-s5-motion-contract';
    renderMotionPair(report);
    expect(report.payload.companion.markdownSha256).toBe(sha256Text(report.markdown));
    expect(() => validateBenchmarkReportPair(report)).toThrow(/motion conformance не пересчитывается/);
  });

  it.each([
    ['positionTolerancePx', 600], ['timeToleranceMs', 2400], ['maxObservationGapMs', 2400],
    ['distancePx', 150], ['durationMs', 9600], ['id', 's5-motion-v2'],
  ])('отклоняет подмену motion manifest: %s', (field, value) => {
    const report = motionFixture();
    report.payload.motionContract[field] = value;
    renderMotionPair(report);
    expect(() => validateBenchmarkReportPair(report)).toThrow(/motion conformance: контракт изменён/);
  });

  it('отклоняет подмену вложенных параметров пружины', () => {
    const report = motionFixture();
    report.payload.motionContract.spring.damping = 800;
    renderMotionPair(report);
    expect(() => validateBenchmarkReportPair(report)).toThrow(/motion conformance: контракт изменён/);
  });

  it('требует provenance независимого oracle, даже если вердикты пересчитываются', () => {
    const report = motionFixture();
    delete report.payload.provenance.inputs['bench/motion-conformance.mjs'];
    renderMotionPair(report);
    expect(() => validateBenchmarkReportPair(report)).toThrow(/input bench\/motion-conformance.mjs/);
  });

  it.each([
    ['empty', { baseline: [], blocked: [] }],
    ['unknown participant', { baseline: ['unknown'], blocked: [] }],
    ['inherited participant', { baseline: ['toString'], blocked: [] }],
    ['duplicate participant', { baseline: ['lab', 'lab'], blocked: [] }],
    ['missing mode', { baseline: ['lab'] }],
    ['extra mode', { baseline: ['lab'], blocked: [], other: ['lab'] }],
    ['scalar list', { baseline: 'lab', blocked: [] }],
    ['null', null],
  ])('отклоняет неоднозначные требования %s', (_label, motionRequirements) => {
    const report = motionFixture();
    expect(() => validateBenchmarkReportPair({ ...report, motionRequirements }))
      .toThrow(/motion conformance/);
  });

  it.each(['baseline', 'blocked'] as const)('без %s witness движение остаётся inconclusive', (mode) => {
    const report = motionFixture();
    delete report.payload.results['motion-mini'].raw.freeze[0].evidence[`${mode}Witness`];
    refreshMotionReport(report);
    const conformance = report.payload.motionConformance['motion-mini'];
    expect(conformance.capture).toBe('inconclusive');
    expect(conformance[mode]).toBe('inconclusive');
    expect(conformance.runs[0].witness[mode].verdict).toBe('inconclusive');
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(new RegExp(`motion-mini\\.${mode} = inconclusive`));
  });

  it('не квалифицирует неподвижный witness, хотя целевая траектория правильная', () => {
    const report = motionFixture();
    report.payload.results['motion-mini'].raw.freeze[0].evidence.blockedWitness = linearMotionPoints()
      .map((point) => ({ ...point, x: 0 }));
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini']).toMatchObject({
      blocked: 'inconclusive', capture: 'inconclusive',
    });
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion-mini\.blocked = inconclusive/);
  });

  it('не нормализует общий поздний native-старт по Animation.startTime', () => {
    const report = motionFixture();
    const run = report.payload.results['motion-mini'].raw.freeze[0];
    const delayed = linearMotionPoints().map((point) => ({ ...point, x: Math.max(0, point.x - 25) }));
    run.evidence.blocked = delayed;
    run.evidence.blockedWitness = structuredClone(delayed);
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini']).toMatchObject({
      blocked: 'inconclusive', capture: 'inconclusive',
    });
    expect(() => validateBenchmarkReportForPublication(report)).toThrow(/motion-mini\.blocked = inconclusive/);
  });

  it('не достраивает пропущенные кадры из верных редких положений цели и witness', () => {
    const report = motionFixture();
    const run = report.payload.results['motion-mini'].raw.freeze[0];
    run.evidence.blocked = linearMotionPoints().filter((_point, index) => index % 4 === 0);
    run.evidence.blockedWitness = structuredClone(run.evidence.blocked);
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini']).toMatchObject({
      blocked: 'inconclusive', capture: 'inconclusive',
    });
    expect(report.payload.motionConformance['motion-mini'].runs[0].blocked).toMatchObject({
      verdict: 'inconclusive', reason: 'observation-gap-exceeds-contract', samples: 31,
    });
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion-mini\.blocked = inconclusive/);
  });

  it('не подставляет witness из других кадров при правильных отдельных траекториях', () => {
    const report = motionFixture();
    report.payload.results['motion-mini'].raw.freeze[0].evidence.blockedWitness = linearMotionPoints()
      .map((point) => ({ ...point, t: point.t + 0.001 }));
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini']).toMatchObject({
      blocked: 'inconclusive', capture: 'inconclusive',
    });
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion-mini\.blocked = inconclusive/);
  });

  it('не удаляет одинаковые кадры из обеих сеток при сохранённом счётчике захвата', () => {
    const report = motionFixture();
    const run = report.payload.results['motion-mini'].raw.freeze[0];
    run.evidence.blocked = linearMotionPoints().filter((_point, index) => index % 2 === 0);
    run.evidence.blockedWitness = structuredClone(run.evidence.blocked);
    refreshMotionReport(report);
    run.rawFrames.blocked = 121;
    report.payload.motionConformance = createBenchmarkMotionConformance(report.payload.results);
    renderMotionPair(report);
    expect(report.payload.motionConformance['motion-mini'].blocked).toBe('inconclusive');
    expect(() => validateBenchmarkReportPair({ ...report, motionRequirements: S5_MOTION_REQUIREMENTS }))
      .toThrow(/motion-mini\.blocked = inconclusive/);
  });

  it.each(['baseline', 'blocked'] as const)('требует отдельную привязку часов %s', (mode) => {
    const report = motionFixture();
    delete report.payload.results['motion-mini'].raw.freeze[0].evidence[`${mode}Clock`];
    refreshMotionReport(report);
    const conformance = report.payload.motionConformance['motion-mini'];
    expect(conformance.capture).toBe('inconclusive');
    expect(conformance[mode]).toBe('inconclusive');
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(new RegExp(`motion-mini\\.${mode} = inconclusive`));
  });

  it('28 мс между CDP marker и API не проходят как допустимый сдвиг движения', () => {
    const report = motionFixture();
    const clock = report.payload.results['motion-mini'].raw.freeze[0].evidence.blockedClock.startClock;
    clock.pageApiNowMs = clock.pageBeforeNowMs + 28;
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini']).toMatchObject({
      blocked: 'inconclusive', capture: 'inconclusive',
    });
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion-mini\.blocked = inconclusive/);
  });

  it('не принимает CDP marker другого realm даже при малом численном интервале', () => {
    const report = motionFixture();
    report.payload.results['motion-mini'].raw.freeze[0].evidence.blockedClock
      .timerEvidence.probes[1].timeOriginMs += 1;
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini']).toMatchObject({
      blocked: 'inconclusive', capture: 'inconclusive',
    });
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion-mini\.blocked = inconclusive/);
  });

  it('измеренная неопределённость расходует временной бюджет движения', () => {
    const report = motionFixture();
    const run = report.payload.results['motion-mini'].raw.freeze[0];
    run.evidence.blocked = linearMotionPoints().map((point) => point.t === 1.2
      ? { ...point, x: point.x + 7 } : point);
    refreshMotionReport(report);
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).not.toThrow();
    run.evidence.blockedClock.startClock.pageApiNowMs =
      run.evidence.blockedClock.startClock.pageBeforeNowMs + 10;
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini']).toMatchObject({
      blocked: 'fail', capture: 'pass',
    });
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion-mini\.blocked = fail/);
  });

  it.each(['retained null', 'dropped frames'])('потеря красной цели через кадр: %s', (representation) => {
    const report = motionFixture();
    const run = report.payload.results['motion-mini'].raw.freeze[0];
    run.evidence.blocked = representation === 'retained null'
      ? linearMotionPoints().map((point, index) => index % 2 === 0 ? point : { ...point, x: null })
      : linearMotionPoints().filter((_point, index) => index % 2 === 0);
    refreshMotionReport(report);
    expect(report.payload.motionConformance['motion-mini'].blocked).toBe('inconclusive');
    if (representation === 'dropped frames') {
      expect(report.payload.motionConformance['motion-mini'].capture).toBe('inconclusive');
    }
    expect(() => validateBenchmarkReportPair({
      ...report, motionRequirements: S5_MOTION_REQUIREMENTS,
    })).toThrow(/motion-mini\.blocked = inconclusive/);
  });
});

describe('paired comparative benchmark report', () => {
  it('не выдаёт достоверность старого отчёта за соответствие контракту движения', () => {
    const report = fixture();
    expect(() => validateBenchmarkReportPair(report)).not.toThrow();
    expect(() => validateBenchmarkReportPair({
      ...report,
      motionRequirements: { baseline: ['motion-mini'], blocked: ['motion-mini'] },
    })).toThrow(/motion conformance/i);
  });

  it('accepts a clean paired report whose summaries and freeze evidence recompute', () => {
    expect(() => validateBenchmarkReportPair(fixture())).not.toThrow();
    expect(() => validateBenchmarkReportPair(fixture(40))).not.toThrow();
  });

  it('rejects a fully self-consistent report when any start topology is unproved', () => {
    const report = fixture() as any;
    const cluster = report.payload.results.motion.raw.warm.s3[0];
    cluster.semanticEvidence.checkpoints[0].groups.forEach((group: any) => {
      group.positions.fill(30);
    });
    cluster.semanticEvidence.valid = false;
    cluster.semantic = false;
    report.payload.claims = createBenchmarkClaims(report.payload.results, {
      seed: report.payload.orderSeed,
      iterations: 200,
      scenarioManifest: report.payload.scenarioManifest,
    });
    report.markdown = renderBenchmarkMarkdown(report.payload);
    report.payload.companion.markdownSha256 = sha256Text(report.markdown);

    expect(() => validateBenchmarkReportPair(report)).toThrow(/semantic/i);
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
    expect(markdown).toContain('канонический gzip через pako@3.0.1');
    expect(markdown).toContain('уменьшении канонического gzip-9 и системного Brotli-11');
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
    ['retired participant schema', (f: any) => { f.payload.schema = 8; }],
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
    ['capability group', (f: any) => { f.payload.results['lab-spring'].group = 'linear-full'; }],
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
    ['missing root codec fingerprint', (f: any) => {
      delete f.payload.provenance.environment.rootPackages.pako;
    }],
    ['root codec version drift', (f: any) => {
      f.payload.provenance.environment.rootPackages.pako.version = '3.0.0';
    }],
    ['missing canonical gzip helper hash', (f: any) => {
      delete f.payload.provenance.inputs['root/scripts/compression-oracle.mjs'];
    }],
    ['missing canonical gzip policy hash', (f: any) => {
      delete f.payload.provenance.inputs['root/scripts/compression-policy.mjs'];
    }],
    ['missing benchmark entry hash', (f: any) => {
      delete f.payload.provenance.inputs['bench/entries/lab-spring.entry.mjs'];
    }],
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
      'docs/benchmark.md',
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

  it('reader отчёта загружается в consumer-checkout без dev-кодека', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'lab-motion-report-reader-'));
    try {
      const files = [
        'bench/compare/report-contract.mjs',
        'bench/compare/provenance.mjs',
        'bench/compare/input-manifest.mjs',
        'bench/compare/methodology.mjs',
        'bench/compare/motion-conformance.mjs',
        'scripts/compression-oracle.mjs',
        'scripts/compression-policy.mjs',
      ];
      for (const relative of files) {
        const source = resolve(relative);
        if (!existsSync(source)) continue;
        const target = join(isolated, relative);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
      }
      const reader = pathToFileURL(
        join(isolated, 'bench', 'compare', 'report-contract.mjs'),
      ).href;
      expect(() => execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', `await import(${JSON.stringify(reader)})`],
        { cwd: isolated, stdio: 'pipe' },
      )).not.toThrow();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
