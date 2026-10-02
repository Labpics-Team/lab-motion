import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { SERVER_PROFILE, planServerSampleSize, serverProfileDigest, serverTailPolicy, verifyServerProfile } from '../bench/profile/server-profile-registration.mjs';
import { serverCalibrationVerdict, serverCellPairs, serverFamilyIntervals, serverMetricCells, serverOrders,
  compactServerSemanticEvidence, serverArtifactChunks, serverArtifactDigest, serverBrowserClockBounds, serverBrowserSemanticClockErrorMs, serverOrderStatisticBounds, serverResourceReasons,
  parseServerJsonBytes, parseServerJournalBytes, validateServerArtifact, validateServerBrowserSample, validateServerEngineSample, validateServerJournal,
  verifyServerClockRegistration, writeServerArtifact } from '../bench/profile/server-profile-contract.mjs';
import { compactStockMotionValueOutcomes, deriveRealmTimerStep, evaluateStartSemanticEvidence, validateStockMotionValueBatch } from '../bench/compare/methodology.mjs';
import { measureServerBrowser, measureServerEngine } from '../bench/profile/server-profile-runner.mjs';
import * as threadCpuClock from '../bench/profile/server-thread-cpu-clock.mjs';

const hash = 'a'.repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
const syntheticCpuIdentity = { clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 12345, tid: 12345 };
function syntheticNativeEndpoint(ns: bigint, identity = syntheticCpuIdentity) {
  return { ...identity, seconds: String(ns / 1_000_000_000n), nanoseconds: Number(ns % 1_000_000_000n), valueNs: String(ns) };
}
function nativeCpuEndpoint(read: any, identity = syntheticCpuIdentity) {
  return { sequence: read.sequence, ...syntheticNativeEndpoint(BigInt(read.valueNs), identity) };
}
function pairs(runs = SERVER_PROFILE.minRuns, ratio = 1) {
  return serverMetricCells().map(({ id }) => ({ id, left: Array(runs).fill(100), right: Array(runs).fill(100 * ratio),
    leftBounds: Array.from({ length: runs }, () => ({ low: 100, high: 100 })),
    rightBounds: Array.from({ length: runs }, () => ({ low: 100 * ratio, high: 100 * ratio })) }));
}

function normalMotion(scene: any) {
  const times = (scene.staggerGapMs > 0 ? [0.2, 0.5, 0.8] : [0.25, 0.5, 0.625]).map((fraction) => SERVER_PROFILE.durationMs * fraction);
  const positions = (time: number) => Array.from({ length: scene.targetsPerCall }, (_, index) =>
    SERVER_PROFILE.toPx * Math.max(0, Math.min(1, (time - scene.staggerGapMs * index) / SERVER_PROFILE.durationMs)));
  return compactServerSemanticEvidence({ valid: true, topology: { calls: 1, targetsPerCall: scene.targetsPerCall, staggerGapMs: scene.staggerGapMs,
    durationMs: SERVER_PROFILE.durationMs, toPx: SERVER_PROFILE.toPx }, callStartedAtMs: [0],
    onset: { before: [{ readStartedMs: 0, readEndedMs: 0, documentFrame: { beforeMs: 0, afterMs: 0 }, positions: Array(scene.targetsPerCall).fill(0) }],
      after: [{ readStartedMs: 0.025, readEndedMs: 0.05, documentFrame: { beforeMs: 0, afterMs: 0 }, positions: Array(scene.targetsPerCall).fill(0) }],
      firstFrame: { frameTimestampMs: 0, groups: [{ readStartedMs: 0.06, readEndedMs: 0.07,
        documentFrame: { beforeMs: 0, afterMs: 0 }, positions: Array(scene.targetsPerCall).fill(0) }] } },
    checkpoints: times.map((time) => ({ frameTimestampMs: time, groups: [{ readStartedMs: time, readEndedMs: time + 0.1,
      documentFrame: { beforeMs: time, afterMs: time }, positions: positions(time) }] })),
    terminal: [Array(scene.targetsPerCall).fill(SERVER_PROFILE.toPx)] });
}

// Независимые explicit linear vectors, не solver/formatter/expectedValues SUT.
function engineRaw(scene: any, repetition = 0) {
  const render = ([x, y, scaleX, scaleY, rotate, skewX, skewY]: number[]) =>
    `translate(${x}px, ${y}px) scaleX(${scaleX}) scaleY(${scaleY}) rotate(${rotate}deg) skew(${skewX}deg, ${skewY}deg)`;
  const live = scene.lifecycle === 'live';
  const offsets = [0, 16, 32, 48, 64, 80], setupOffsets = live ? [0, 32] : [];
  const setup = live ? [[0, 0, 1, 1, 0, 0, 0], [16, 8, 1.25, 1.5, 8, 2, 4]].map(render) : [];
  const values = live ? [16, 46, 76, 106, 136, 166].map((x) => render([x, 8, 1.25, 1.5, 8, 2, 4]))
    : [[0, 0, 1, 1, 0, 0, 0], [32, 20, 1.375, 1.5, 12, 3, 5], [64, 40, 1.75, 2, 24, 6, 10],
      [96, 60, 2.125, 2.5, 36, 9, 15], [128, 80, 2.5, 3, 48, 12, 20], [160, 100, 2.875, 3.5, 60, 15, 25]].map(render);
  const base = 1_000_000 + (live ? 48 : 0);
  const steps = [
    ...setupOffsets.map((offset, index) => ({ stage: 'setup', index, phase: 'setup', timestampMs: 1_000_000 + offset })),
    ...offsets.map((offset, index) => ({ stage: 'frame', index, phase: 'frames', timestampMs: base + offset })),
    { stage: 'cancel-drain', index: null, phase: 'outside', timestampMs: base + 128 },
    ...[256, 384].map((offset) => ({ stage: 'idle', index: null, phase: 'outside', timestampMs: base + offset })),
  ].map((step, sequence) => ({ sequence, ...step }));
  const events = steps.filter((step) => ['setup', 'frame'].includes(step.stage)).map((step, sequence) => ({ sequence,
    phase: step.phase, index: step.index, step: step.sequence, timestampMs: step.timestampMs, property: 'transform',
    value: step.stage === 'setup' ? setup[step.index!] : values[step.index!] }));
  const clockReads = [{ metric: 'operationNs', frame: null }, ...offsets.map((_, frame) => ({ metric: 'frameNs', frame })),
    { metric: 'cancelDrainNs', frame: null }].flatMap(({ metric, frame }, interval) => ['before', 'after'].map((edge, half) => ({
      sequence: interval * 2 + half, metric, frame, edge,
      valueNs: String(10_000_000 + repetition * 100_000_000 + interval * 2_000_000 + (half ? metric === 'cancelDrainNs' ? 500_000 : 1_000_000 : 0)) })));
  return { operationNs: 1_000_000, frameNs: Array(6).fill(1_000_000), cancelDrainNs: 500_000,
    raw: { schemaVersion: 1, case: { count: scene.count, lifecycle: scene.lifecycle, channels: scene.channels }, clockReads,
      cpuReads: clockReads.map((read) => nativeCpuEndpoint(read)),
      timeline: { clockOriginMs: 1_000_000, setupOffsetsMs: setupOffsets, frameOffsetsMs: offsets, successorBaseMs: base, steps },
      targetTraces: { encoding: 'runs', count: scene.count, runs: [{ from: 0, count: scene.count,
        trace: { value: values.at(-1), setup, setupWrites: setup.map(() => 1), values, writes: values.map(() => 1), outsideWrites: 0, events } }] } },
    semantic: { valid: true, targets: scene.count, frames: 6, finished: true, pending: 0, onCompleteCalls: 0,
      previousFinished: live ? true : null, previousCompleteCalls: 0, requests: live ? 9 : 7, executions: live ? 9 : 7,
      targetTraceHashes: { encoding: 'repeat', count: scene.count, value: createHash('sha256').update(JSON.stringify(values)).digest('hex') } } };
}

function stockRaw(scene: any, multiplier = 1, timed = true, repetition = 0) {
  const calls = scene.callsPerRepetition * multiplier;
  const clockReads = timed ? ['before', 'after'].map((edge, sequence) => ({ sequence, metric: 'operationNs', frame: null, edge,
    valueNs: String(10_000_000 + repetition * (10_000_000 + scene.callsPerRepetition * multiplier * 1_000_000) +
      sequence * scene.callsPerRepetition * multiplier * 1_000_000) })) : [];
  return { operationNs: timed ? 1_000_000 * multiplier : null, raw: { schemaVersion: 1, scene: scene.id,
    phase: timed ? 'timed' : 'warmup', calls, completed: calls, denominator: scene.callsPerRepetition,
    clockReads, cpuReads: clockReads.map((read) => nativeCpuEndpoint(read)),
    outcomes: { encoding: 'runs', count: calls, runs: [{ from: 0, count: calls, value: 100, frames: 47 }] } } };
}

function stage(name = 'aa', runs = 2) {
  const rows: any[] = [];
  for (let run = 0; run < runs; run++) for (const [kind, scenes] of [['engine', SERVER_PROFILE.engineScenes], ['browser', SERVER_PROFILE.browserScenes]] as const) {
    for (const scene of scenes) {
      const samples: any = {};
      for (const id of ['left', 'right']) {
        const multiplier = name === 'positive' && id === 'right' ? 2 : 1;
        let raw: any[];
        let extra: any = {};
        if (kind === 'engine') {
          if ((scene as any).workload === 'stock-c') {
            raw = Array.from({ length: SERVER_PROFILE.repetitions }, (_, repetition) => stockRaw(scene, multiplier, true, repetition));
            extra = { operationNs: 1_000_000 * multiplier, cpuScope: SERVER_PROFILE.stockCpuScope,
              warmup: Array.from({ length: (scene as any).warmupBatches }, () => stockRaw(scene, 1, false)) };
          } else {
            raw = Array.from({ length: SERVER_PROFILE.repetitions * multiplier }, (_, repetition) => engineRaw(scene, repetition));
            extra = { operationNs: 1_000_000 * multiplier, meanFrameNs: 1_000_000 * multiplier, cancelDrainNs: 500_000 * multiplier };
          }
        } else {
          const timerEvidence = { crossOriginIsolated: true, probes: ['before', 'after'].map((phase) => ({ phase,
            timeOriginMs: 1000, performanceNowDeltasMs: Array(64).fill(0.005) })) };
          const count = (scene as any).targetsPerCall;
          const calls = SERVER_PROFILE.browserBatchCalls * multiplier;
          const cancellation = (targets: number) => ({ connectedTargets: targets, activeWaapiBefore: 0, transformsBefore: { encoding: 'repeat', count: targets, value: 0 },
            frames: Array.from({ length: SERVER_PROFILE.browserCancellationWitness.frames }, () => ({ connectedTargets: targets, activeWaapi: 0, transforms: { encoding: 'repeat', count: targets, value: 0 } })),
            cancelDrainMs: 64 });
          raw = Array.from({ length: SERVER_PROFILE.repetitions }, (_, index) => {
            const beginMs = 100 + index * 1000, endMs = beginMs + SERVER_PROFILE.browserBatchCalls * multiplier;
            return { startMs: multiplier, cancelMs: 0.5 * multiplier,
              batchStartMs: SERVER_PROFILE.browserBatchCalls * multiplier, batchCancelMs: SERVER_PROFILE.browserBatchCalls * 0.5 * multiplier,
              calls, ownersStarted: calls, ownersCancelled: calls, startClock: { beginMs, endMs },
              cancelClock: { beginMs: endMs + 3, endMs: endMs + 3 + SERVER_PROFILE.browserBatchCalls * 0.5 * multiplier },
              startWitness: { connectedTargets: calls * count, activeWaapi: 0, leadingPositions: { encoding: 'repeat', count: calls, value: 0 },
                readClock: { beginMs: endMs + 1, endMs: endMs + 2 } }, cancelWitness: cancellation(calls * count) };
          });
          extra = { startMs: 1 * multiplier, cancelMs: 0.5 * multiplier, timerEvidence,
            timerStepMs: deriveRealmTimerStep('fixture', timerEvidence), measurementTimeOriginMs: 1000,
            endpoints: Array(count).fill(SERVER_PROFILE.toPx), controlCancelMs: 0.5, controlCancelWitness: cancellation(count), warmup: [raw[0]],
            semanticEvidence: normalMotion(scene), monotonicHostUpperNs: '1000000000000', clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError) };
        }
        samples[id] = { raw, ...extra, semantic: true, workMultiplier: multiplier, repetitions: SERVER_PROFILE.repetitions, denominator: SERVER_PROFILE.denominator,
          ...(kind === 'engine' ? { cpuClock: { ...syntheticCpuIdentity } } : {}) };
      }
      rows.push({ kind, scene: scene.id, run, order: serverOrders(runs)[run], samples });
    }
  }
  const blocks = Array.from({ length: runs / 2 }, (_, block) => {
    const cpuStat = { usage_usec: 10 + block * 10, user_usec: 10 + block * 10, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
    return { block, before: { cpuStat, affinity: '0', cpuMax: '400000 100000' }, after: { cpuStat: { ...cpuStat, usage_usec: cpuStat.usage_usec + 10, user_usec: cpuStat.user_usec + 10 }, affinity: '0', cpuMax: '400000 100000' },
      delta: { usage_usec: 10, user_usec: 10, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 } };
  });
  return { name, rows, blocks };
}

function registeredRefusal() {
  const packageInfo = { version: '1.0.0', sha256: hash, files: 1 };
  const provenance = { revision: SERVER_PROFILE.baselineRevision, dirty: false, trackedRevisionSha256: hash, worktreeSha256: hash,
    distRuntime: { sha256: hash, files: 1 }, inputs: Object.fromEntries(['root/package.json', 'root/pnpm-lock.yaml', 'bench/package.json', 'bench/pnpm-lock.yaml'].map((name) => [name, hash])),
    environment: { node: SERVER_PROFILE.clockError.nodeVersion, nodeExecutableSha256: SERVER_PROFILE.clockError.nodeExecutableSha256, pnpm: '11.11.0',
      packages: Object.fromEntries(['esbuild', 'playwright', 'motion', 'gsap', 'animejs'].map((name) => [name, packageInfo])),
      rootPackages: Object.fromEntries(['tsup', 'typescript', 'esbuild'].map((name) => [name, packageInfo])) } };
  const machineIdentity = { affinity: '0', cgroupCpuMax: '400000 100000', platform: 'linux', release: SERVER_PROFILE.clockError.kernelRelease, node: SERVER_PROFILE.clockError.nodeVersion,
    nodeExecutableSha256: SERVER_PROFILE.clockError.nodeExecutableSha256 };
  const consumer = { tarballSha256: hash, treeSha256: hash };
  const registration = { protocolDigest: serverProfileDigest(SERVER_PROFILE), candidateSamplesObserved: false,
    candidateSamplesObservedScope: SERVER_PROFILE.candidateSamplesObservedScope,
    browser: 'chromium', browserVersion: SERVER_PROFILE.clockError.browserVersion, browserExecutableSha256: SERVER_PROFILE.clockError.browserExecutableSha256,
    clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError), browserTree: { sha256: hash, files: 1 },
    provenance: { baseline: provenance, candidate: { ...provenance, revision: 'b'.repeat(40) } },
    machine: { identity: machineIdentity, sha256: serverProfileDigest(machineIdentity) },
    engineClock: { schema: 1, ...syntheticCpuIdentity, napiVersion: 8,
      node: { version: SERVER_PROFILE.clockError.nodeVersion, executableSha256: SERVER_PROFILE.clockError.nodeExecutableSha256 },
      nativeBinary: { path: '/synthetic/thread-cpu.node', bytes: 1, sha256: hash }, nativeSources: clone(SERVER_PROFILE.clockError.nativeSourceFiles),
      nativeSourceDigest: serverProfileDigest(Object.fromEntries(Object.entries(SERVER_PROFILE.clockError.nativeSourceFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))),
      compiler: { path: '/synthetic/cc', version: 'synthetic compiler', binarySha256: hash, flags: ['-shared', '-fPIC', '-DNAPI_VERSION=8'] },
      libc: { path: '/synthetic/libc.so', sha256: hash }, nominalResolutionNs: '1', nominalResolutionIsNotErrorCertificate: true },
    harness: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), { sha256: hash }])),
    packages: Object.fromEntries(['baseline', 'candidate', ...SERVER_PROFILE.comparators.filter((x) => x !== 'waapi-ctl')].map((name) => [name, clone(consumer)])),
    transitivePackages: { one: consumer, two: consumer, three: consumer } };
  return { schema: 1, protocol: SERVER_PROFILE, registration, registrationDigest: serverProfileDigest(registration), verdict: 'UNPROVEN',
    failures: [{ stage: 'warmup', error: { message: 'незавершённая контрольная серия' } }] };
}

function healthyAdmission() {
  const artifact: any = registeredRefusal(); artifact.failures = []; artifact.verdict = 'PASS';
  artifact.warmup = stage('warmup', SERVER_PROFILE.warmupRuns);
  artifact.pilot = stage('pilot', SERVER_PROFILE.pilotRuns);
  artifact.samplePlan = planServerSampleSize(serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, 'pilot'));
  const runs = artifact.samplePlan.runs;
  artifact.aa = stage('aa', runs); artifact.positive = stage('positive', runs); artifact.ab = stage('ab', runs);
  artifact.frozenPlanDigest = serverProfileDigest({ registrationDigest: artifact.registrationDigest, samplePlan: artifact.samplePlan });
  const aa = serverFamilyIntervals(serverCellPairs(artifact.aa, runs, 'aa'));
  const positive = serverFamilyIntervals(serverCellPairs(artifact.positive, runs, 'positive'));
  artifact.calibration = { ...serverCalibrationVerdict(aa, positive, artifact.samplePlan), aa, positive };
  artifact.comparison = serverFamilyIntervals(serverCellPairs(artifact.ab, runs, 'ab'));
  const control = { noMotion: { equal: true, beforeSha256: hash, afterSha256: hash },
    reduced: { prefersReducedMotion: true, x: SERVER_PROFILE.toPx, rafRequests: 0, activeWaapi: 0 } };
  artifact.rawControls = { baseline: clone(control), candidate: clone(control) };
  artifact.comparators = SERVER_PROFILE.browserScenes.flatMap((scene) => SERVER_PROFILE.comparators.map((id) => {
    if (scene.staggerGapMs > 0 && ['motion-mini', 'anime-waapi'].includes(id)) return { scene: scene.id, id,
      status: 'UNPROVEN', reason: 'общего stagger API нет' };
    const sample = artifact.ab.rows.find((row: any) => row.scene === scene.id).samples.left;
    return { scene: scene.id, id, rows: Array.from({ length: runs }, () => sample) };
  }));
  const retention = { verdict: 'COMPLETE', failure: null, rows: SERVER_PROFILE.engineScenes.map((scene) => ({
    scene: scene.id, before: { heapUsed: 1000 }, after: { heapUsed: 900 }, retainedHeapDeltaBytes: -100 })) };
  artifact.retention = { baseline: clone(retention), candidate: clone(retention) };
  return artifact;
}

function admissionEvents(artifact: any) {
  const events: any[] = [{ type: 'registration-before-any-sample', value: { registration: artifact.registration, digest: artifact.registrationDigest } },
    { type: 'raw-controls-baseline', value: artifact.rawControls.baseline }];
  for (const name of ['warmup', 'pilot', 'aa', 'positive', 'ab']) {
    if (name === 'aa') events.push({ type: 'N-frozen-before-calibration-and-AB', value: { samplePlan: artifact.samplePlan, digest: artifact.frozenPlanDigest } });
    if (name === 'ab') events.push({ type: 'calibration', value: artifact.calibration }, { type: 'raw-controls-candidate-after-calibration', value: artifact.rawControls.candidate });
    const current = artifact[name];
    current.rows.forEach((row: any, index: number) => {
      for (const participant of row.order) events.push({ type: 'sample', value: { stage: name, kind: row.kind, scene: row.scene, run: row.run, participant,
        build: name === 'ab' && participant === 'right' ? 'candidate' : 'baseline', value: row.samples[participant] } });
      const blockRows = (SERVER_PROFILE.engineScenes.length + SERVER_PROFILE.browserScenes.length) * 2;
      if ((index + 1) % blockRows === 0) events.push({ type: 'resources-block', value: { stage: name, ...current.blocks[Math.floor(index / blockRows)] } });
    });
  }
  for (const comparator of artifact.comparators) for (let run = 0; run < (comparator.rows ?? []).length; run++) {
    events.push({ type: 'comparator-sample', value: { scene: comparator.scene, id: comparator.id, run, sample: comparator.rows[run] } });
  }
  for (const id of ['baseline', 'candidate']) events.push({ type: 'retention-sample', value: { id, value: artifact.retention[id] } });
  events.push({ type: 'retention-separate-forced-GC', value: artifact.retention });
  events.push({ type: 'finished', value: { verdict: artifact.verdict, digest: serverArtifactDigest(artifact) } });
  return events;
}

function chain(events: any[], shared?: { events: any[]; records: any[] }) {
  // Только подготовка fixture переиспользует неизменённый префикс по identity.
  // Валидатор заново проверяет каждый hash и весь зарегистрированный raw каждой истории.
  let prefix = 0;
  while (shared && prefix < events.length && events[prefix] === shared.events[prefix]) prefix++;
  let previous = prefix ? shared!.records[prefix - 1].digest : '0'.repeat(64);
  return [...(shared?.records.slice(0, prefix) ?? []), ...events.slice(prefix).map((event) => {
    const payload = { sequenceDigest: previous, ...event }; previous = serverProfileDigest(payload);
    return { ...payload, digest: previous };
  })];
}

// Два набора fault cases используют одну healthy зарегистрированную историю. Изменяются
// только принадлежащие fault ветви; исходные events/raw остаются неизменными.
let sharedAdmission: { artifact: any; events: any[]; records: any[] } | undefined;
function admissionHistory() {
  if (!sharedAdmission) {
    const artifact = healthyAdmission(), events = admissionEvents(artifact);
    sharedAdmission = { artifact, events, records: chain(events) };
  }
  return sharedAdmission;
}

// Исполняем настоящий browser owner в VM с независимым линейным DOM и
// намеренно грубыми часами. Это synthetic fault test, не performance sample.
function syntheticBrowser(options: { startCostMs?: number; snap?: boolean; snapAt?: number; cancelAt?: number; rejectTiming?: boolean;
  durationMultiplier?: number; shape?: 'quadratic'; rafStepMs?: number; readCostMs?: number; timerLagMs?: number;
  initialProgress?: number; initialProgressAt?: number; onsetReadAt?: number; documentClock?: 'missing' | 'unstable' | 'unrelated';
  documentOriginLagMs?: number; quarterAtFirstFrame?: boolean; quarterAtFrame?: number } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'motion-server-synthetic-'));
  const source = path.join(directory, 'adapter.js'); writeFileSync(source, '// Синтетический adapter задан VM.\n');
  let timeMs = 100, frameTimeMs = timeMs - (options.documentOriginLagMs ?? 0), frameReads = 0, frames = 0, starts = 0, cancels = 0;
  const children: any[] = [];
  const position = (element: any) => {
    if (!element.motion) return element.x;
    if (element.motion.pendingFrame) return SERVER_PROFILE.toPx * element.motion.initialProgress;
    const progress = Math.max(0, Math.min(1, (timeMs - element.motion.startedMs - element.motion.delayMs) / element.motion.durationMs + element.motion.initialProgress));
    return SERVER_PROFILE.toPx * (options.shape === 'quadratic' ? progress * progress : progress);
  };
  const start = (elements: any[], to: number, duration: number, gap = 0) => {
    starts++;
    const startedMs = timeMs;
    for (const [index, element] of elements.entries()) {
      if (options.snap || starts === options.snapAt) { element.x = to; element.motion = null; }
      else element.motion = { startedMs, durationMs: duration * (options.durationMultiplier ?? 1), delayMs: index * gap,
        pendingFrame: true,
        initialProgress: starts >= (options.initialProgressAt ?? 1) ? options.initialProgress ?? 0 : 0 };
    }
    timeMs += options.startCostMs ?? 0.025;
    return { cancel() {
      cancels++;
      if (cancels === options.cancelAt) throw undefined;
      timeMs += 0.05;
      for (const element of elements) { element.x = position(element); element.motion = null; }
    } };
  };
  const sandbox: any = { crossOriginIsolated: true, performance: { timeOrigin: 1000, now() {
    timeMs += 0.001; return Math.floor(timeMs / 0.005) * 0.005;
  } }, document: { timeline: { get currentTime() {
    if (options.documentClock === 'missing') return null;
    return frameTimeMs + (options.documentClock === 'unstable' ? ++frameReads * 0.01 : options.documentClock === 'unrelated' ? 1 : 0);
  } }, createElement() { return { x: 0, motion: null, isConnected: false,
    getAnimations: () => [], remove() { this.isConnected = false; } }; }, body: { appendChild(element: any) { element.isConnected = true; children.push(element); } } },
  getComputedStyle: (element: any) => {
    if (starts === 0 && children.indexOf(element) === options.onsetReadAt) throw new Error('синтетический отказ acquired onset prefix');
    const transform = String(position(element)); timeMs += options.readCostMs ?? 0;
    return { transform };
  }, DOMMatrixReadOnly: class { e: number; constructor(value: string) { this.e = Number(value); } },
  setTimeout(callback: () => void, delay: number) {
    // VM автоматически публикует pending animation frame во время timer wait;
    // explicit first-frame oracle получает тот же ноль своим rAF.
    for (const element of children) if (element.motion?.pendingFrame) {
      element.motion.startedMs += options.rafStepMs ?? 16; element.motion.pendingFrame = false;
    }
    timeMs += delay + (options.timerLagMs ?? 0); queueMicrotask(callback);
  },
  requestAnimationFrame(callback: (time: number) => void) {
    timeMs += options.rafStepMs ?? 16; frameTimeMs = timeMs; frames++;
    for (const element of children) if (element.motion) {
      if (element.motion.pendingFrame) { element.motion.startedMs = frameTimeMs; element.motion.pendingFrame = false; }
      if (frames === (options.quarterAtFirstFrame ? 1 : options.quarterAtFrame)) element.motion.initialProgress = 0.25;
    }
    queueMicrotask(() => callback(timeMs));
  },
  __adapterModule: { start, startStagger: start } };
  sandbox.window = sandbox;
  const realm = createContext(sandbox);
  const page = { goto: async () => {}, exposeFunction: async (name: string, fn: Function) => { sandbox[name] = fn; },
    async evaluate(fn: Function, argument?: any) {
      if (options.rejectTiming && fn.toString().includes('const raw = [], warmup')) throw undefined;
      return runInContext(`(${fn.toString()})`, realm)(argument);
    } };
  const context = { newPage: async () => page, close: async () => {} };
  return { browser: { newContext: async () => context }, page, adapter: { path: source },
    dispose: () => rmSync(directory, { recursive: true, force: true }), read: () => ({ starts, cancels, connected: children.filter((element) => element.isConnected).length }) };
}

// Исполняем замороженную границу page.evaluate общего владельца. VM задаёт
// часы и движение самостоятельно; производственный oracle получает его raw.
async function syntheticSemanticControl(fake: ReturnType<typeof syntheticBrowser>, scene: any) {
  const bench = readFileSync(new URL('../bench/compare/bench.mjs', import.meta.url), 'utf8');
  const source = bench.slice(bench.indexOf('export async function runSemanticStartCheck('), bench.indexOf('// ─── сценарий S5:')).trim().replace(/^export /, '');
  const runCheck = Function('evaluateStartSemanticEvidence', `return (${source})`)(evaluateStartSemanticEvidence);
  const semanticClockErrorMs = serverBrowserSemanticClockErrorMs('1000000000000');
  return runCheck(fake.page, { ...scene, ...SERVER_PROFILE.browserSemantics, semanticClockErrorMs,
    durationMs: SERVER_PROFILE.durationMs, toPx: SERVER_PROFILE.toPx }, SERVER_PROFILE.browserSemanticCalls);
}

describe('серверный PROFILE: clock/progress falsifiers', () => {
  it('stock C добавляет ровно одну whole-macro family и сохраняет per-operation47/100', () => {
    const scene = SERVER_PROFILE.engineScenes.find((scene) => scene.workload === 'stock-c')!;
    expect(serverMetricCells()).toHaveLength(11);
    expect(serverMetricCells().filter((cell) => cell.scene === scene.id).map((cell) => cell.metric)).toEqual(['operationNs']);
    const plain = compactStockMotionValueOutcomes([100, 100, 0, 200], [47, 47, 0, 94]);
    expect(plain).toEqual({ encoding: 'runs', count: 4, runs: [
      { from: 0, count: 2, value: 100, frames: 47 }, { from: 2, count: 1, value: 0, frames: 0 }, { from: 3, count: 1, value: 200, frames: 94 }] });
    const sample = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
    validateServerEngineSample(sample, scene);
    const cell = serverCellPairs(stage(), 2, 'aa').find((cell) => cell.scene === scene.id)!;
    expect(cell.leftBounds[0].low).toBeLessThanOrEqual(1_000_000 - 1);
    expect(cell.leftBounds[0].high).toBeGreaterThanOrEqual(1_000_000 + 1);
  });
  it('stock C failure outcomes сохраняют приобретённые primitive identities после JSON/RLE', () => {
    const acquired = [undefined, undefined, -0, 0, NaN, Infinity, -Infinity];
    const saved = JSON.parse(JSON.stringify(compactStockMotionValueOutcomes(acquired, [47, 47, 47, 47, 47, 47, undefined])));
    const expanded = saved.runs.flatMap((run: any) => Array.from({ length: run.count }, () => [run.value, run.frames]));
    expect(expanded).toEqual([[{ type: 'undefined' }, 47], [{ type: 'undefined' }, 47], [{ number: '-0' }, 47], [0, 47],
      [{ nonfinite: 'NaN' }, 47], [{ nonfinite: 'Infinity' }, 47], [{ nonfinite: '-Infinity' }, { type: 'undefined' }]]);
    expect(saved.count).toBe(acquired.length);
    expect(saved.runs.map((run: any) => run.from)).toEqual([0, 2, 3, 4, 5, 6]);
  });
  it.each(['mixed-frames', 'mixed-endpoints', 'missing-operation', 'wrong-divisor', 'missing-warmup', 'missing-cpu-read',
    'coherent-timespec-mismatch', 'aggregate-only-drift'])('stock C raw отвергает %s с правильными aggregates', (fault) => {
    const scene = SERVER_PROFILE.engineScenes.find((scene) => scene.workload === 'stock-c')!;
    const sample = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
    validateServerEngineSample(sample, scene);
    const raw = sample.raw[0];
    if (fault === 'mixed-frames') raw.raw.outcomes.runs = [{ from: 0, count: 1000, value: 100, frames: 0 }, { from: 1000, count: 1000, value: 100, frames: 94 }];
    if (fault === 'mixed-endpoints') raw.raw.outcomes.runs = [{ from: 0, count: 1000, value: 0, frames: 47 }, { from: 1000, count: 1000, value: 200, frames: 47 }];
    if (fault === 'missing-operation') raw.raw.outcomes.runs[0].count--;
    if (fault === 'wrong-divisor') raw.raw.denominator = 4000;
    if (fault === 'missing-warmup') sample.warmup.pop();
    if (fault === 'missing-cpu-read') raw.raw.cpuReads.pop();
    if (fault === 'coherent-timespec-mismatch') {
      raw.raw.clockReads[1].valueNs = String(BigInt(raw.raw.clockReads[1].valueNs) + 1n);
      raw.raw.cpuReads[1].valueNs = raw.raw.clockReads[1].valueNs;
      raw.operationNs += 1 / 2000;
      sample.operationNs = sample.raw.reduce((sum: number, item: any) => sum + item.operationNs, 0) / sample.repetitions;
    }
    if (fault === 'aggregate-only-drift') sample.operationNs++;
    expect(() => validateServerEngineSample(sample, scene)).toThrow(/stock C|CPU|timing/);
  });
  it('stock C producer делает2warmups, actual2×work и сохраняет поздний prefix без выдуманного CPU endpoint', async () => {
    const scene = SERVER_PROFILE.engineScenes.find((scene) => scene.workload === 'stock-c')!;
    let constructors = 0, destroys = 0, failAt = Infinity, cpuNs = 0n;
    const cpu = vi.spyOn(threadCpuClock, 'readServerThreadCpuEndpoint').mockImplementation(() =>
      syntheticNativeEndpoint(cpuNs += 2_000_000_000n, { clock: 'CLOCK_THREAD_CPUTIME_ID', pid: process.pid, tid: process.pid }));
    class ObservedMotionValue {
      private readonly options: any;
      private changed: (value: number) => unknown = () => {};
      private index: number;
      constructor(options: any) {
        this.index = constructors++; this.options = options;
        expect(options.initial).toBe(0); expect(options.spring).toEqual({ mass: 1, stiffness: 170, damping: 26 });
        expect(Object.hasOwn(options, 'clamp')).toBe(false);
      }
      onChange(changed: (value: number) => unknown) { this.changed = changed; changed(0); }
      setTarget(target: number) {
        expect(target).toBe(100);
        let count = 0;
        const frame = () => { this.changed(++count === 47 ? 100 : count); if (count < 47) this.options.requestFrame(frame); };
        this.options.requestFrame(frame);
      }
      destroy() { destroys++; if (this.index === failAt) throw undefined; }
    }
    try {
      const success = await measureServerEngine(ObservedMotionValue, scene, 2);
      expect(constructors).toBe(2 * 2000 + 8 * 4000); expect(destroys).toBe(constructors);
      expect(cpu).toHaveBeenCalledTimes(16); expect(success.raw).toHaveLength(8); expect(success.warmup).toHaveLength(2);
      success.warmup.forEach((batch: any) => validateStockMotionValueBatch(batch, scene, 1, false));
      success.raw.forEach((batch: any) => {
        expect(batch.raw.outcomes).toEqual({ encoding: 'runs', count: 4000, runs: [{ from: 0, count: 4000, value: 100, frames: 47 }] });
        expect(batch.operationNs).toBe(1_000_000);
      });
      validateServerEngineSample(success, scene, 2);
      constructors = destroys = 0; failAt = 4002; cpu.mockClear();
      const failed: any = await measureServerEngine(ObservedMotionValue, scene).catch((error) => error);
      expect(failed).toBeInstanceOf(AggregateError); expect(failed.raw.warmup).toHaveLength(2); expect(failed.raw.completed).toEqual([]);
      expect(failed.raw.failedRepetition.raw).toMatchObject({ completed: 2, values: [100, 100], frames: [47, 47],
        unfinishedOperation: { index: 2, valueAcquired: false, frameAcquired: false } });
      expect(failed.raw.failedRepetition.raw.clockReads).toHaveLength(1); expect(failed.raw.failedRepetition.raw.cpuReads).toHaveLength(1);
      expect(cpu).toHaveBeenCalledTimes(1);
      if (process.env.MOTION_SERVER_STOCK_UNIT_EVIDENCE) writeFileSync(process.env.MOTION_SERVER_STOCK_UNIT_EVIDENCE,
        JSON.stringify({ synthetic: true, actualRegisteredPerformanceSamples: 0, scene, success, failure: { name: failed.name, message: failed.message, raw: failed.raw } }) + '\n', { flag: 'wx' });
    } finally { cpu.mockRestore(); }
  });
  it('chunked JSON сохраняет native values, порядок, escape/UTF8 и duplicate/prototype keys', () => {
    const text = '{"rows":[{"text":"кириллица\\n\\\"[,]{}\\\\🙂","raw":[null,true,false,-0,1e200,9007199254740993]},[{},[]]],"__proto__":{"safe":1},"a":1,"a":2,"tail":"\\u0000"}';
    const expected = JSON.parse(text);
    for (const chunkBytes of [1, 7, 17, 64, 1024]) {
      const actual = parseServerJsonBytes(Buffer.from(text), chunkBytes);
      expect(actual).toEqual(expected); expect(Object.keys(actual)).toEqual(Object.keys(expected));
      expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
      expect(Object.hasOwn(actual, '__proto__')).toBe(true); expect(Object.is(actual.rows[0].raw[3], -0)).toBe(true);
    }
    for (const malformed of ['', '[1,]', '{"a":1,}', '{"a" 1}', '{"a":1}{}', '[1,,2]', '[{"a":1]]', '{"a":[1}}',
      '{"a":"escape\\"}', '[NaN]', '[1 2]', '{"a":01}', '["unclosed]', '{bare:1}']) {
      expect(() => JSON.parse(malformed)).toThrow();
      expect(() => parseServerJsonBytes(Buffer.from(malformed), 1)).toThrow();
    }
  });
  it('journal декодируется по полным records, сохраняя literal escapes и отказ на потерянной строке', () => {
    const records = [{ type: 'sample', value: { text: 'строка\n[,]{}\\"', large: 'x'.repeat(1000) } },
      { type: 'failure', value: { raw: [{ metric: -0 }, null] } }];
    const bytes = Buffer.from(` \n${records.map((record) => JSON.stringify(record)).join('\n')}\r\n `);
    expect(parseServerJournalBytes(bytes)).toEqual(records.map((record) => JSON.parse(JSON.stringify(record))));
    expect(() => parseServerJournalBytes(Buffer.from(`${JSON.stringify(records[0])}\n\n${JSON.stringify(records[1])}`))).toThrow();
    expect(() => parseServerJournalBytes(Buffer.from(' \r\n'))).toThrow();
  });
  it('настоящий engine owner сохраняет controlled CPU endpoints на успехе и позднем отказе', async () => {
    const { animate } = await import('../src/animate/index.js');
    let cpuNs = 0n;
    const cpu = vi.spyOn(threadCpuClock, 'readServerThreadCpuEndpoint').mockImplementation(() =>
      syntheticNativeEndpoint(cpuNs += 1_000_000n, { clock: 'CLOCK_THREAD_CPUTIME_ID', pid: process.pid, tid: process.pid }));
    const scene = SERVER_PROFILE.engineScenes[1];
    try {
      const success = await measureServerEngine(animate, scene);
      expect(success.raw).toHaveLength(8); expect(cpu).toHaveBeenCalledTimes(128);
      for (const measured of success.raw) {
        expect(measured.raw.clockReads).toHaveLength(16); expect(measured.raw.cpuReads).toHaveLength(16);
        measured.raw.clockReads.forEach((read: any, sequence: number) => {
          expect(measured.raw.cpuReads[sequence].valueNs).toBe(read.valueNs);
          expect(String(BigInt(measured.raw.cpuReads[sequence].seconds) * 1_000_000_000n + BigInt(measured.raw.cpuReads[sequence].nanoseconds))).toBe(read.valueNs);
        });
      }
      validateServerEngineSample(success, scene);
      cpu.mockClear();
      const broken = ((...args: Parameters<typeof animate>) => {
        const owner = animate(...args);
        return { ...owner, cancel() { owner.cancel(); throw undefined; } };
      }) as typeof animate;
      const failure: any = await measureServerEngine(broken, scene).catch((error) => error);
      // Опциональная долговечная квитанция только этого synthetic unit probe.
      // CPU поля вымышлены mock clock; это не performance sample продукта.
      if (process.env.MOTION_SERVER_PROFILE_UNIT_EVIDENCE) writeFileSync(process.env.MOTION_SERVER_PROFILE_UNIT_EVIDENCE,
        `${JSON.stringify({ synthetic: true, actualTimingSamplesObserved: 0, scene, success,
          failure: { name: failure?.name, message: failure?.message, raw: failure?.raw } }, null, 2)}\n`, { flag: 'wx' });
      expect(failure).toBeInstanceOf(AggregateError); expect(failure.raw.completed).toEqual([]);
      const failed = failure.raw.failedRepetition;
      expect(failed.clockReads).toHaveLength(15); expect(failed.cpuReads).toHaveLength(15);
      expect(failed.operationNs).toBe(1_000_000); expect(failed.frameNs).toEqual(Array(6).fill(1_000_000));
      expect(failed.cancelDrainNs).toBe(null); expect(failed.unfinishedInterval.metric).toBe('cancelDrainNs');
      expect(cpu).toHaveBeenCalledTimes(15);
    } finally { cpu.mockRestore(); }
  });
  it.each(['missing-read', 'read-order', 'impossible-ns', 'coherent-impossible-ns', 'missing-cpu-field', 'backward-native-counter',
    'last-target-coordinate', 'missing-target-identity', 'hash-only-drift'])('engine raw lineage отвергает %s при semantic:true', (fault) => {
    const scene = SERVER_PROFILE.engineScenes[1];
    const sample: any = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
    validateServerEngineSample(sample, scene);
    const measured = sample.raw[0], lineage = measured.raw;
    if (fault === 'missing-read') lineage.clockReads.pop();
    if (fault === 'read-order') [lineage.clockReads[0], lineage.clockReads[1]] = [lineage.clockReads[1], lineage.clockReads[0]];
    if (fault === 'impossible-ns' || fault === 'coherent-impossible-ns') {
      measured.operationNs++;
      if (fault === 'coherent-impossible-ns') {
        lineage.clockReads[1].valueNs = String(BigInt(lineage.clockReads[1].valueNs) + 1n);
        lineage.cpuReads[1].valueNs = lineage.clockReads[1].valueNs;
      }
      sample.operationNs = sample.raw.reduce((sum: number, raw: any) => sum + raw.operationNs, 0) / sample.repetitions;
    }
    if (fault === 'missing-cpu-field') delete lineage.cpuReads[1].seconds;
    if (fault === 'backward-native-counter') {
      lineage.clockReads[2].valueNs = String(BigInt(lineage.clockReads[1].valueNs) - 1n);
      lineage.cpuReads[2] = nativeCpuEndpoint(lineage.clockReads[2]);
      measured.frameNs[0] = Number(BigInt(lineage.clockReads[3].valueNs) - BigInt(lineage.clockReads[2].valueNs));
      sample.meanFrameNs = sample.raw.reduce((sum: number, raw: any) => sum + raw.frameNs.reduce((a: number, b: number) => a + b, 0) / raw.frameNs.length, 0) / sample.repetitions;
    }
    if (fault === 'last-target-coordinate') {
      const first = lineage.targetTraces.runs[0], last = clone(first.trace);
      first.count--;
      last.values[5] = last.values[5].replace('160px', '161px'); last.value = last.values[5]; last.events.at(-1).value = last.value;
      lineage.targetTraces.runs.push({ from: scene.count - 1, count: 1, trace: last });
      const firstHash = measured.semantic.targetTraceHashes.value;
      measured.semantic.targetTraceHashes = Array(scene.count).fill(firstHash);
      measured.semantic.targetTraceHashes[scene.count - 1] = createHash('sha256').update(JSON.stringify(last.values)).digest('hex');
    }
    if (fault === 'missing-target-identity') lineage.targetTraces.runs[0].count--;
    if (fault === 'hash-only-drift') measured.semantic.targetTraceHashes.value = hash;
    // Вызов новый: local projection cache не переносит trusted snapshot между проверками.
    expect(() => validateServerEngineSample(sample, scene)).toThrow(/lineage|CPU|raw target/);
  });
  it.each(['duration64', 'duration256', 'quadratic-last-target', 'missing-frame-time'])('raw normal-motion oracle пересчитывает %s при valid:true', (fault) => {
    const scene = SERVER_PROFILE.browserScenes[0];
    const sample: any = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
    for (const checkpoint of sample.semanticEvidence.checkpoints) {
      const group = checkpoint.groups[0], time = checkpoint.frameTimestampMs;
      if (fault === 'missing-frame-time') { delete checkpoint.frameTimestampMs; continue; }
      const positions = Array(scene.targetsPerCall).fill(SERVER_PROFILE.toPx * time / SERVER_PROFILE.durationMs);
      if (fault === 'quadratic-last-target') positions[scene.targetsPerCall - 1] = SERVER_PROFILE.toPx * (time / SERVER_PROFILE.durationMs) ** 2;
      else positions.fill(SERVER_PROFILE.toPx * Math.min(1, time / (fault === 'duration64' ? 64 : 256)));
      group.positions = compactServerSemanticEvidence({ ...sample.semanticEvidence, checkpoints: [{ ...checkpoint, groups: [{ ...group, positions }] }] }).checkpoints[0].groups[0].positions;
    }
    sample.semanticEvidence.valid = true;
    expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion/);
  });
  it.each([{ durationMultiplier: 0.5 }, { durationMultiplier: 2 }, { shape: 'quadratic' as const }, { rafStepMs: 300 }])(
    'отвергает чужую duration/shape и неразрешимое rAF окно %j', async (options) => {
      const fake = syntheticBrowser(options);
      try {
        const error: any = await measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, SERVER_PROFILE.browserScenes[0]).catch((error) => error);
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.raw.partial.find((row: any) => row.phase === 'normal-motion').evidence.valid).toBe(false);
        expect(fake.read().starts).toBe(1);
      } finally { fake.dispose(); }
    });
  it.each([
    { name: '128мс: узкое окно при позднем таймере', options: { timerLagMs: 40 }, expected: true },
    { name: '128мс: широкое неразрешающее окно', options: { timerLagMs: 40, readCostMs: 0.32 }, expected: false },
    { name: '256мс: честное широкое окно', options: { durationMultiplier: 2, timerLagMs: 40, readCostMs: 0.32 }, expected: false },
  ])('producer/consumer нормального движения: $name', async ({ options, expected }) => {
    const scene = SERVER_PROFILE.browserScenes[0], fake = syntheticBrowser(options);
    try {
      const evidence = await syntheticSemanticControl(fake, scene);
      expect(evidence.valid).toBe(expected);
      const sample: any = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
      // Пересчитываем acquired окна и CSS даже при поддельном upstream valid.
      sample.semanticEvidence = compactServerSemanticEvidence({ ...evidence, valid: true });
      if (expected) expect(() => validateServerBrowserSample(sample, scene)).not.toThrow();
      else expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion/);
      expect(fake.read()).toEqual({ starts: 1, cancels: 1, connected: 0 });
    } finally { fake.dispose(); }
  });
  it.each(SERVER_PROFILE.browserScenes)('отвергает начальный скачок0→75px в $id при valid:true', async (scene) => {
    const fake = syntheticBrowser({ initialProgress: 0.25 });
    try {
      const evidence = await syntheticSemanticControl(fake, scene);
      expect(evidence.onset.before[0].positions).toEqual(Array(scene.targetsPerCall).fill(0));
      expect(evidence.onset.after[0].positions[0]).toBeGreaterThanOrEqual(75);
      expect(evidence.valid).toBe(false);
      const sample: any = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
      sample.semanticEvidence = compactServerSemanticEvidence({ ...evidence, valid: true });
      expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion/);
      expect(fake.read()).toEqual({ starts: 1, cancels: 1, connected: 0 });
    } finally { fake.dispose(); }
  });
  it.each(['missing-before', 'missing-after', 'missing-last-coordinate', 'wrong-before', 'post-before-start', 'wide-before', 'before-phase-drift'])(
    'fresh onset decoder/oracle отвергает %s', (fault) => {
      const scene = SERVER_PROFILE.browserScenes[0], sample: any = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
      if (fault === 'missing-before') delete sample.semanticEvidence.onset.before;
      if (fault === 'missing-after') delete sample.semanticEvidence.onset.after;
      if (fault === 'missing-last-coordinate') sample.semanticEvidence.onset.before[0].positions.count--;
      if (fault === 'wrong-before') sample.semanticEvidence.onset.before[0].positions.runs = [[99, 0], [1, 75]];
      if (fault === 'post-before-start') sample.semanticEvidence.callStartedAtMs[0] = 1;
      if (fault === 'wide-before') sample.semanticEvidence.onset.before[0].readEndedMs = 20;
      if (fault === 'before-phase-drift') sample.semanticEvidence.onset.before[0].readStartedMs = -1;
      expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion/);
    });
  it('сохраняет неполный acquired onset до отказа и все extra raw fields', async () => {
    const scene = SERVER_PROFILE.browserScenes[0], fake = syntheticBrowser({ onsetReadAt: 17 });
    try {
      const evidence = await syntheticSemanticControl(fake, scene);
      expect(evidence.valid).toBe(false); expect(evidence.onset.before[0].positions).toHaveLength(17);
      expect(evidence.onset.before[0].readEndedMs).toBeUndefined(); expect(evidence.onset.after).toHaveLength(0);
      const raw = { ...evidence, onset: { ...evidence.onset, acquiredNote: 'не синтезировать остальные координаты' } };
      const compacted = compactServerSemanticEvidence(raw);
      expect(compacted.onset.before[0].positions).toEqual({ encoding: 'rle', count: 17, runs: [[17, 0]] });
      expect(compacted.onset.before[0].readEndedMs).toBeUndefined(); expect(compacted.onset.after).toEqual([]);
      expect(compacted.onset.acquiredNote).toBe(raw.onset.acquiredNote);
      expect(fake.read()).toEqual({ starts: 0, cancels: 0, connected: 0 });
    } finally { fake.dispose(); }
  });
  it.each(SERVER_PROFILE.browserScenes)('наблюдает intermediate $id и все32/64 useful owner outcomes', async (scene) => {
    for (const multiplier of [1, 2]) {
      const fake = syntheticBrowser();
      try {
        const sample = await measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, scene, multiplier);
        expect(sample.semanticEvidence.valid).toBe(true);
        expect(sample.raw).toHaveLength(SERVER_PROFILE.repetitions);
        expect(sample.raw.every((row: any) => row.calls === SERVER_PROFILE.browserBatchCalls * multiplier && row.ownersCancelled === row.calls)).toBe(true);
        expect(fake.read().connected).toBe(0);
      } finally { fake.dispose(); }
    }
  });

  it.each(['missing', 'unstable', 'unrelated'] as const)('producer отказывает при %s document frame и сохраняет приобретённый trace', async (documentClock) => {
    const fake = syntheticBrowser({ documentClock });
    try {
      let failure: any;
      try { await measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, SERVER_PROFILE.browserScenes[0]); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ name: 'AggregateError' });
      expect(failure.raw.semanticEvidence.valid).toBe(false);
      expect(failure.raw.semanticEvidence.checkpoints).toHaveLength(3);
      expect(failure.raw.semanticEvidence.checkpoints[0].groups[0]).toHaveProperty('documentFrame');
      expect(fake.read()).toEqual({ starts: 1, cancels: 1, connected: 0 });
    } finally { fake.dispose(); }
  });

  it.each(['missing-frame', 'missing-end', 'unstable', 'RAF-disagreement', 'future-clock'])('consumer отвергает %s при valid:true', (fault) => {
    const scene = SERVER_PROFILE.browserScenes[0], sample = stage().rows.find((row: any) => row.scene === scene.id).samples.left;
    const group = sample.semanticEvidence.checkpoints[0].groups[0];
    if (fault === 'missing-frame') delete group.documentFrame;
    if (fault === 'missing-end') delete group.documentFrame.afterMs;
    if (fault === 'unstable') group.documentFrame.afterMs += 0.001;
    if (fault === 'RAF-disagreement') { group.documentFrame.beforeMs++; group.documentFrame.afterMs++; }
    if (fault === 'future-clock') for (const checkpoint of sample.semanticEvidence.checkpoints) {
      checkpoint.frameTimestampMs += 1e9;
      for (const current of checkpoint.groups) {
        current.readStartedMs += 1e9; current.readEndedMs += 1e9;
        current.documentFrame.beforeMs += 1e9; current.documentFrame.afterMs += 1e9;
      }
    }
    expect(sample.semanticEvidence.valid).toBe(true);
    expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion|clock/);
  });

  it('fresh API и CSS публикация предыдущего кадра сохраняют здоровый128ms raw', () => {
    const scene = SERVER_PROFILE.browserScenes[0], sample = stage().rows.find((row: any) => row.scene === scene.id).samples.left;
    const evidence = sample.semanticEvidence;
    // Приобретённые координаты/времена primary b214: прежний wall-after
    // ошибочно требовал phase≥2.85ms, хотя CSS опубликован до API frame.
    evidence.callStartedAtMs = [0.845];
    evidence.onset.before[0] = { readStartedMs: 0.01, readEndedMs: 0.84,
      documentFrame: { beforeMs: -15.735, afterMs: -15.735 }, positions: { encoding: 'rle', count: scene.targetsPerCall, runs: [[scene.targetsPerCall, 0]] } };
    evidence.onset.after[0] = { readStartedMs: 3.065, readEndedMs: 3.73,
      documentFrame: { beforeMs: -15.735, afterMs: -15.735 }, positions: { encoding: 'rle', count: scene.targetsPerCall, runs: [[scene.targetsPerCall, 0]] } };
    evidence.onset.firstFrame = { frameTimestampMs: 0.935, groups: [{ readStartedMs: 4, readEndedMs: 4.1,
      documentFrame: { beforeMs: 0.935, afterMs: 0.935 }, positions: { encoding: 'rle', count: scene.targetsPerCall, runs: [[scene.targetsPerCall, 0]] } }] };
    evidence.checkpoints = [[34.265, 35.15, 35.94, 78.1172], [67.595, 68.55, 69.145, 156.234], [84.265, 85.22, 85.9, 195.305]]
      .map(([frame, started, ended, value]) => ({ frameTimestampMs: frame, groups: [{ readStartedMs: started, readEndedMs: ended,
        documentFrame: { beforeMs: frame, afterMs: frame }, positions: { encoding: 'rle', count: scene.targetsPerCall, runs: [[scene.targetsPerCall, value]] } }] }));
    expect(() => validateServerBrowserSample(sample, scene)).not.toThrow();
    evidence.onset.after[0].positions.runs[0][1] = 75;
    expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion/);
  });

  it.each(['before-missing', 'after-missing', 'after-unstable', 'after-future', 'after-backwards'])('consumer отвергает onset frame %s при valid:true', (fault) => {
    const scene = SERVER_PROFILE.browserScenes[0], sample = stage().rows.find((row: any) => row.scene === scene.id).samples.left;
    const onset = sample.semanticEvidence.onset;
    if (fault === 'before-missing') delete onset.before[0].documentFrame;
    if (fault === 'after-missing') delete onset.after[0].documentFrame;
    if (fault === 'after-unstable') onset.after[0].documentFrame.afterMs += 0.001;
    if (fault === 'after-future') onset.after[0].documentFrame = { beforeMs: 1, afterMs: 1 };
    if (fault === 'after-backwards') onset.after[0].documentFrame = { beforeMs: -1, afterMs: -1 };
    expect(sample.semanticEvidence.valid).toBe(true);
    expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion|clock/);
  });

  it('mixed document/perf envelope покрывает независимые ошибки frame/now/origin, сохраняя API-cost envelope', () => {
    const host = '1000000000000', cost = serverBrowserClockBounds({ beginMs: 0, endMs: 0 }, host).errorMs;
    const semantic = serverBrowserSemanticClockErrorMs(host);
    // Независимые ошибки трёх приобретённых timestamps, с обоими направлениями
    // clamp/truncation. Origin сокращается только между perf endpoints.
    for (const frameError of [-0.006, 0, 0.006]) for (const nowError of [-0.006, 0, 0.006]) for (const originError of [-0.006, 0, 0.006]) {
      const mixedObserved = 64 + frameError - nowError + originError;
      expect(Math.abs(mixedObserved - 64)).toBeLessThanOrEqual(semantic);
    }
    expect(cost).toBeLessThan(0.0120001); expect(semantic).toBeGreaterThanOrEqual(0.018);
  });

  it.each(SERVER_PROFILE.browserScenes.flatMap((scene) => [1, 2].map((frame) => ({ scene, frame }))))('старый doc clock не подменяет полезную публикацию $scene.id frame$frame', async ({ scene, frame }) => {
    const healthy = syntheticBrowser({ documentOriginLagMs: 50 });
    const faulty = syntheticBrowser({ documentOriginLagMs: 50, quarterAtFrame: frame });
    try {
      const good: any = await syntheticSemanticControl(healthy, scene), bad: any = await syntheticSemanticControl(faulty, scene);
      expect(good.valid).toBe(true); expect(bad.valid).toBe(false);
      expect(bad.onset.before[0].positions.every((value: number) => value === 0)).toBe(true);
      expect(bad.onset.after[0].positions.every((value: number) => value === 0)).toBe(true);
      if (frame === 1) expect(bad.onset.firstFrame.groups[0].positions[0]).toBeGreaterThanOrEqual(75);
      else expect(bad.onset.firstFrame.groups[0].positions.every((value: number) => Math.abs(value) <= 0.5)).toBe(true);
      const sample = stage().rows.find((row: any) => row.scene === scene.id).samples.left;
      sample.semanticEvidence = compactServerSemanticEvidence({ ...bad, valid: true });
      expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion/);
      expect(healthy.read().connected).toBe(0); expect(faulty.read().connected).toBe(0);
    } finally { healthy.dispose(); faulty.dispose(); }
  });

  it.each(['missing', 'nonzero', 'unstable', 'no-RAF', 'before-API-read'])('consumer отвергает first publication %s при valid:true', (fault) => {
    const scene = SERVER_PROFILE.browserScenes[0], sample = stage().rows.find((row: any) => row.scene === scene.id).samples.left;
    const first = sample.semanticEvidence.onset.firstFrame;
    if (fault === 'missing') delete sample.semanticEvidence.onset.firstFrame;
    if (fault === 'nonzero') first.groups[0].positions.runs[0][1] = 75;
    if (fault === 'unstable') first.groups[0].documentFrame.afterMs += 0.001;
    if (fault === 'no-RAF') delete first.frameTimestampMs;
    if (fault === 'before-API-read') first.groups[0].readStartedMs = 0;
    expect(() => validateServerBrowserSample(sample, scene)).toThrow(/normal-motion/);
  });

  it('endpoint snap и stateful nth-call snap отказывают до semantic:true', async () => {
    for (const options of [{ snap: true }, { snapAt: 9 }]) {
      const fake = syntheticBrowser(options);
      try { await expect(measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, SERVER_PROFILE.browserScenes[0])).rejects.toMatchObject({ name: 'AggregateError' }); }
      finally { fake.dispose(); }
    }
  });

  it.each([3, 9])('сохраняет всю acquired работу при скачке0→75px только с timed вызова%s', async (initialProgressAt) => {
    const fake = syntheticBrowser({ initialProgress: 0.25, initialProgressAt });
    try {
      let failure: any;
      try { await measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, SERVER_PROFILE.browserScenes[0]); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ name: 'AggregateError' });
      expect(failure.raw.semanticEvidence.valid).toBe(true);
      expect(failure.raw.raw).toHaveLength(SERVER_PROFILE.repetitions);
      expect(failure.raw.warmup).toHaveLength(1);
      expect(failure.raw.raw.every((row: any) => row.ownersStarted === SERVER_PROFILE.browserBatchCalls && row.ownersCancelled === row.ownersStarted)).toBe(true);
      expect(fake.read().connected).toBe(0);
      expect(() => validateServerBrowserSample(failure.raw, SERVER_PROFILE.browserScenes[0])).toThrow(/начала|onset/);
    } finally { fake.dispose(); }
  });

  it('consumer повторно выводит timed onset из actual start/read clocks при valid:true', () => {
    const scene = SERVER_PROFILE.browserScenes[0], sample = stage().rows.find((row: any) => row.scene === scene.id).samples.left;
    const raw = sample.raw[0]; raw.startClock.endMs = raw.startClock.beginMs + 0.8;
    raw.batchStartMs = raw.startClock.endMs - raw.startClock.beginMs; raw.startMs = raw.batchStartMs / SERVER_PROFILE.browserBatchCalls;
    raw.startWitness.readClock = { beginMs: raw.startClock.endMs + 0.001, endMs: raw.startClock.endMs + 0.002 };
    raw.startWitness.leadingPositions = { encoding: 'repeat', count: raw.calls, value: 75 };
    sample.startMs = sample.raw.reduce((sum: number, row: any) => sum + row.startMs, 0) / sample.repetitions;
    expect(sample.semanticEvidence.valid).toBe(true);
    expect(() => validateServerBrowserSample(sample, scene)).toThrow(/начала|onset/);
  });

  it('один batch отличает25us от27us; квант5us не скрывает8% в CI', async () => {
    const measured: any[] = [];
    for (const startCostMs of [0.025, 0.027]) {
      const fake = syntheticBrowser({ startCostMs });
      try { measured.push(await measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, SERVER_PROFILE.browserScenes[0])); }
      finally { fake.dispose(); }
    }
    const values = pairs();
    const target = values.find((cell) => cell.id === 's2:startMs')!;
    const smallStage = stage();
    for (const row of smallStage.rows.filter((row) => row.scene === 's2')) row.samples = { left: measured[0], right: measured[1] };
    const actual = serverCellPairs(smallStage, 2, 'aa').find((cell) => cell.id === target.id)!;
    target.left.fill(actual.left[0]); target.right.fill(actual.right[0]);
    target.leftBounds.fill(actual.leftBounds[0]); target.rightBounds.fill(actual.rightBounds[0]);
    const contrast = serverFamilyIntervals(values).find((cell) => cell.id === target.id)!;
    expect(contrast.p95.high).toBeGreaterThan(SERVER_PROFILE.nonInferiorityUpper);
    expect(contrast.p95.baseline.low).toBeLessThanOrEqual(0.025);
    expect(contrast.p95.candidate.high!).toBeGreaterThanOrEqual(0.027);
  });

  it('обе стороны dither/floor и binary64 error остаются в pointwise envelope', () => {
    const q = 0.005;
    for (let index = 0; index < 100; index++) {
      const begin = index * 0.00017, duration = index % 2 ? 0.8 : 0.864;
      const clamp = (time: number) => Math.floor(time / q) * q + ((time / q - Math.floor(time / q)) >= 0.23 ? q : 0);
      const bound = serverBrowserClockBounds({ beginMs: clamp(begin), endMs: clamp(begin + duration) }, '1000000000000');
      expect(bound.low).toBeLessThanOrEqual(duration); expect(bound.high).toBeGreaterThanOrEqual(duration);
    }
    const bootMs = 2 ** 41, originMs = bootMs - 100;
    const physicalBeginUs = BigInt(bootMs) * 1000n + 500n, physicalEndUs = physicalBeginUs + 864n;
    const interval = { beginMs: Number(physicalBeginUs) / 1000 - originMs, endMs: Number(physicalEndUs) / 1000 - originMs };
    const bound = serverBrowserClockBounds(interval, ((physicalEndUs + 1000n) * 1000n).toString());
    expect(bound.low).toBeLessThanOrEqual(0.864); expect(bound.high).toBeGreaterThanOrEqual(0.864);
    expect(() => serverBrowserClockBounds(interval, '-1')).toThrow();
    expect(() => serverBrowserClockBounds(interval, (BigInt(SERVER_PROFILE.clockError.monotonicCounterLimitMs) * 1_000_000n).toString())).toThrow();
  });

  it('не усредняет clock error как noise и не допускает неразрешимую A/A', () => {
    const value = pairs();
    for (const cell of value) {
      cell.leftBounds.fill({ low: 96, high: 104 }); cell.rightBounds.fill({ low: 96, high: 104 });
    }
    const intervals = serverFamilyIntervals(value);
    expect(intervals.every((cell) => cell.p95.high! >= 104 / 96)).toBe(true);
    expect(serverCalibrationVerdict(intervals, serverFamilyIntervals(pairs(SERVER_PROFILE.minRuns, 2)), planServerSampleSize(pairs(SERVER_PROFILE.pilotRuns))).verdict).toBe('UNPROVEN');
    delete (value[0] as any).leftBounds;
    expect(() => serverFamilyIntervals(value)).toThrow(/pointwise/);
  });

  it('normal-motion RLE сохраняет все targets и отвергает snap с valid:true', () => {
    const value = stage();
    const sample = value.rows.find((row) => row.scene === 's3')!.samples.left;
    sample.semanticEvidence = compactServerSemanticEvidence(sample.semanticEvidence);
    expect(() => validateServerBrowserSample(sample, SERVER_PROFILE.browserScenes[1])).not.toThrow();
    sample.semanticEvidence.checkpoints[0].groups[0].positions.runs = [[SERVER_PROFILE.browserScenes[1].targetsPerCall, 300]];
    expect(() => validateServerBrowserSample(sample, SERVER_PROFILE.browserScenes[1])).toThrow(/normal-motion/);
  });

  it('failed browser batch сохраняет acquired operation, open cancel и undefined cause', async () => {
    const fake = syntheticBrowser({ cancelAt: 3 });
    try {
      const error: any = await measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, SERVER_PROFILE.browserScenes[0]).catch((error) => error);
      expect(error.errors).toEqual([undefined]);
      const row = error.raw.partial.find((row: any) => row.phase === 'batch-cancel-failed');
      expect(row.batchStartMs).toBeGreaterThan(0); expect(row.ownersStarted).toBe(32); expect(row.ownersCancelled).toBe(0);
      expect(row.unfinishedCancelClock.endMs).toBeGreaterThanOrEqual(row.unfinishedCancelClock.beginMs);
      expect(row.error).toEqual({ name: 'undefined', message: 'undefined' });
    } finally { fake.dispose(); }
    const rejection = syntheticBrowser({ rejectTiming: true });
    try {
      const error: any = await measureServerBrowser(rejection.browser, { url: 'synthetic://profile' }, rejection.adapter, SERVER_PROFILE.browserScenes[0]).catch((error) => error);
      expect(error.errors).toEqual([undefined]); expect(error.raw.partial.some((row: any) => row.phase === 'normal-motion')).toBe(true);
    } finally { rejection.dispose(); }
  });

  it('итоговая сериализация сохраняет JSON identity и не требует общей строки V8', () => {
    const value = { a: [{ raw: [1, undefined, 3] }], missing: undefined, nested: { b: 'данные', c: null } };
    expect([...serverArtifactChunks(value)].join('')).toBe(`${JSON.stringify(value)}\n`);
    const large = { rows: Array(5400).fill({ data: 'a'.repeat(100_000) }) };
    let bytes = 0, maxChunkBytes = 0;
    for (const chunk of serverArtifactChunks(large)) { const count = Buffer.byteLength(chunk); bytes += count; maxChunkBytes = Math.max(maxChunkBytes, count); }
    expect(bytes).toBeGreaterThan(2 ** 29); expect(maxChunkBytes).toBeLessThan(101_000);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'motion-server-json-'));
    try {
      const file = path.join(directory, 'artifact.json'); const result = writeServerArtifact(file, value);
      expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(value)}\n`);
      expect(result.sha256).toBe(serverArtifactDigest(value)); expect(result.bytes).toBe(Buffer.byteLength(readFileSync(file)));
      expect(() => writeServerArtifact(file, value)).toThrow(/EEXIST/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('серверный PROFILE: заранее зарегистрированные границы', () => {
  it('не выдаёт server CPU за mobile/GPU/экран или продуктовые семейства', () => {
    expect(SERVER_PROFILE.unproven).toContain('mobile Android/iOS');
    expect(SERVER_PROFILE.unproven).toContain('whole-page energy');
    expect(SERVER_PROFILE.unproven).toContain('M-05 product scene families');
    expect(SERVER_PROFILE.nonInferiorityUpper).toBe(1.05);
    expect(verifyServerProfile(clone(SERVER_PROFILE))).toBeUndefined();
    const changed: any = clone(SERVER_PROFILE); changed.nonInferiorityUpper = 1.06;
    expect(() => verifyServerProfile(changed)).toThrow();
  });

  it('выводит N из независимых baseline blocks и сохраняет невозможную мощность', () => {
    expect(planServerSampleSize(pairs(SERVER_PROFILE.pilotRuns))).toMatchObject({ runs: 292, feasible: true });
    const noisy = pairs(SERVER_PROFILE.pilotRuns);
    noisy[0].right = [100, 100, 1000, 1000, 10, 10, 100, 100];
    expect(planServerSampleSize(noisy)).toMatchObject({ runs: SERVER_PROFILE.maxRuns, feasible: false });
    expect(() => planServerSampleSize(noisy.slice(1))).toThrow();
    noisy[0].left.pop(); expect(() => planServerSampleSize(noisy)).toThrow();
  });

  it('family-wise CI различает тождественный build, реальную регрессию и 2×work', () => {
    const aa = serverFamilyIntervals(pairs());
    const positive = serverFamilyIntervals(pairs(SERVER_PROFILE.minRuns, 2));
    expect(aa.every((x) => x.p95.high >= 1 && x.p95.high! < 1 + 1e-12 && x.p95.low <= 1 && x.p95.low > 1 - 1e-12)).toBe(true);
    expect(positive.every((x) => x.p50.low <= 2 && x.p50.low > 2 - 1e-12)).toBe(true);
    const plan = planServerSampleSize(pairs(SERVER_PROFILE.pilotRuns));
    expect(serverCalibrationVerdict(aa, positive, plan).verdict).toBe('PASS');
    const regression = serverFamilyIntervals(pairs(SERVER_PROFILE.minRuns, 1.08));
    expect(serverCalibrationVerdict(regression, positive, plan).verdict).toBe('UNPROVEN');
    expect(serverCalibrationVerdict(aa, aa, plan).verdict).toBe('UNPROVEN');
    expect(serverCalibrationVerdict(aa, positive, { ...plan, feasible: false }).verdict).toBe('UNPROVEN');
    expect(() => serverFamilyIntervals(pairs().slice(1))).toThrow();
    const zero = pairs(); zero[0].left[0] = 0;
    expect(() => serverFamilyIntervals(zero)).toThrow();
  });

  it('не даёт finite p95 upper короткой серии, пропускающей редкий 2×stall', () => {
    const short = serverFamilyIntervals(pairs(20));
    expect(0.94 ** 10).toBeGreaterThan(SERVER_PROFILE.familyAlpha);
    expect(short.every((cell) => !cell.p95.bounded && cell.p95.high === null)).toBe(true);
    const policy = serverTailPolicy();
    expect(policy.alphaPerTail).toBe(1 / 1760);
    expect(policy.minimumBlocks).toBe(146);
    expect(serverOrderStatisticBounds(Array(145).fill(1), 0.95, policy.alphaPerTail).high).toBeNull();
    expect(serverOrderStatisticBounds(Array(146).fill(1), 0.95, policy.alphaPerTail).high).toBe(1);
    expect(19n ** 146n * 1760n <= 20n ** 146n).toBe(true);
    expect(19n ** 145n * 1760n <= 20n ** 145n).toBe(false);
  });
});

describe('серверный PROFILE: независимые sabotage controls', () => {
  it('восстанавливает метрику из raw и не делит deliberate 2×work на два', () => {
    const result = serverCellPairs(stage('positive'), 2, 'positive');
    expect(result.every((x) => x.right[0] === x.left[0] * 2)).toBe(true);
    const changed = stage('positive');
    changed.rows[0].samples.right.meanFrameNs /= 2;
    expect(() => serverCellPairs(changed, 2, 'positive')).toThrow(/знаменателя/);
  });

  it.each(['missing', 'duplicate', 'order', 'nonfinite', 'denominator', 'semantic', 'clock', 'endpoint'])('отвергает %s evidence', (mutation) => {
    const value = stage();
    const engine = value.rows.find((row) => row.kind === 'engine')!;
    const browser = value.rows.find((row) => row.kind === 'browser')!;
    if (mutation === 'missing') delete engine.samples.left;
    if (mutation === 'duplicate') value.rows[1] = value.rows[0];
    if (mutation === 'order') engine.order.reverse();
    if (mutation === 'nonfinite') engine.samples.left.raw[0].operationNs = NaN;
    if (mutation === 'denominator') engine.samples.left.repetitions *= 2;
    if (mutation === 'semantic') engine.samples.left.raw[0].semantic.pending = 1;
    if (mutation === 'clock') browser.samples.left.measurementTimeOriginMs += 1;
    if (mutation === 'endpoint') browser.samples.left.endpoints[0] = 0;
    expect(() => serverCellPairs(value, 2, 'aa')).toThrow();
  });

  it('регистрация и frozen N действительно предшествуют samples', () => {
    const artifact: any = { registration: null, registrationDigest: null, verdict: 'UNPROVEN', failures: [{ stage: 'preparation', error: { message: 'нет среды' } }] };
    function journal(events: any[]) {
      let previous = '0'.repeat(64);
      return events.map((event) => {
        const payload = { sequenceDigest: previous, ...event };
        previous = serverProfileDigest(payload); return { ...payload, digest: previous };
      });
    }
    const failure = { type: 'failure', value: artifact.failures[0] };
    const finished = { type: 'finished', value: { verdict: artifact.verdict, digest: serverArtifactDigest(artifact) } };
    expect(validateServerJournal(artifact, journal([failure, finished]))).toHaveProperty('journalFinalDigest');
    const sample = { type: 'sample', value: { stage: 'ab', scene: 's2', run: 0, participant: 'right', build: 'candidate', value: {} } };
    expect(() => validateServerJournal(artifact, journal([sample, failure, finished]))).toThrow(/до preregistration/);
    expect(() => validateServerJournal(artifact, journal([finished]))).toThrow(/failures/);
    const broken = journal([failure, finished]); broken[0].digest = 'b'.repeat(64);
    expect(() => validateServerJournal(artifact, broken)).toThrow(/цепь/);
  });

  it('допущенный UNPROVEN всё равно проверяет поздние body hashes после failure/chronology', () => {
    const artifact: any = { registration: null, registrationDigest: null, verdict: 'UNPROVEN', failures: [{ stage: 'preparation', error: { message: 'сохранённый отказ' } }] };
    const events = [{ type: 'failure', value: artifact.failures[0] }, { type: 'finished', value: { verdict: artifact.verdict, digest: serverArtifactDigest(artifact) } }];
    const healthy = chain(events);
    expect(validateServerJournal(artifact, healthy)).toHaveProperty('journalFinalDigest');
    const malformed = clone(healthy); malformed[1].digest = 'b'.repeat(64);
    expect(() => validateServerJournal(artifact, malformed)).toThrow(/цепь/);
    const changedBody = clone(healthy); changedBody[1].unclaimed = 'body должен хешироваться целиком';
    expect(() => validateServerJournal(artifact, changedBody)).toThrow(/цепь/);
  });

  it('имя positive не позволяет спрятать одиночную работу; RLE не доверяет чужой длине', () => {
    const positive = stage('positive'); positive.name = 'aa';
    expect(() => serverCellPairs(positive, 2, 'positive')).toThrow(/имя стадии/);
    const wrongCount = stage(); wrongCount.rows[0].samples.left.raw[0].semantic.targetTraceHashes.count -= 1;
    expect(() => serverCellPairs(wrongCount, 2, 'aa')).toThrow(/hash RLE|lifecycle witness/);
  });

  it.each(['waapi', 'transform', 'disconnected', 'missing-frame', 'RLE-length', 'generic-RLE-length'])('cancel witness отвергает %s sabotage', (mutation) => {
    const value = stage();
    const witness = value.rows.find((row) => row.kind === 'browser')!.samples.left.raw[0].cancelWitness;
    if (mutation === 'waapi') witness.frames[0].activeWaapi = 1;
    if (mutation === 'transform') witness.frames[1].transforms.value = 1;
    if (mutation === 'disconnected') witness.frames[0].connectedTargets -= 1;
    if (mutation === 'missing-frame') witness.frames.pop();
    if (mutation === 'RLE-length') witness.transformsBefore.count -= 1;
    if (mutation === 'generic-RLE-length') witness.transformsBefore = { encoding: 'rle', count: witness.connectedTargets, runs: [[witness.connectedTargets - 1, 0]] };
    expect(() => serverCellPairs(value, 2, 'aa')).toThrow(/cancel/);
  });

  it('завершённый public admission отвергает четыре независимых reviewer counterexamples', () => {
    const history = admissionHistory(), { artifact, events } = history;
    expect(validateServerArtifact(artifact).verdict).toBe('PASS');
    expect(validateServerJournal(artifact, history.records)).toHaveProperty('journalFinalDigest');
    const earlyCalibration = events.filter((event) => event.type !== 'calibration');
    earlyCalibration.splice(earlyCalibration.findIndex((event) => event.type === 'N-frozen-before-calibration-and-AB') + 1, 0,
      { type: 'calibration', value: artifact.calibration });
    expect(() => validateServerJournal(artifact, chain(earlyCalibration, history))).toThrow(/до завершения/);
    const alwaysLeft = [...events];
    const firstOpposite = alwaysLeft.findIndex((event) => event.type === 'sample' && event.value.participant === 'right');
    [alwaysLeft[firstOpposite], alwaysLeft[firstOpposite + 1]] = [alwaysLeft[firstOpposite + 1], alwaysLeft[firstOpposite]];
    expect(() => validateServerJournal(artifact, chain(alwaysLeft, history))).toThrow(/порядок/);
    const ignoredFailure = [...events.slice(0, -1), { type: 'failure', value: { stage: 'ab', error: { message: 'retained reviewer failure' } } }, events.at(-1)];
    expect(() => validateServerJournal(artifact, chain(ignoredFailure, history))).toThrow(/failures/);
    const wrongPositive = { ...artifact, positive: { ...artifact.positive, name: 'aa' } };
    expect(() => validateServerArtifact(wrongPositive)).toThrow(/имя стадии/);
    const wrongFinish = [...events.slice(0, -1), { type: 'finished', value: { verdict: 'PASS', digest: 'b'.repeat(64) } }];
    expect(() => validateServerJournal(artifact, chain(wrongFinish, history))).toThrow(/финальная/);
  }, 30_000);

  it('сохраняет partial A/B и поздний отказ, а пропавшие comparator/retention не допускает', () => {
    const history = admissionHistory(), complete = history.artifact;
    // Меняются только принадлежащие отказу ветви. Полная unchanged история
    // Полный зарегистрированный N остаётся входом, без трёх лишних копий raw.
    const partial: any = { ...complete, verdict: 'UNPROVEN', ab: { ...complete.ab } };
    const completeEvents = history.events;
    const firstAb = completeEvents.findIndex((event) => event.type === 'sample' && event.value.stage === 'ab');
    const failed = completeEvents[firstAb + 1].value;
    const error = { name: 'Error', message: 'timeout второго участника; первый raw сохранён', raw: { completed: [] } };
    partial.failures = [{ stage: 'ab', error }];
    partial.ab.rows = [{ ...partial.ab.rows[0], samples: { [completeEvents[firstAb].value.participant]: completeEvents[firstAb].value.value } }];
    partial.ab.blocks = []; delete partial.comparison; delete partial.comparators; delete partial.retention;
    const partialEvents = [...completeEvents.slice(0, firstAb + 1), { type: 'failed-sample', value: { ...failed, value: undefined, error } },
      { type: 'failure', value: partial.failures[0] }, { type: 'finished', value: { verdict: 'UNPROVEN', digest: serverArtifactDigest(partial) } }];
    expect(validateServerArtifact(partial).verification).toBe('partial-samples-refused');
    expect(validateServerJournal(partial, chain(partialEvents, history))).toHaveProperty('journalFinalDigest');
    const missingFailure = partialEvents.filter((event) => event.type !== 'failure');
    expect(() => validateServerJournal(partial, chain(missingFailure, history))).toThrow(/failures/);

    const late: any = { ...complete, verdict: 'UNPROVEN' };
    const firstComparator = completeEvents.findIndex((event) => event.type === 'comparator-sample');
    const comparatorFailure = completeEvents[firstComparator + 1].value;
    late.failures = [{ stage: 'ab', error }]; late.comparators = [{ ...late.comparators[0], rows: [late.comparators[0].rows[0]] }];
    delete late.retention;
    const lateEvents = [...completeEvents.slice(0, firstComparator + 1), { type: 'failed-comparator-sample', value: { ...comparatorFailure, stage: 'ab', error } },
      { type: 'failure', value: late.failures[0] }, { type: 'finished', value: { verdict: 'UNPROVEN', digest: serverArtifactDigest(late) } }];
    expect(validateServerArtifact(late).verification).toBe('completed-samples-refused');
    expect(validateServerJournal(late, chain(lateEvents, history))).toHaveProperty('journalFinalDigest');

    const dropped: any = { ...complete, retention: { ...complete.retention } }; delete dropped.retention.candidate;
    expect(() => validateServerArtifact(dropped)).toThrow(/retention/);
    const omitted = completeEvents.filter((event) => event.type !== 'comparator-sample');
    expect(() => validateServerJournal(complete, chain(omitted, history))).toThrow(/retention/);
  }, 30_000);

  it('сохраняет историческое throttle отдельно от DELTA и закрывает нарушение условий', () => {
    const value = stage();
    for (const block of value.blocks) {
      block.before.cpuStat.nr_throttled = 7755; block.after.cpuStat.nr_throttled = 7755;
    }
    const identity = { affinity: '0', cgroupCpuMax: '400000 100000' };
    expect(serverResourceReasons([value], identity)).toEqual([]);
    value.blocks[0].after.cpuStat.nr_throttled += 1; value.blocks[0].delta.nr_throttled = 1;
    expect(serverResourceReasons([value], identity)[0]).toMatch(/throttling/);
    value.blocks[0].delta.nr_throttled = 0;
    expect(() => serverResourceReasons([value], identity)).toThrow(/delta/);
  });

  it('stable drift между блоками/стадиями не заменяет зарегистрированные CPU/quota', () => {
    const value = stage('aa', 4), identity = { affinity: '0', cgroupCpuMax: '400000 100000' };
    value.blocks[1].before.affinity = '1'; value.blocks[1].after.affinity = '1';
    expect(serverResourceReasons([value], identity)).toContain('aa: block 1 отличается от зарегистрированных affinity/quota');
    value.blocks[1].before.affinity = '0'; value.blocks[1].after.affinity = '0';
    value.blocks[1].before.cpuMax = '200000 100000'; value.blocks[1].after.cpuMax = '200000 100000';
    expect(serverResourceReasons([value], identity)).toContain('aa: block 1 отличается от зарегистрированных affinity/quota');
    const later = stage('positive'); later.blocks[0].before.cpuMax = 'max 100000'; later.blocks[0].after.cpuMax = 'max 100000';
    expect(serverResourceReasons([stage(), later], identity)).toContain('positive: block 0 отличается от зарегистрированных affinity/quota');
  });

  it('потерянные provenance и неопределённая calibration не становятся PASS', () => {
    const refusal: any = { schema: 1, protocol: SERVER_PROFILE, registration: null, registrationDigest: null,
      verdict: 'UNPROVEN', failures: [{ stage: 'preparation', error: { message: 'нет browser' } }] };
    expect(validateServerArtifact(refusal)).toMatchObject({ verification: 'preparation-refused' });
    for (const mutation of [
      (x: any) => { x.verdict = 'PASS'; }, (x: any) => { x.ab = {}; },
      (x: any) => { x.failures = []; }, (x: any) => { x.registration = {}; },
    ]) {
      const changed = clone(refusal); mutation(changed);
      expect(() => validateServerArtifact(changed)).toThrow();
    }
  });

  it.each(['baseline', 'dirty', 'pnpm', 'dist', 'lock', 'binary', 'vendor', 'affinity', 'browser', 'transitive'])('не принимает подменённый %s provenance даже с новым digest', (mutation) => {
    const value: any = clone(registeredRefusal());
    expect(validateServerArtifact(value).verification).toBe('recorded-refusal-only');
    if (mutation === 'baseline') value.registration.provenance.baseline.revision = 'c'.repeat(40);
    if (mutation === 'dirty') value.registration.provenance.candidate.dirty = true;
    if (mutation === 'pnpm') value.registration.provenance.baseline.environment.pnpm = '11.19.0';
    if (mutation === 'dist') delete value.registration.provenance.candidate.distRuntime;
    if (mutation === 'lock') delete value.registration.provenance.baseline.inputs['root/pnpm-lock.yaml'];
    if (mutation === 'binary') delete value.registration.provenance.baseline.environment.nodeExecutableSha256;
    if (mutation === 'vendor') delete value.registration.packages.motion.tarballSha256;
    if (mutation === 'affinity') {
      value.registration.machine.identity.affinity = '0-4'; value.registration.machine.sha256 = serverProfileDigest(value.registration.machine.identity);
    }
    if (mutation === 'browser') delete value.registration.browserTree.sha256;
    if (mutation === 'transitive') delete value.registration.transitivePackages;
    value.registrationDigest = serverProfileDigest(value.registration);
    expect(() => validateServerArtifact(value)).toThrow();
  });

  it('timing не включает forced GC, retention остаётся в отдельном child process', () => {
    const runner = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8');
    const retention = readFileSync(new URL('../bench/profile/server-profile-retention.mjs', import.meta.url), 'utf8');
    expect(runner).not.toMatch(/globalThis\.gc\s*\(/);
    expect(retention).toMatch(/globalThis\.gc\(\)/);
    expect(runner).toContain("['--expose-gc'");
  });
});

describe('PROFILE: ресурсный контракт проверяется до регистрации и samples', () => {
  const keys = ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'];
  const healthy = { usage_usec: 100, user_usec: 70, system_usec: 30, nr_periods: 20, nr_throttled: 2, throttled_usec: 50 };
  function machine(quota: string | null = '400000 100000', counters: Record<string, number> = healthy) {
    const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8');
    const common = source.slice(source.indexOf('function readOptional('), source.indexOf('async function withBrowserTimeout('));
    const capture = source.slice(source.indexOf('export function captureServerMachine('), source.indexOf('export function createServerJournal(')).replace(/^export /, '');
    const files: Record<string, string> = {
      '/proc/self/status': 'Cpus_allowed_list:\t0\nvoluntary_ctxt_switches:\t2\nnonvoluntary_ctxt_switches:\t3\n',
      '/sys/fs/cgroup/cpu.stat': Object.entries(counters).map(([key, value]) => `${key} ${value}`).join('\n') + '\n',
    };
    if (quota !== null) files['/sys/fs/cgroup/cpu.max'] = quota;
    const hashBinary = vi.fn(() => hash);
    // Исполняем точные функции владельца. Независимый FS задаёт отсутствующие
    // controller/counters; VM не запускает пакеты, браузер или измерение CPU.
    const realm = createContext({
      readFileSync(file: string) { if (!Object.hasOwn(files, file)) throw new Error('нет файла фикстуры ' + file); return files[file]; },
      existsSync: (file: string) => Object.hasOwn(files, file), loadavg: () => [0, 0, 0],
      platform: () => 'linux', release: () => '6.18.44', arch: () => 'x64', hostname: () => 'fixture',
      cpus: () => [{ model: 'fixture' }], totalmem: () => 1024, sha256File: hashBinary, serverProfileDigest,
      process: { version: 'v24.19.0', execPath: '/fixture/node', execArgv: [], memoryUsage: () => ({ heapUsed: 1 }) },
    });
    return { capture: runInContext(`${common}\n${capture}\ncaptureServerMachine;`, realm), hashBinary };
  }

  it('принимает шесть полных счётчиков, включая честное историческое throttling', () => {
    const fixture = machine(), captured = fixture.capture();
    expect(captured.identity.affinity).toBe('0');
    expect(captured.identity.cgroupCpuMax).toBe('400000 100000');
    expect(captured.sha256).toBe(serverProfileDigest(captured.identity));
    expect(fixture.hashBinary).toHaveBeenCalledTimes(1);
  });

  it.each([null, '', ' \n'])('отвергает cpu.max=%j до hashing/setup', (quota) => {
    const fixture = machine(quota);
    let failure: any;
    try { fixture.capture(); } catch (error) { failure = error; }
    expect(failure?.message).toMatch(/cpu\.max.*до samples/);
    expect(failure.raw.cgroupCpuMax).toBe(quota === null ? null : '');
    expect(fixture.hashBinary).not.toHaveBeenCalled();
  });

  it.each(keys.flatMap((key) => ['missing', 'negative', 'fractional', 'overflow', 'nonfinite'].map((fault) => ({ key, fault }))))(
    'отвергает cpu.stat $key/$fault до hashing/setup', ({ key, fault }) => {
      const counters: Record<string, number> = { ...healthy };
      if (fault === 'missing') delete counters[key];
      else {
        const invalid: Record<string, number> = { negative: -1, fractional: 0.5, overflow: Number.MAX_SAFE_INTEGER + 1, nonfinite: Infinity };
        counters[key] = invalid[fault]!;
      }
      const fixture = machine('400000 100000', counters);
      let failure: any;
      try { fixture.capture(); } catch (error) { failure = error; }
      expect(failure?.message).toMatch(/cpu\.stat.*до samples/);
      expect(failure.raw.resource.cpuMax).toBe('400000 100000');
      expect(Number.isSafeInteger(failure.raw.resource.cpuStat[key]) && failure.raw.resource.cpuStat[key] >= 0).toBe(false);
      expect(fixture.hashBinary).not.toHaveBeenCalled();
    });
});

describe('серверный PROFILE: native scheduled CPU endpoints', () => {
  const scene = SERVER_PROFILE.engineScenes[1];
  const nativeSample = () => {
    const sample: any = stage().rows.find((row) => row.scene === scene.id)!.samples.left;
    sample.cpuClock = { ...syntheticCpuIdentity };
    for (const measured of sample.raw) measured.raw.cpuReads = measured.raw.clockReads.map((read: any) => nativeCpuEndpoint(read));
    return sample;
  };
  it('принимает полные native timespec и main-thread IDs без user/system fields', () => {
    const sample = nativeSample();
    expect(() => validateServerEngineSample(sample, scene)).not.toThrow();
  });
  it('старые Node user/system counters не становятся native clock после переименования', () => {
    const sample = nativeSample();
    for (const measured of sample.raw) measured.raw.cpuReads = measured.raw.clockReads.map((read: any) => ({
      sequence: read.sequence, ...syntheticCpuIdentity, userUs: Number(read.valueNs) / 1000, systemUs: 0, valueNs: read.valueNs }));
    expect(() => validateServerEngineSample(sample, scene)).toThrow(/CPU|native|timespec/);
  });
  it.each(['missing-sample-identity', 'wrong-clock', 'wrong-endpoint-clock', 'missing-seconds', 'negative-seconds', 'noncanonical-seconds', 'overflow-seconds',
    'fractional-nanoseconds', 'negative-nanoseconds', 'negative-zero-nanoseconds', 'overflow-nanoseconds', 'missing-native-read', 'value-mismatch',
    'clock-read-mismatch', 'wrong-sequence', 'wrong-pid', 'wrong-tid', 'worker-thread', 'later-repetition-identity', 'later-repetition-backwards'])
  ('отвергает %s при coherent semantic:true', (fault) => {
    const sample = nativeSample(), lineage = sample.raw[0].raw, read = lineage.cpuReads[1];
    expect(() => validateServerEngineSample(sample, scene)).not.toThrow();
    if (fault === 'missing-sample-identity') delete sample.cpuClock;
    if (fault === 'wrong-clock') sample.cpuClock.clock = 'process.threadCpuUsage';
    if (fault === 'wrong-endpoint-clock') read.clock = 'CLOCK_PROCESS_CPUTIME_ID';
    if (fault === 'missing-seconds') delete read.seconds;
    if (fault === 'negative-seconds') read.seconds = '-1';
    if (fault === 'noncanonical-seconds') read.seconds = '00';
    if (fault === 'overflow-seconds') read.seconds = '9223372036854775808';
    if (fault === 'fractional-nanoseconds') read.nanoseconds += 0.5;
    if (fault === 'negative-nanoseconds') read.nanoseconds = -1;
    if (fault === 'negative-zero-nanoseconds') read.nanoseconds = -0;
    if (fault === 'overflow-nanoseconds') read.nanoseconds = 1_000_000_000;
    if (fault === 'missing-native-read') lineage.cpuReads.pop();
    if (fault === 'value-mismatch') read.valueNs = String(BigInt(read.valueNs) + 1n);
    if (fault === 'clock-read-mismatch') lineage.clockReads[1].valueNs = String(BigInt(read.valueNs) + 1n);
    if (fault === 'wrong-sequence') read.sequence = 0;
    if (fault === 'wrong-pid') read.pid++;
    if (fault === 'wrong-tid') read.tid++;
    if (fault === 'worker-thread') {
      sample.cpuClock.tid++;
      for (const measured of sample.raw) for (const value of measured.raw.cpuReads) value.tid = sample.cpuClock.tid;
    }
    if (fault === 'later-repetition-identity') for (const value of sample.raw[1].raw.cpuReads) { value.pid++; value.tid++; }
    if (fault === 'later-repetition-backwards') {
      const later = sample.raw[1].raw;
      for (const value of later.clockReads) value.valueNs = String(BigInt(value.valueNs) - 100_000_000n);
      later.cpuReads = later.clockReads.map((value: any) => nativeCpuEndpoint(value));
    }
    expect(() => validateServerEngineSample(sample, scene)).toThrow(/CPU|native|timespec|lineage/);
  });
  it('exact seconds выше2^53 не проходят через Number', () => {
    const sample = nativeSample(), shift = 9_007_199_254_740_993n * 1_000_000_000n;
    for (const measured of sample.raw) {
      for (const value of measured.raw.clockReads) value.valueNs = String(BigInt(value.valueNs) + shift);
      measured.raw.cpuReads = measured.raw.clockReads.map((value: any) => nativeCpuEndpoint(value));
    }
    expect(sample.raw[0].raw.cpuReads[0].seconds).toBe('9007199254740993');
    expect(() => validateServerEngineSample(sample, scene)).not.toThrow();
  });
  it('native1ns timespec изменение сохраняется и не требует старой user/system grid', () => {
    const sample = nativeSample(), measured = sample.raw[0];
    measured.raw.clockReads[1].valueNs = '11000001';
    measured.raw.cpuReads[1] = nativeCpuEndpoint(measured.raw.clockReads[1]);
    measured.operationNs = 1_000_001;
    sample.operationNs = 1_000_000.125;
    expect(() => validateServerEngineSample(sample, scene)).not.toThrow();
    expect(SERVER_PROFILE.clockError.engineCounterOutwardPaddingNs).toBe(2000);
  });
  it('same-object mutation main-thread metadata проверяется заново', () => {
    const current = stage();
    const cell = serverCellPairs(current, 2, 'aa', syntheticCpuIdentity).find((cell) => cell.scene === scene.id)!;
    expect(cell.left[0]).toBe(1_000_000);
    const sample = current.rows.find((row) => row.scene === scene.id)!.samples.left;
    sample.cpuClock.pid++; sample.cpuClock.tid++;
    for (const measured of sample.raw) for (const value of measured.raw.cpuReads) { value.pid++; value.tid++; }
    expect(() => serverCellPairs(current, 2, 'aa', syntheticCpuIdentity)).toThrow(/зарегистрированным main-thread/);
  });
  it.each(['missing-clock', 'wrong-clock', 'worker-thread', 'node', 'napi', 'source', 'header', 'source-digest',
    'native-binary', 'compiler', 'compiler-flags', 'libc', 'missing-nominal', 'physical-certificate'])
  ('native registration отвергает %s до samples', (fault) => {
    const registration: any = registeredRefusal().registration;
    expect(() => verifyServerClockRegistration(registration)).not.toThrow();
    const clock = registration.engineClock;
    if (fault === 'missing-clock') delete registration.engineClock;
    if (fault === 'wrong-clock') clock.clock = 'process.threadCpuUsage';
    if (fault === 'worker-thread') clock.tid++;
    if (fault === 'node') clock.node.executableSha256 = hash;
    if (fault === 'napi') clock.napiVersion = 9;
    if (fault === 'source' || fault === 'header') {
      const key = fault === 'source' ? 'bench/profile/server-thread-cpu-clock.c' : 'bench/profile/native-clock/include/node_api.h';
      clock.nativeSources[key] = hash;
      clock.nativeSourceDigest = serverProfileDigest(Object.fromEntries(Object.entries(clock.nativeSources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    }
    if (fault === 'source-digest') clock.nativeSourceDigest = hash;
    if (fault === 'native-binary') delete clock.nativeBinary.sha256;
    if (fault === 'compiler') delete clock.compiler.binarySha256;
    if (fault === 'compiler-flags') clock.compiler.flags = [];
    if (fault === 'libc') delete clock.libc.sha256;
    if (fault === 'missing-nominal') delete clock.nominalResolutionNs;
    if (fault === 'physical-certificate') clock.nominalResolutionIsNotErrorCertificate = false;
    expect(() => verifyServerClockRegistration(registration)).toThrow(/CPU|native/);
  });
});
