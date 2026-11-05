import { describe, expect, it, vi, type TestContext } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import * as filesystem from 'node:fs';
import * as childProcess from 'node:child_process';
import * as nodeModule from 'node:module';
import * as provenanceOwner from '../bench/compare/provenance.mjs';
import * as compareOwner from '../bench/compare/bench.mjs';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SERVER_PROFILE, planServerSampleSize, serverProfileDigest, serverTailPolicy, verifyServerProfile } from '../bench/profile/server-profile-registration.mjs';
import { serverCalibrationVerdict, serverCellPairs, serverFamilyIntervals, serverMetricCells, serverOrders,
  compactServerCpuEvidence, expandServerCpuEvidence, compactServerSemanticEvidence, serverArtifactChunks, serverArtifactDigest, serverBrowserClockBounds, serverBrowserSemanticClockErrorMs, serverOrderStatisticBounds, serverResourceReasons,
  parseServerJsonBytes, parseServerJournalBytes, validateServerArtifact, validateServerBrowserSample, validateServerEngineSample, validateServerJournal,
  serverResourceBinding, validateServerResourceIdentity, verifyServerClockBuildEvidence, verifyServerClockRegistration } from '../bench/profile/server-profile-contract.mjs';
import { writeServerArtifact } from '../bench/profile/server-profile-artifact.mjs';
import { compactStockMotionValueOutcomes, deriveRealmTimerStep, evaluateStartSemanticEvidence, validateStockMotionValueBatch } from '../bench/compare/methodology.mjs';
import { measureServerBrowser, measureServerEngine, runServerProfile, runServerProfileCalibration } from '../bench/profile/server-profile-runner.mjs';
import * as threadCpuClock from '../bench/profile/server-thread-cpu-clock.mjs';

const hash = 'a'.repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
const qualifiedConfig = readFileSync(new URL('./fixtures/server-profile-azure.config', import.meta.url), 'utf8');
function healthyClockBuildEvidence() {
  const model = SERVER_PROFILE.clockError, build = model.kernelBuild;
  const namespaces = { '/proc/self/ns/time': { target: 'time:[4026531834]' },
    '/proc/self/ns/time_for_children': { target: 'time:[4026531834]' },
    '/proc/1/ns/time': { error: { code: 'EACCES', message: 'not required by model' } } };
  return { files: { '/proc/version': { text: 'qualified kernel diagnostics' }, '/proc/cmdline': { text: 'unrelated boot diagnostics' },
    '/proc/version_signature': { text: `Ubuntu ${build.sourceVersion}-azure ${build.upstreamVersion}\n` },
    [`/boot/config-${model.kernelRelease}`]: { text: qualifiedConfig },
    '/proc/self/timens_offsets': { text: 'monotonic           0         0\nboottime            0         0\n' },
    '/proc/1/timens_offsets': { text: 'monotonic           0         0\nboottime            0         0\n' } }, namespaces,
    packages: ['image', 'modules'].map(kind => {
      const name = `linux-${kind}-${model.kernelRelease}`;
      const source = kind === 'modules' ? build.sourcePackage : build.sourcePackage.replace(/^linux-/, 'linux-signed-');
      return { command: 'dpkg-query', args: ['-W', '-f=${binary:Package} ${Version} ${source:Package} ${source:Version}\n', name],
        status: 0, signal: null, stdout: `${name} ${build.sourceVersion} ${source} ${build.sourceVersion}\n`, stderr: '' };
    }) };
}
const buildFaults = ['config', 'signature', 'modules-package', 'image-package', 'missing-witness', 'missing-config', 'read-error',
  'query-error', 'query-signal', 'missing-package', 'duplicate-package', 'missing-signature', 'missing-namespace', 'namespace-error',
  'children-namespace', 'self-offset', 'init-offset', 'missing-offset', 'malformed-offset'] as const;
function mutateClockBuild(evidence: any, fault: typeof buildFaults[number]) {
  const config = `/boot/config-${SERVER_PROFILE.clockError.kernelRelease}`;
  switch (fault) {
    case 'config': evidence.files[config].text += '\n# different same-release config\n'; break;
    case 'signature': evidence.files['/proc/version_signature'].text = 'Ubuntu same-release-wrong-build'; break;
    case 'modules-package': evidence.packages[1].stdout = evidence.packages[1].stdout.replace('linux-azure-7.0', 'linux-other'); break;
    case 'image-package': evidence.packages[0].stdout = evidence.packages[0].stdout.replace('7.0.0-1017.17', '7.0.0-1017.18'); break;
    case 'missing-witness': return undefined;
    case 'missing-config': delete evidence.files[config]; break;
    case 'read-error': evidence.files[config] = { error: { code: 'EIO', message: 'config unreadable' } }; break;
    case 'query-error': Object.assign(evidence.packages[1], { status: 1, error: { code: 'EIO', message: 'query failed' } }); break;
    case 'query-signal': Object.assign(evidence.packages[1], { status: null, signal: 'SIGTERM' }); break;
    case 'missing-package': evidence.packages.pop(); break;
    case 'duplicate-package': evidence.packages.push(clone(evidence.packages[1])); break;
    case 'missing-signature': delete evidence.files['/proc/version_signature']; break;
    case 'missing-namespace': delete evidence.namespaces['/proc/self/ns/time']; break;
    case 'namespace-error': evidence.namespaces['/proc/self/ns/time'] = { error: { code: 'EACCES', message: 'not readable' } }; break;
    case 'children-namespace': evidence.namespaces['/proc/self/ns/time_for_children'].target = 'time:[4026539999]'; break;
    case 'self-offset': evidence.files['/proc/self/timens_offsets'].text = 'monotonic 1 0\nboottime 0 0'; break;
    case 'init-offset': evidence.files['/proc/1/timens_offsets'].text = 'monotonic 0 0\nboottime 0 1'; break;
    case 'missing-offset': delete evidence.files['/proc/1/timens_offsets']; break;
    case 'malformed-offset': evidence.files['/proc/self/timens_offsets'].text = 'monotonic 0 0'; break;
    default: { const exhaustive: never = fault; throw new Error(String(exhaustive)); }
  }
  return evidence;
}
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

type ResourceReadFixture = { text: string; error?: never } | { text?: never; error: { code: string; message: string } };
type ResourceScopeFixture = { path: string; directory: string; dev: string; ino: string; fsType: string;
  type: ResourceReadFixture; cpuMax: ResourceReadFixture; burst: ResourceReadFixture; memoryMax: ResourceReadFixture;
  controllers: ResourceReadFixture; subtreeControl: ResourceReadFixture };
function resourceIdentity() {
  const membership = { text: '0::/system.slice/hosted-compute-agent.service' };
  const mountinfo = { text: '37 31 0:31 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:8 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot' };
  const absent = { error: { code: 'ENOENT', message: 'absent' } };
  return { membership, mountinfo, mount: { id: '37', root: '/', point: '/sys/fs/cgroup', filesystem: 'cgroup2' }, scheduler: '0',
    schedExtState: { model: 'linux-v6.18.44-v7.0-sched-ext-state', text: 'disabled' },
    scopes: ['/system.slice/hosted-compute-agent.service', '/system.slice', '/'].map((name, index): ResourceScopeFixture => ({
      path: name, directory: '/sys/fs/cgroup' + (name === '/' ? '' : name), dev: '31', ino: String(index + 1), fsType: '1667723888',
      type: index === 2 ? absent : { text: 'domain' }, cpuMax: index === 2 ? absent : { text: '400000 100000' },
      burst: absent, memoryMax: { text: 'max' }, controllers: { text: 'cpu memory' }, subtreeControl: { text: index === 0 ? '' : 'cpu memory' },
    })) };
}
const resourceMachine = () => ({ affinity: '0', cgroupCpuMax: '400000 100000', resource: resourceIdentity() });

function stage(name = 'aa', runs = 2, packedCpu = false) {
  const rows: any[] = [];
  // Одна зарегистрированная перестановка на stage, а не полный N-план
  // заново для каждой scene/run. Raw и независимые validator checks прежние.
  const orders = serverOrders(runs);
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
          if (packedCpu) for (const measured of raw) {
            // Synthetic endpoints уже имеют одну identity. Полный timespec vector
            // задаётся напрямую в production carrier, без повторного encoder pass.
            const reads = measured.raw.cpuReads;
            measured.raw.cpuReads = { encoding: 'native-cpu-rle-v1', count: reads.length,
              runs: [{ from: 0, count: reads.length, ...syntheticCpuIdentity,
                values: reads.map((read: any) => [read.seconds, read.nanoseconds]) }] };
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
      rows.push({ kind, scene: scene.id, run, order: [...orders[run]], samples });
    }
  }
  const blocks = Array.from({ length: runs / 2 }, (_, block) => {
    const cpuStat = { usage_usec: 10 + block * 10, user_usec: 10 + block * 10, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
    const after = { ...cpuStat, usage_usec: cpuStat.usage_usec + 10, user_usec: cpuStat.user_usec + 10 };
    const delta = { usage_usec: 10, user_usec: 10, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
    const parent = { ...cpuStat };
    const parentDelta = { usage_usec: 0, user_usec: 0, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
    const paths = ['/system.slice/hosted-compute-agent.service', '/system.slice'];
    return { block, before: { cpuStat, affinity: '0', cpuMax: '400000 100000', resource: resourceIdentity(),
      scopes: [{ path: paths[0], cpuStat }, { path: paths[1], cpuStat: parent }] },
    after: { cpuStat: after, affinity: '0', cpuMax: '400000 100000', resource: resourceIdentity(),
      scopes: [{ path: paths[0], cpuStat: after }, { path: paths[1], cpuStat: { ...parent } }] },
    delta, scopeDeltas: [{ path: paths[0], delta }, { path: paths[1], delta: parentDelta }] };
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
  const machineIdentity = { ...resourceMachine(), clockBuildEvidence: healthyClockBuildEvidence(), arch: 'x64', platform: 'linux', release: SERVER_PROFILE.clockError.kernelRelease, node: SERVER_PROFILE.clockError.nodeVersion,
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
  artifact.warmup = stage('warmup', SERVER_PROFILE.warmupRuns, true);
  artifact.pilot = stage('pilot', SERVER_PROFILE.pilotRuns, true);
  artifact.samplePlan = planServerSampleSize(serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, 'pilot'));
  const runs = artifact.samplePlan.runs;
  artifact.aa = stage('aa', runs, true); artifact.positive = stage('positive', runs, true); artifact.ab = stage('ab', runs, true);
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
    const artifact = healthyAdmission();
    const events = admissionEvents(artifact);
    sharedAdmission = { artifact, events, records: chain(events) };
  }
  return sharedAdmission;
}

describe('серверный PROFILE: потеря полей при CPU RLE запрещена', () => {
  const original = [
    { sequence: 0, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 12345, tid: 12345, seconds: '9007199254740993', nanoseconds: 17, valueNs: '9007199254740993000000017' },
    { sequence: 1, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 12345, tid: 12345, seconds: '9007199254740993', nanoseconds: 18, valueNs: '9007199254740993000000018' },
    { sequence: 2, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 23456, tid: 23456, seconds: '9007199254740993', nanoseconds: 19, valueNs: '9007199254740993000000019' },
  ];
  const encoded = { encoding: 'native-cpu-rle-v1', count: 3, runs: [
    { from: 0, count: 2, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 12345, tid: 12345, values: [['9007199254740993', 17], ['9007199254740993', 18]] },
    { from: 2, count: 1, clock: 'CLOCK_THREAD_CPUTIME_ID', pid: 23456, tid: 23456, values: [['9007199254740993', 19]] },
  ] };
  it('восстанавливает каждый exact timespec/ordinal/PID и исходный порядок JSON', () => {
    expect(compactServerCpuEvidence(original)).toEqual(encoded);
    const restored = expandServerCpuEvidence(JSON.parse(JSON.stringify(encoded)), 3);
    expect(restored).toEqual(original);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(original));
    expect(expandServerCpuEvidence(original, 3)).toBe(original);
  });
  it.each(['valueNs', 'sequence'])('encoder не исправляет forged %s', (field) => {
    const changed = clone(original); changed[1][field] = field === 'valueNs' ? '9007199254740993000000019' : 0;
    const before = JSON.stringify(changed);
    expect(() => compactServerCpuEvidence(changed)).toThrow(/native CPU/);
    expect(JSON.stringify(changed)).toBe(before);
  });
  it.each(['count', 'gap'])('decoder не скрывает %s в приобретённом suffix', (field) => {
    const changed = clone(encoded);
    if (field === 'count') changed.count++; else changed.runs[1].from++;
    expect(() => expandServerCpuEvidence(changed, 3)).toThrow(/native CPU/);
  });
});

// Исполняем настоящий browser owner в VM с независимым линейным DOM и
// намеренно грубыми часами. Это synthetic fault test, не performance sample.
function syntheticBrowser(options: { startCostMs?: number; snap?: boolean; snapAt?: number; cancelAt?: number; rejectTiming?: boolean;
  durationMultiplier?: number; shape?: 'quadratic'; rafStepMs?: number; readCostMs?: number; timerLagMs?: number;
  initialProgress?: number; initialProgressAt?: number; onsetReadAt?: number; documentClock?: 'missing' | 'unstable' | 'unrelated';
  documentOriginLagMs?: number; quarterAtFirstFrame?: boolean; quarterAtFrame?: number;
  completion?: 'absent' | 'missing' | 'rejected' | 'never' | 'early' | 'late-early' } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'motion-server-synthetic-'));
  const source = path.join(directory, 'adapter.js'); writeFileSync(source, '// Синтетический adapter задан VM.\n');
  let timeMs = 100, frameTimeMs = timeMs - (options.documentOriginLagMs ?? 0), frameReads = 0, frames = 0, starts = 0, cancels = 0;
  const children: any[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let timerId = 0, pumpHandle: ReturnType<typeof setImmediate> | undefined;
  // Таймеры — отдельные tasks: promise callbacks успевают снять watchdog.
  const pumpTimers = () => {
    if (pumpHandle !== undefined || timers.size === 0) return;
    pumpHandle = setImmediate(() => {
      pumpHandle = undefined;
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return;
      timers.delete(next[0]);
      for (const element of children) if (element.motion?.pendingFrame) {
        element.motion.startedMs += options.rafStepMs ?? 16; element.motion.pendingFrame = false;
      }
      timeMs = Math.max(timeMs, next[1].at) + (options.timerLagMs ?? 0);
      next[1].callback();
      pumpTimers();
    });
  };
  const scheduleTimer = (callback: () => void, delay: number) => {
    const id = ++timerId;
    timers.set(id, { callback, at: timeMs + Math.max(0, delay) });
    pumpTimers();
    return id;
  };
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
    let finishTimer: number | undefined;
    const control = { finished() {
      if (options.completion === 'missing') return undefined;
      if (options.completion === 'rejected') return Promise.reject(new Error('synthetic completion rejection'));
      if (options.completion === 'never') return new Promise(() => {});
      if (options.completion === 'early') return Promise.resolve();
      const endMs = startedMs + (options.rafStepMs ?? 16) +
        duration * (options.durationMultiplier ?? 1) + gap * (elements.length - 1);
      const settledMs = endMs - (options.completion === 'late-early' ? options.rafStepMs ?? 16 : 0);
      return new Promise<void>((resolve) => { finishTimer = scheduleTimer(resolve, Math.max(0, settledMs - timeMs)); });
    }, cancel() {
      if (finishTimer !== undefined) timers.delete(finishTimer);
      cancels++;
      if (cancels === options.cancelAt) throw undefined;
      timeMs += 0.05;
      for (const element of elements) { element.x = position(element); element.motion = null; }
    } };
    return options.completion === 'absent' ? { cancel: control.cancel } : control;
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
  setTimeout: scheduleTimer,
  clearTimeout(id: number | undefined) { if (id !== undefined) timers.delete(id); },
  requestAnimationFrame(callback: (time: number) => void) {
    timeMs += options.rafStepMs ?? 16; frameTimeMs = timeMs;
    if (children.some((element) => element.motion)) frames++;
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
    dispose: () => {
      if (pumpHandle !== undefined) clearImmediate(pumpHandle);
      timers.clear();
      rmSync(directory, { recursive: true, force: true });
    }, read: () => ({ starts, cancels, connected: children.filter((element) => element.isConnected).length }) };
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

  it.each([
    { name: 'heterogeneous', groups: [[true, false], [false, true]], animations: [0, 2, 1, 3], transforms: [7, 19] },
    { name: 'empty', groups: [], animations: [], transforms: [] },
    { name: 'all-connected', groups: [[true, true]], animations: [1, 0], transforms: [11] },
    { name: 'all-detached', groups: [[false], [false]], animations: [2, 1], transforms: [13, 23] },
  ])('фактический start witness сохраняет чтения плотного массива: $name', ({ groups: connectivity, animations, transforms }) => {
    const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8');
    const timingBegin = source.indexOf('const raw = [], warmup');
    expect(timingBegin).toBeGreaterThanOrEqual(0);
    const begin = source.indexOf('          const readBeginMs = performance.now();', timingBegin);
    const end = source.indexOf('          await window.__serverSavePartial(', begin);
    expect(begin).toBeGreaterThan(timingBegin);
    expect(end).toBeGreaterThan(begin);
    const actual = source.slice(begin, end);
    const legacy = actual.replace(/          let connectedTargets = 0;\n          for \(const element of targets\) if \(element.isConnected\) connectedTargets\+\+;\n          const startWitness = \{ connectedTargets,/, '          const startWitness = { connectedTargets: targets.filter((element) => element.isConnected).length,');
    expect(legacy).not.toBe(actual);
    const evaluationBegin = source.indexOf('const result = await withBrowserTimeout(page.evaluate');
    expect(evaluationBegin).toBeGreaterThanOrEqual(0);
    const compactBegin = source.indexOf('      const compact = (values) => {', evaluationBegin);
    const compactEnd = source.indexOf('      const expand = ', compactBegin);
    expect(compactBegin).toBeGreaterThan(evaluationBegin);
    expect(compactEnd).toBeGreaterThan(compactBegin);
    const compactSource = source.slice(compactBegin, compactEnd);
    const run = (block: string) => {
      const events: string[] = [], identities: object[] = [];
      let index = 0;
      const groups = connectivity.map((group, groupIndex) => group.map((connected) => {
        const id = index++;
        const element = { get isConnected() { events.push('connected:' + id); return connected; },
          getAnimations() { events.push('animations:' + id); return Array(animations[id]).fill({}); }, groupIndex, id };
        identities.push(element); return element;
      }));
      const before = groups.flat();
      let clock = 0;
      const realm = createContext({ groups, performance: { now() { events.push('clock:' + clock); return ++clock; } },
        getComputedStyle(element: { id: number; groupIndex: number }) { events.push('transform:' + element.id); return { transform: transforms[element.groupIndex] }; },
        DOMMatrixReadOnly: class { e: number; constructor(transform: number) { this.e = transform; } } });
      const result = runInContext('(() => {\n' + compactSource + block + '\nreturn { startWitness, targets }; })()', realm);
      expect(result.targets).toHaveLength(identities.length);
      result.targets.forEach((element: object, i: number) => expect(element).toBe(identities[i]));
      groups.flat().forEach((element, i) => expect(element).toBe(before[i]));
      const witness = JSON.parse(JSON.stringify(result.startWitness));
      const expected = ['clock:0', ...identities.map((_, i) => 'connected:' + i), ...identities.map((_, i) => 'animations:' + i),
        ...groups.map((group) => 'transform:' + group[0].id), 'clock:1'];
      expect(events).toEqual(expected);
      expect(witness).toEqual({ connectedTargets: connectivity.flat().filter(Boolean).length,
        activeWaapi: animations.reduce((sum, count) => sum + count, 0),
        leadingPositions: transforms.every((value) => Object.is(value, transforms[0]))
          ? { encoding: 'repeat', count: transforms.length, ...(transforms.length ? { value: transforms[0] } : {}) }
          : { encoding: 'rle', count: transforms.length, runs: transforms.map((value) => [1, value]) },
        readClock: { beginMs: 1, endMs: 2 } });
      return { witness, events };
    };
    expect(run(actual)).toEqual(run(legacy));
  });


  it('locked server owner сохраняет cancel-only adapter без completion API', async () => {
    const fake = syntheticBrowser({ completion: 'absent' });
    try {
      const evidence = await syntheticSemanticControl(fake, SERVER_PROFILE.browserScenes[0]);
      expect(evidence.valid).toBe(true);
      expect(evidence).not.toHaveProperty('completion');
      expect(evidence.terminal[0].every((value: number) => value === SERVER_PROFILE.toPx)).toBe(true);
      expect(fake.read()).toEqual({ starts: 1, cancels: 1, connected: 0 });
    } finally { fake.dispose(); }
  });

  it('общий semantic owner ждёт завершение и сохраняет elapsed каждого контроллера', async () => {
    const scene = { ...SERVER_PROFILE.browserScenes[0], completionTimeoutMs: 1000 };
    const fake = syntheticBrowser();
    try {
      const evidence = await syntheticSemanticControl(fake, scene);
      expect(evidence.valid).toBe(true);
      expect(evidence.completion.calls).toHaveLength(SERVER_PROFILE.browserSemanticCalls);
      expect(evidence.completion.calls.every((call: any) => call.state === 'fulfilled')).toBe(true);
      expect(evidence.completion.observedAtMs).toBeLessThanOrEqual(1000);
      expect(evidence.completion.terminalReadStartedMs).toBeGreaterThan(evidence.completion.observedAtMs);
      expect(evidence.terminal[0].every((value: number) => value === SERVER_PROFILE.toPx)).toBe(true);
      expect(fake.read()).toEqual({ starts: 1, cancels: 1, connected: 0 });
    } finally { fake.dispose(); }
  });

  it.each(['absent', 'missing', 'rejected', 'never', 'early', 'late-early'] as const)(
    'не выдаёт завершённый сценарий при completion %s',
    async (completion) => {
      const scene = { ...SERVER_PROFILE.browserScenes[0], completionTimeoutMs: 1000 };
      const fake = syntheticBrowser({ completion });
      try {
        const evidence = await syntheticSemanticControl(fake, scene);
        expect(evidence.valid).toBe(false);
        if (completion === 'late-early') {
          // Два terminal rAF уже показывают endpoint: только связь finished
          // с полной траекторией отличает этот преждевременный success.
          expect(evidence.failures).toBeUndefined();
          expect(evidence.terminal[0].every((value: number) => value === SERVER_PROFILE.toPx)).toBe(true);
          expect(evidence.completion.calls[0].observedAtMs).toBeLessThan(
            evidence.onset.firstFrame.frameTimestampMs + SERVER_PROFILE.durationMs,
          );
        }
        if (completion === 'never') {
          expect(evidence.failures.some((failure: any) => failure.message === 'Completion watchdog expired')).toBe(true);
          expect(evidence.completion.calls[0].state).toBe('pending');
        }
        expect(fake.read()).toEqual({ starts: 1, cancels: 1, connected: 0 });
      } finally { fake.dispose(); }
    },
  );


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
    // Каждый вызов проверяется; Vitest оформляет только несовпадение значений.
    const same = (actual: unknown, expected: unknown): void => {
      if (!Object.is(actual, expected)) expect(actual).toBe(expected);
    };
    const expectedSpring = { mass: 1, stiffness: 170, damping: 26 };
    let constructors = 0, destroys = 0, failAt = Infinity, cpuNs = 0n;
    const cpu = vi.spyOn(threadCpuClock, 'readServerThreadCpuEndpoint').mockImplementation(() =>
      syntheticNativeEndpoint(cpuNs += 2_000_000_000n, { clock: 'CLOCK_THREAD_CPUTIME_ID', pid: process.pid, tid: process.pid }));
    class ObservedMotionValue {
      private readonly options: any;
      private changed: (value: number) => unknown = () => {};
      private index: number;
      constructor(options: any) {
        this.index = constructors++; this.options = options;
        same(options.initial, 0);
        const spring = options.spring;
        if (!isDeepStrictEqual(spring, expectedSpring)) expect(spring).toEqual(expectedSpring);
        same(Object.hasOwn(options, 'clamp'), false);
      }
      onChange(changed: (value: number) => unknown) { this.changed = changed; changed(0); }
      setTarget(target: number) {
        same(target, 100);
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
  it('сохраняет невозможную мощность до отказа и не запускает A/A, 2×work или кандидат', async () => {
    const artifact: any = registeredRefusal();
    artifact.failures = [];
    const calls: any[] = [], events: any[] = [];
    const runStage = async (name: string, runs: number) => {
      calls.push({ name, runs });
      if (!['warmup', 'pilot'].includes(name)) throw new Error('после невозможного N запущена новая стадия');
      const value = stage(name, runs);
      if (name === 'pilot') for (const row of value.rows.filter((row) => row.scene === 'motion-value-default-stock-c')) {
        const factor = [1, 1, 100, 100, 2, 2, 3, 3][row.run];
        const sample = row.samples.right;
        sample.operationNs *= factor;
        for (const raw of sample.raw) {
          raw.operationNs *= factor;
          for (const read of raw.raw.clockReads) read.valueNs = String(BigInt(read.valueNs) * BigInt(factor));
          raw.raw.cpuReads = raw.raw.clockReads.map((read: any) => nativeCpuEndpoint(read));
        }
      }
      return value;
    };
    await expect(runServerProfileCalibration(artifact, runStage, (type: string, value: any) => events.push({ type, value })))
      .rejects.toMatchObject({ code: 'UNPROVEN_POWER' });
    expect(calls).toEqual([{ name: 'warmup', runs: SERVER_PROFILE.warmupRuns }, { name: 'pilot', runs: SERVER_PROFILE.pilotRuns }]);
    expect(artifact.samplePlan).toMatchObject({ feasible: false, runs: SERVER_PROFILE.maxRuns });
    expect(artifact.samplePlan.requiredRuns).toBeGreaterThan(SERVER_PROFILE.maxRuns);
    expect(events).toEqual([{ type: 'N-frozen-before-calibration-and-AB', value: {
      samplePlan: artifact.samplePlan, digest: serverProfileDigest({ registrationDigest: artifact.registrationDigest, samplePlan: artifact.samplePlan }),
    } }]);
    expect(artifact.aa).toBeUndefined(); expect(artifact.positive).toBeUndefined(); expect(artifact.ab).toBeUndefined();
  });

  it('отмена перед запуском сохраняет отказ, digest и завершённый журнал', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'motion-profile-stop-'));
    const out = path.join(directory, 'out'), controller = new AbortController();
    const reason = Object.assign(new Error('остановлено оператором'), { code: 'OPERATOR_INTERRUPTION', raw: { signal: 'SIGTERM' } });
    controller.abort(reason);
    try {
      const artifact = await runServerProfile({ baseline: directory, candidate: directory, browser: 'chromium', out }, { signal: controller.signal });
      expect(artifact.verdict).toBe('UNPROVEN');
      expect(artifact.failures).toHaveLength(1);
      expect(artifact.failures[0].error).toMatchObject({ code: 'OPERATOR_INTERRUPTION', raw: { signal: 'SIGTERM' } });
      expect(artifact.registration).toBeNull(); expect(artifact.stages).toEqual([]);
      expect(readFileSync(path.join(out, 'server-profile.json'), 'utf8')).toBe(`${JSON.stringify(artifact)}\n`);
      const records = parseServerJournalBytes(readFileSync(path.join(out, 'journal.ndjson')));
      expect(records.map((record: any) => record.type)).toEqual(['failure', 'finished']);
      expect(records.at(-1).value).toEqual({ verdict: 'UNPROVEN', digest: serverArtifactDigest(artifact) });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('отмена внутри получения sample сохраняет его до остановки следующего владельца', async () => {
    const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8');
    const begin = source.indexOf('    const runStage = async (name, runs) => {');
    const end = source.indexOf('    if (!await runServerProfileCalibration(', begin);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    const controller = new AbortController(), reason = new Error('остановлено после приобретения sample');
    const artifact: any = { stages: [] }, records: any[] = [];
    const sample: any = stage('warmup', 2).rows[0].samples.left;
    const measure = vi.fn(async () => { controller.abort(reason); return sample; });
    const context = createContext({ artifact, SERVER_PROFILE: { ...SERVER_PROFILE, engineScenes: [SERVER_PROFILE.engineScenes[0]], browserScenes: [] },
      checkpoint: () => controller.signal.throwIfAborted(), captureServerLoad: () => ({ cpuStat: {} }),
      serverOrders, engineMeasure: measure, browserMeasure: vi.fn(), implementations: { baseline: {} },
      compactSampleCpuEvidence: (value: any) => { for (const row of value.raw) row.raw.cpuReads = compactServerCpuEvidence(row.raw.cpuReads); },
      journal: (type: string, value: any) => records.push({ type, value }), verify: vi.fn(), process: { stderr: { write: vi.fn() } } });
    const runStage = runInContext(`(() => { ${source.slice(begin, end)} return runStage; })()`, context);
    await expect(runStage('warmup', 2)).rejects.toBe(reason);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(artifact.warmup.rows).toHaveLength(1);
    expect(artifact.warmup.rows[0].samples).toEqual({ left: sample });
    expect(records).toEqual([{ type: 'sample', value: { stage: 'warmup', kind: 'engine', scene: SERVER_PROFILE.engineScenes[0].id,
      run: 0, participant: 'left', build: 'baseline', value: sample } }]);
  });

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

  let healthyAdmissionTask: TestContext['task'] | undefined;
  const acceptedAdmission = () => {
    // Полный setup и успешный admission принадлежат предыдущему timed test.
    // Result учитывает также framework timeout; отдельный fault без healthy
    // prerequisite даёт отказ, не skip и не самостоятельный setup.
    expect(healthyAdmissionTask?.result?.state).toBe('pass');
    return admissionHistory();
  };

  it('полный healthy admission создаёт и проверяет весь зарегистрированный N', ({ task }) => {
    healthyAdmissionTask = task;
    const history = admissionHistory(), { artifact } = history;
    expect(validateServerArtifact(artifact).verdict).toBe('PASS');
    expect(validateServerJournal(artifact, history.records)).toHaveProperty('journalFinalDigest');
  }, 30_000);

  it('полная история отвергает calibration до завершения A/A и 2×work', () => {
    const history = acceptedAdmission(), { artifact, events } = history;
    const earlyCalibration = events.filter((event) => event.type !== 'calibration');
    earlyCalibration.splice(earlyCalibration.findIndex((event) => event.type === 'N-frozen-before-calibration-and-AB') + 1, 0,
      { type: 'calibration', value: artifact.calibration });
    expect(() => validateServerJournal(artifact, chain(earlyCalibration, history))).toThrow(/до завершения/);
  }, 30_000);

  it('полная история отвергает замену противоположного порядка пар', () => {
    const history = acceptedAdmission(), { artifact, events } = history;
    const alwaysLeft = [...events];
    const firstOpposite = alwaysLeft.findIndex((event) => event.type === 'sample' && event.value.participant === 'right');
    [alwaysLeft[firstOpposite], alwaysLeft[firstOpposite + 1]] = [alwaysLeft[firstOpposite + 1], alwaysLeft[firstOpposite]];
    expect(() => validateServerJournal(artifact, chain(alwaysLeft, history))).toThrow(/порядок/);
  }, 30_000);

  it('полная история отвергает потерянный failure union', () => {
    const history = acceptedAdmission(), { artifact, events } = history;
    const ignoredFailure = [...events.slice(0, -1), { type: 'failure', value: { stage: 'ab', error: { message: 'retained reviewer failure' } } }, events.at(-1)];
    expect(() => validateServerJournal(artifact, chain(ignoredFailure, history))).toThrow(/failures/);
  }, 30_000);

  it('полная история отвергает подмену имени positive', () => {
    const { artifact } = acceptedAdmission();
    const wrongPositive = { ...artifact, positive: { ...artifact.positive, name: 'aa' } };
    expect(() => validateServerArtifact(wrongPositive)).toThrow(/имя стадии/);
  }, 30_000);

  it('полная история отвергает подмену финального raw digest', () => {
    const history = acceptedAdmission(), { artifact, events } = history;
    const wrongFinish = [...events.slice(0, -1), { type: 'finished', value: { verdict: 'PASS', digest: 'b'.repeat(64) } }];
    expect(() => validateServerJournal(artifact, chain(wrongFinish, history))).toThrow(/финальная/);
  }, 30_000);

  it('сохраняет partial A/B и failed-sample raw при полном зарегистрированном N', () => {
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
  }, 30_000);

  it('сохраняет поздний comparator отказ при полном зарегистрированном N', () => {
    const history = admissionHistory(), complete = history.artifact, completeEvents = history.events;
    const error = { name: 'Error', message: 'timeout второго участника; первый raw сохранён', raw: { completed: [] } };
    const late: any = { ...complete, verdict: 'UNPROVEN' };
    const firstComparator = completeEvents.findIndex((event) => event.type === 'comparator-sample');
    const comparatorFailure = completeEvents[firstComparator + 1].value;
    late.failures = [{ stage: 'ab', error }]; late.comparators = [{ ...late.comparators[0], rows: [late.comparators[0].rows[0]] }];
    delete late.retention;
    const lateEvents = [...completeEvents.slice(0, firstComparator + 1), { type: 'failed-comparator-sample', value: { ...comparatorFailure, stage: 'ab', error } },
      { type: 'failure', value: late.failures[0] }, { type: 'finished', value: { verdict: 'UNPROVEN', digest: serverArtifactDigest(late) } }];
    expect(validateServerArtifact(late).verification).toBe('completed-samples-refused');
    expect(validateServerJournal(late, chain(lateEvents, history))).toHaveProperty('journalFinalDigest');
  }, 30_000);

  it('не допускает пропавшие comparator/retention при полном зарегистрированном N', () => {
    const history = admissionHistory(), complete = history.artifact, completeEvents = history.events;
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
    const identity = resourceMachine();
    expect(serverResourceReasons([value], identity)).toEqual([]);
    value.blocks[0].after.cpuStat.nr_throttled += 1; value.blocks[0].delta.nr_throttled = 1;
    expect(serverResourceReasons([value], identity)[0]).toMatch(/throttling/);
    value.blocks[0].delta.nr_throttled = 0;
    expect(() => serverResourceReasons([value], identity)).toThrow(/delta/);
  });

  it('stable drift между блоками/стадиями не заменяет зарегистрированные CPU/quota', () => {
    const value = stage('aa', 4), identity = resourceMachine();
    value.blocks[1].before.affinity = '1'; value.blocks[1].after.affinity = '1';
    expect(serverResourceReasons([value], identity)).toContain('aa: block 1 отличается от зарегистрированных affinity/quota');
    value.blocks[1].before.affinity = '0'; value.blocks[1].after.affinity = '0';
    value.blocks[1].before.cpuMax = '200000 100000'; value.blocks[1].after.cpuMax = '200000 100000';
    expect(serverResourceReasons([value], identity)).toContain('aa: block 1 отличается от зарегистрированных affinity/quota');
    const later = stage('positive'); later.blocks[0].before.cpuMax = 'max 100000'; later.blocks[0].after.cpuMax = 'max 100000';
    expect(serverResourceReasons([stage(), later], identity)).toContain('positive: block 0 отличается от зарегистрированных affinity/quota');
  });

  it('leaf-zero не скрывает throttling предка и не суммирует usage', () => {
    // Given
    const value = stage(), block = value.blocks[0];
    if (!block || !block.after.scopes[1] || !block.scopeDeltas[1]) throw new Error('missing fixture scope');
    block.after.scopes[1].cpuStat.nr_throttled++;
    block.scopeDeltas[1].delta.nr_throttled = 1;
    // When
    const reasons = serverResourceReasons([value], resourceMachine());
    // Then
    expect(reasons.some((reason: string) => reason.includes('throttling: /system.slice'))).toBe(true);
    expect(block.delta.usage_usec).toBe(10);
    expect(block.delta.nr_throttled).toBe(0);
  });

  it('посторонний mount не меняет resource admission, но меняет raw digest', () => {
    // Given
    const value = stage(), block = value.blocks[0];
    if (!block) throw new Error('missing fixture block');
    const beforeDigest = serverArtifactDigest(value);
    block.after.resource.mountinfo.text += '\n38 31 0:32 / /unrelated rw - tmpfs tmpfs rw';
    // When
    const reasons = serverResourceReasons([value], resourceMachine());
    // Then
    expect(reasons).toEqual([]);
    expect(serverArtifactDigest(value)).not.toBe(beforeDigest);
    expect(block.after.resource.mountinfo.text).not.toBe(block.before.resource.mountinfo.text);
  });

  it.each(['overmount', 'alias', 'mount-swap'] as const)('resource admission различает %s от постороннего mount', (fault) => {
    // Given
    const value = stage(), block = value.blocks[0];
    if (!block) throw new Error('missing fixture block');
    const resource = block.after.resource;
    switch (fault) {
      case 'overmount': resource.mountinfo.text += '\n38 37 0:32 / /sys/fs/cgroup/system.slice rw - tmpfs tmpfs rw'; break;
      case 'alias': resource.mountinfo.text += '\n38 31 0:31 / /alias rw - cgroup2 cgroup2 rw'; break;
      case 'mount-swap': resource.mount.id = '38'; resource.mountinfo.text = resource.mountinfo.text.replace(/^37 /, '38 '); break;
      default: { const exhaustive: never = fault; throw new Error(String(exhaustive)); }
    }
    // When / Then
    if (fault === 'mount-swap') expect(serverResourceReasons([value], resourceMachine()).length).toBeGreaterThan(0);
    else expect(() => serverResourceReasons([value], resourceMachine())).toThrow();
  });

  it.each(['missing-before', 'missing-after', 'missing-delta', 'forged-path'] as const)(
    'повреждённые scope %s не становятся валидным отказом через topology continue', (fault) => {
      // Given: identity валидна; повреждены только обязательные counters/deltas.
      const value = stage(), block = value.blocks[0];
      if (!block) throw new Error('missing fixture block');
      switch (fault) {
        case 'missing-before': block.before.scopes.pop(); break;
        case 'missing-after': block.after.scopes.pop(); break;
        case 'missing-delta': block.scopeDeltas.pop(); break;
        case 'forged-path': {
          const delta = block.scopeDeltas[1];
          if (!delta) throw new Error('missing fixture delta');
          delta.path = '/forged'; break;
        }
        default: { const exhaustive: never = fault; throw new Error(String(exhaustive)); }
      }
      // When / Then
      expect(() => serverResourceReasons([value], resourceMachine())).toThrow();
    });

  it.each(['history', 'reset', 'forged', 'missing-parent', 'parent-quota', 'parent-burst', 'inode'])(
    'independent resource validator различает %s', (fault) => {
      // Given
      const value = stage(), block = value.blocks[0];
      if (!block) throw new Error('missing fixture block');
      const before = block.before.scopes[1], after = block.after.scopes[1], delta = block.scopeDeltas[1];
      if (!before || !after || !delta) throw new Error('missing fixture scope');
      before.cpuStat.nr_throttled = 20; after.cpuStat.nr_throttled = 20;
      switch (fault) {
        case 'history': break;
        case 'reset': after.cpuStat.nr_throttled = 19; delta.delta.nr_throttled = -1; break;
        case 'forged': after.cpuStat.nr_throttled = 21; break;
        case 'missing-parent': block.before.resource.scopes.splice(1, 1); block.after.resource.scopes.splice(1, 1); break;
        case 'parent-quota':
        case 'parent-burst':
        case 'inode':
          for (const snapshot of [block.before, block.after]) {
            const scope = snapshot.resource.scopes[1]; if (!scope) throw new Error('missing parent');
            if (fault === 'parent-quota') scope.cpuMax = { text: '50000 100000' };
            else if (fault === 'parent-burst') scope.burst = { text: '1000' };
            else scope.ino = '9000';
          }
          break;
        default: throw new Error('unknown fixture mutation: ' + fault);
      }
      // When / Then
      if (fault === 'history') expect(serverResourceReasons([value], resourceMachine())).toEqual([]);
      else if (['parent-quota', 'parent-burst', 'inode'].includes(fault)) expect(serverResourceReasons([value], resourceMachine()).length).toBeGreaterThan(0);
      else expect(() => serverResourceReasons([value], resourceMachine())).toThrow(/resource|ancestor|delta/);
    });

  it.each([false, true])('смена глубины ancestor с сохранёнными counter paths=%s даёт явный отказ', (retainedPaths) => {
    const value = stage(), block = value.blocks[0], identity = resourceMachine();
    if (!block) throw new Error('missing fixture block');
    expect(serverResourceReasons([value], identity)).toEqual([]);
    const rawBefore = clone(block.before);
    const after = block.after;
    after.resource.membership.text = '0::/system.slice';
    after.resource.scopes.shift();
    after.scopes.pop();
    if (!retainedPaths) after.scopes[0].path = '/system.slice';
    // Обе resource identity и cardinality каждого snapshot валидны отдельно.
    expect(() => validateServerResourceIdentity(block.before.resource)).not.toThrow();
    expect(() => validateServerResourceIdentity(after.resource)).not.toThrow();
    expect(after.scopes).toHaveLength(after.resource.scopes.length - 1);
    // Согласованные paths уже дают явный отказ; старые paths достигают undefined.
    let refusal: unknown;
    try { serverResourceReasons([value], identity); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect(block.before).toEqual(rawBefore);
    expect(after.resource.membership.text).toBe('0::/system.slice');
    expect(block.scopeDeltas).toHaveLength(2);
  });

  it('пересчитанный artifact digest не скрывает удаление ancestor', () => {
    // Given
    const value = registeredRefusal();
    value.registration.machine.identity.resource.scopes.splice(1, 1);
    value.registration.machine.sha256 = serverProfileDigest(value.registration.machine.identity);
    value.registrationDigest = serverProfileDigest(value.registration);
    // When / Then
    expect(() => validateServerArtifact(value)).toThrow(/ancestor|chain/);
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

describe('PROFILE: current-run clock build binding', () => {
  it.each(['read-EIO', 'registration-rejected', 'healthy-admitted'] as const)
  ('реальный runner finalize/validator сохраняет atomic admission %s', async (mode) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'profile-admission-'));
    const out = path.join(directory, 'out'), controller = new AbortController();
    const registration: any = registeredRefusal().registration;
    const clock = healthyClockBuildEvidence(), resource = resourceIdentity();
    const realRead = filesystem.readFileSync, realAppend = filesystem.appendFileSync, realRequire = nodeModule.createRequire, realPath = filesystem.realpathSync,
      realStat = filesystem.statSync, realExists = filesystem.existsSync;
    const fsBoundary = { ...filesystem }, processBoundary = { ...childProcess }, moduleBoundary = { ...nodeModule }, osBoundary = { ...os };
    const nodeVersion = Object.getOwnPropertyDescriptor(process, 'version')!;
    Object.defineProperty(process, 'version', { ...nodeVersion, value: SERVER_PROFILE.clockError.nodeVersion });
    let admissionReadArmed = false, injectedReads = 0;
    const controls = vi.fn(), closeBrowser = vi.fn(async () => {}), closeOrigin = vi.fn(async () => {});
    const nativeVerify = vi.fn(), provenanceVerify = vi.fn();
    const browser = { version: () => { admissionReadArmed = true; return mode === 'registration-rejected' ? 'unqualified' : SERVER_PROFILE.clockError.browserVersion; },
      close: closeBrowser, newPage: controls };
    const spies: Array<{ mockRestore(): void }> = [];
    const spy = (value: any) => { spies.push(value); return value; };
    try {
      spy(vi.spyOn(fsBoundary, 'readFileSync')).mockImplementation(((file: any, ...args: any[]) => {
        const name = String(file);
        if (name === `/boot/config-${SERVER_PROFILE.clockError.kernelRelease}` && admissionReadArmed && mode === 'read-EIO') {
          injectedReads++; throw Object.assign(new Error('fresh admission config read'), { code: 'EIO' });
        }
        if (clock.files[name as keyof typeof clock.files]) return clock.files[name as keyof typeof clock.files].text;
        if (name === '/proc/self/status') return 'Cpus_allowed_list:\t0\nvoluntary_ctxt_switches:\t0\nnonvoluntary_ctxt_switches:\t0\n';
        if (name === '/proc/self/cgroup') return resource.membership.text;
        if (name === '/proc/self/mountinfo') return resource.mountinfo.text;
        if (name === '/proc/self/stat') return '123 (fixture) ' + ['S', ...Array(50).fill('0')].join(' ');
        if (name === '/sys/kernel/sched_ext/state') return 'disabled';
        for (const scope of resource.scopes) for (const [suffix, field] of [['cgroup.type', 'type'], ['cpu.max', 'cpuMax'], ['cpu.max.burst', 'burst'],
          ['memory.max', 'memoryMax'], ['cgroup.controllers', 'controllers'], ['cgroup.subtree_control', 'subtreeControl']]) {
          if (name === scope.directory + '/' + suffix) {
            const value = (scope as any)[field];
            if (value.text !== undefined) return value.text;
            throw Object.assign(new Error('fixture absent root interface'), { code: value.error?.code ?? 'ENOENT' });
          }
        }
        if (name.endsWith('/cpu.stat')) return 'usage_usec 100\nuser_usec 70\nsystem_usec 30\nnr_periods 20\nnr_throttled 2\nthrottled_usec 50';
        if (name.replaceAll('\\', '/').endsWith('/package.json')) return JSON.stringify({ name: path.basename(path.dirname(name)), version: '1.0.0',
          exports: { '.': { import: { default: './dist/index.js' } }, './animate': { import: { default: './dist/animate/index.js' } },
            './driver': { import: { default: './dist/driver/index.js' } } } });
        if (name.endsWith('.entry.mjs')) return 'export const fixture = true;';
        if (name.startsWith('/proc/') || name.startsWith('/sys/')) throw Object.assign(new Error('unexpected boundary read: ' + name), { code: 'ENOENT' });
        return (realRead as any)(file, ...args);
      }) as any);
      spy(vi.spyOn(fsBoundary, 'readlinkSync')).mockImplementation(((file: keyof typeof clock.namespaces) => {
        const value = clock.namespaces[file];
        if ('error' in value) throw Object.assign(new Error(value.error.message), { code: value.error.code });
        return value.target;
      }) as any);
      spy(vi.spyOn(fsBoundary, 'realpathSync')).mockImplementation(((file: any, ...args: any[]) => {
        const name = String(file);
        return name === path.join(directory, 'baseline') || name === path.join(directory, 'candidate') || name.replaceAll('\\', '/').includes('/bench/compare/node_modules/')
          || name.startsWith(path.join(out, 'consumers') + path.sep) || name.startsWith(path.join(out, 'packages') + path.sep)
          ? name : (realPath as any)(file, ...args);
      }) as any);
      spy(vi.spyOn(fsBoundary, 'statSync')).mockImplementation(((file: any, ...args: any[]) => {
        const scope = resource.scopes.find(item => item.directory === String(file));
        return scope ? { dev: BigInt(scope.dev), ino: BigInt(scope.ino), isDirectory: () => true } : (realStat as any)(file, ...args);
      }) as any);
      spy(vi.spyOn(fsBoundary, 'existsSync')).mockImplementation(((file: any) => String(file).startsWith('/sys/') ? false : realExists(file)) as any);
      spy(vi.spyOn(fsBoundary, 'statfsSync')).mockReturnValue({ type: 0x63677270n } as any);
      spy(vi.spyOn(fsBoundary, 'symlinkSync')).mockImplementation(() => {});
      spy(vi.spyOn(fsBoundary, 'appendFileSync')).mockImplementation(((file: any, text: any, options: any) => {
        realAppend(file, text, options);
        if (mode === 'healthy-admitted' && JSON.parse(String(text)).type === 'registration-before-any-sample') controller.abort(new Error('stop after healthy publication'));
      }) as any);
      spy(vi.spyOn(processBoundary, 'spawnSync')).mockImplementation(((_command: string, args: string[]) => clock.packages.find(item => item.args[2] === args[2])) as any);
      spy(vi.spyOn(processBoundary, 'execFileSync')).mockReturnValue('' as any);
      spy(vi.spyOn(osBoundary, 'release')).mockReturnValue(SERVER_PROFILE.clockError.kernelRelease);
      spy(vi.spyOn(osBoundary, 'arch')).mockReturnValue('x64');
      spy(vi.spyOn(osBoundary, 'platform')).mockReturnValue('linux');
      spy(vi.spyOn(osBoundary, 'cpus')).mockReturnValue([{ model: 'fixture' }] as any);
      const hashFile = (file: string) => file === process.execPath ? SERVER_PROFILE.clockError.nodeExecutableSha256 :
        file === '/fixture/chromium' ? SERVER_PROFILE.clockError.browserExecutableSha256 : hash;
      vi.doMock('../bench/compare/provenance.mjs', () => ({ ...provenanceOwner,
        prepareBenchmarkCheckout: ({ root }: any) => path.basename(root) === 'baseline' ? registration.provenance.baseline : registration.provenance.candidate,
        hashFileTree: () => ({ sha256: hash, files: 1 }), sha256File: hashFile,
        assertCheckoutUnchanged: provenanceVerify, assertInstalledPackageTreesUnchanged: provenanceVerify, assertFileHashesUnchanged: provenanceVerify }));
      vi.doMock('../bench/profile/server-thread-cpu-clock.mjs', () => ({ ...threadCpuClock,
        prepareServerThreadCpuClock: () => ({ metadata: registration.engineClock, assertUnchanged: nativeVerify }) }));
      vi.doMock('../bench/compare/bench.mjs', () => ({ ...compareOwner, startBenchmarkOrigin: async () => ({ close: closeOrigin }) }));
      spy(vi.spyOn(moduleBoundary, 'createRequire')).mockImplementation(((file: any) => String(file).replaceAll('\\', '/').endsWith('/bench/compare/package.json')
        ? (name: string) => name === 'esbuild' ? { build: vi.fn(async () => ({ metafile: { inputs: {} } })) } : { chromium: { executablePath: () => '/fixture/chromium', launch: async () => browser } }
        : realRequire(file)) as any);
      vi.doMock('node:fs', () => fsBoundary);
      vi.doMock('node:child_process', () => processBoundary);
      vi.doMock('node:module', () => moduleBoundary);
      vi.doMock('node:os', () => ({ ...osBoundary, default: osBoundary }));
      vi.resetModules();
      const owner = await import('../bench/profile/server-profile-runner.mjs');
      const artifact = await owner.runServerProfile({ baseline: path.join(directory, 'baseline'), candidate: path.join(directory, 'candidate'), browser: 'chromium', out },
        { signal: controller.signal, engineMeasure: controls, browserMeasure: controls });
      const bytes = realRead(path.join(out, 'server-profile.json'));
      const stored = parseServerJsonBytes(bytes), records = parseServerJournalBytes(realRead(path.join(out, 'journal.ndjson')));
      expect(stored).toEqual(JSON.parse(JSON.stringify(artifact)));
      expect(validateServerArtifact(stored), JSON.stringify(artifact.failures)).toMatchObject({ verification: mode === 'healthy-admitted' ? 'recorded-refusal-only' : 'preparation-refused', verdict: 'UNPROVEN' });
      expect(() => validateServerJournal(stored, records)).not.toThrow();
      expect(controls).not.toHaveBeenCalled(); expect(artifact.stages).toEqual([]);
      expect(closeBrowser).toHaveBeenCalledTimes(1); expect(closeOrigin).toHaveBeenCalledTimes(1);
      expect(nativeVerify).toHaveBeenCalled(); expect(provenanceVerify).toHaveBeenCalled();
      if (mode === 'healthy-admitted') {
        expect(artifact.registrationDigest).toBe(serverProfileDigest(artifact.registration));
        expect(records[0].type).toBe('registration-before-any-sample');
      } else {
        expect(artifact.registration).toBeNull(); expect(artifact.registrationDigest).toBeNull();
        expect(artifact.failures[0].error.raw.clockBuildEvidence).toBeDefined();
        expect(records.map((record: any) => record.type)).toEqual(['failure', 'finished']);
        if (mode === 'read-EIO') {
          expect(injectedReads).toBe(1);
          expect(artifact.failures[0].error.raw.clockBuildEvidence.files[`/boot/config-${SERVER_PROFILE.clockError.kernelRelease}`].error.code).toBe('EIO');
        }
      }
    } finally {
      for (const value of spies.reverse()) value.mockRestore();
      vi.doUnmock('../bench/compare/provenance.mjs'); vi.doUnmock('../bench/profile/server-thread-cpu-clock.mjs'); vi.doUnmock('../bench/compare/bench.mjs');
      for (const name of ['node:fs', 'node:child_process', 'node:module', 'node:os']) vi.doUnmock(name);
      vi.resetModules(); Object.defineProperty(process, 'version', nodeVersion); rmSync(directory, { recursive: true, force: true });
    }
  });

  it('реальный ESM collector читает healthy namespace через собственный import binding', async () => {
    const evidence = healthyClockBuildEvidence();
    const fsBoundary = { ...filesystem }, processBoundary = { ...childProcess }, osBoundary = { ...os };
    const read = vi.spyOn(fsBoundary, 'readFileSync').mockImplementation(((file: string) => {
      const value = evidence.files[file as keyof typeof evidence.files];
      if (!value) throw Object.assign(new Error('fixture missing read'), { code: 'ENOENT' });
      return value.text;
    }) as any);
    const link = vi.spyOn(fsBoundary, 'readlinkSync').mockImplementation(((file: keyof typeof evidence.namespaces) => {
      const value = evidence.namespaces[file];
      if ('error' in value) throw Object.assign(new Error(value.error.message), { code: value.error.code });
      return value.target;
    }) as any);
    const query = vi.spyOn(processBoundary, 'spawnSync').mockImplementation(((_command: string, args: string[]) =>
      evidence.packages.find(record => record.args[2] === args[2])) as any);
    const release = vi.spyOn(osBoundary, 'release').mockReturnValue(SERVER_PROFILE.clockError.kernelRelease);
    try {
      vi.doMock('node:fs', () => fsBoundary);
      vi.doMock('node:child_process', () => processBoundary);
      vi.doMock('node:os', () => ({ ...osBoundary, default: osBoundary }));
      vi.resetModules();
      const owner = await import('../bench/profile/server-profile-runner.mjs');
      const captured = owner.captureServerClockBuildEvidence();
      expect(verifyServerClockBuildEvidence(captured, { release: SERVER_PROFILE.clockError.kernelRelease, arch: 'x64' }))
        .toMatchObject({ configSha256: SERVER_PROFILE.clockError.kernelBuild.configSha256, active: 'time:[4026531834]', children: 'time:[4026531834]' });
      expect(link).toHaveBeenCalledTimes(3); expect(query).toHaveBeenCalledTimes(2);
      expect(captured.namespaces['/proc/1/ns/time'].error.code).toBe('EACCES');
    } finally {
      read.mockRestore(); link.mockRestore(); query.mockRestore(); release.mockRestore();
      for (const name of ['node:fs', 'node:child_process', 'node:os']) vi.doUnmock(name);
      vi.resetModules();
    }
  });

  it.each(buildFaults)('реальная registration admission отвергает %s при прежнем release', (fault) => {
    const registration: any = registeredRefusal().registration;
    expect(() => verifyServerClockRegistration(registration)).not.toThrow();
    registration.machine.identity.clockBuildEvidence = mutateClockBuild(registration.machine.identity.clockBuildEvidence, fault);
    registration.machine.sha256 = serverProfileDigest(registration.machine.identity);
    expect(() => verifyServerClockRegistration(registration)).toThrow(/clock build/);
  });

  it('реальные timing stage и candidate control не вызывают callback при невалидной verify boundary', async () => {
    const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('    const runStage = async (name, runs) => {');
    const end = source.indexOf('    if (!await runServerProfileCalibration(', begin);
    const rawStart = source.indexOf('    verify();\n    artifact.rawControls.candidate =');
    const rawEnd = source.indexOf("    journal('raw-controls-candidate-after-calibration'", rawStart);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    expect(rawStart).toBeGreaterThan(0); expect(rawEnd).toBeGreaterThan(rawStart);
    const registration: any = registeredRefusal().registration;
    const current = mutateClockBuild(healthyClockBuildEvidence(), 'config');
    const verify = () => verifyServerClockBuildEvidence(current, registration.machine.identity);
    const callback = vi.fn(), artifact: any = { stages: [], rawControls: {} };
    const context = createContext({ verify, artifact, SERVER_PROFILE, checkpoint: vi.fn(),
      captureServerLoad: callback, engineMeasure: callback, browserMeasure: callback, serverOrders,
      process: { stderr: { write: vi.fn() } }, measureBrowserRawControls: callback });
    const runStage = runInContext(`(() => { ${source.slice(begin, end)} return runStage; })()`, context);
    await expect(runStage('warmup', 2)).rejects.toThrow(/clock build/);
    const candidateControl = runInContext(`(async () => { ${source.slice(rawStart, rawEnd)} })`, context);
    await expect(candidateControl()).rejects.toThrow(/clock build/);
    expect(callback).not.toHaveBeenCalled();
    expect(artifact.stages).toEqual([]); expect(artifact.rawControls).toEqual({});
  });

  it('здоровый witness допускает другой namespace нового run и unrelated diagnostics/init link EACCES', () => {
    const registration: any = registeredRefusal().registration, evidence = registration.machine.identity.clockBuildEvidence;
    const original = verifyServerClockBuildEvidence(evidence, registration.machine.identity);
    evidence.files['/proc/version'].text = 'different harmless diagnostic';
    evidence.files['/proc/cmdline'].text = 'different harmless boot args';
    evidence.namespaces['/proc/1/ns/time'].error.message = 'different permission diagnostic';
    expect(verifyServerClockBuildEvidence(evidence, registration.machine.identity)).toEqual(original);
    evidence.namespaces['/proc/self/ns/time'].target = evidence.namespaces['/proc/self/ns/time_for_children'].target = 'time:[5555]';
    expect(() => verifyServerClockRegistration(registration)).not.toThrow();
  });

  it.each(['config', 'modules-package', 'children-namespace', 'self-offset', 'active-namespace-drift', 'unrelated'] as const)
  ('реальная verify boundary %s до registration journal/raw controls и callbacks', (fault) => {
    const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('  const verify = (registration = artifact.registration) => {'), end = source.indexOf('\n  try {\n    checkpoint();', begin);
    const registration: any = registeredRefusal().registration, current: any = clone(registration.machine.identity.clockBuildEvidence);
    const journal = vi.fn(), measure = vi.fn(async () => ({}));
    const context = createContext({ engineClock: undefined, artifact: { registration }, dependencies: {},
      captureServerClockBuildEvidence: () => current, verifyServerClockBuildEvidence,
      release: () => SERVER_PROFILE.clockError.kernelRelease, arch: () => 'x64', serverProfileDigest,
      captureServerLoad: () => ({ affinity: registration.machine.identity.affinity, resource: registration.machine.identity.resource }),
      serverResourceBinding, prepared: {}, packages: {}, harness: {}, assertFileHashesUnchanged: vi.fn(),
      // Stable consumer bytes remain real verify conditions, their reads are boundary fakes.
      sha256File: () => hash, hashFileTree: () => ({ sha256: hash }),
      checkpoint: vi.fn(), journal, measureBrowserRawControls: measure, browser: {}, origin: {}, adapters: { baseline: {} }, out: '/fixture',
      verifyServerClockRegistration, registrationAttempt: registration });
    const verify = runInContext(`(() => { ${source.slice(begin, end)} return verify; })()`, context);
    context.verify = verify;
    if (fault === 'unrelated') {
      current.files['/proc/cmdline'].text += ' unrelated';
      current.namespaces['/proc/1/ns/time'].error.message = 'other diagnostic';
    } else if (fault === 'active-namespace-drift') {
      current.namespaces['/proc/self/ns/time'].target = current.namespaces['/proc/self/ns/time_for_children'].target = 'time:[5555]';
    } else mutateClockBuild(current, fault);
    const admissionStart = source.indexOf('    verifyServerClockRegistration(registrationAttempt);');
    const admissionEnd = source.indexOf("    journal('raw-controls-baseline'", admissionStart);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    expect(admissionStart).toBeGreaterThan(0); expect(admissionEnd).toBeGreaterThan(admissionStart);
    const admit = runInContext(`(async () => { ${source.slice(admissionStart, admissionEnd)} })`, context);
    if (fault === 'unrelated') {
      return admit().then(() => { expect(journal).toHaveBeenCalledTimes(1); expect(measure).toHaveBeenCalledTimes(1); });
    }
    return expect(admit()).rejects.toMatchObject({ name: 'Error', raw: { clockBuildEvidence: current } }).then(() => {
      expect(journal).not.toHaveBeenCalled(); expect(measure).not.toHaveBeenCalled();
    });
  });
});

describe('PROFILE: ресурсный контракт проверяется до регистрации и samples', () => {
  const keys = ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'];
  const healthy = { usage_usec: 100, user_usec: 70, system_usec: 30, nr_periods: 20, nr_throttled: 2, throttled_usec: 50 };
  function expectResourceValidatorRefusal(errors: unknown[]) {
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: 'Error' });
  }

  function machine(quota: string | null = '400000 100000', counters: Record<string, number> = healthy, sourceOverride?: string,
    resourceValidator: typeof validateServerResourceIdentity = validateServerResourceIdentity) {
    const source = sourceOverride ?? readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8');
    const common = source.slice(source.indexOf('function readOptional('), source.indexOf('async function withBrowserTimeout('));
    const capture = source.slice(source.indexOf('export function captureServerClockBuildEvidence('), source.indexOf('export function createServerJournal(')).replace(/^export /gm, '');
    const leaf = '/sys/fs/cgroup/system.slice/hosted-compute-agent.service';
    const identity = resourceIdentity(), clockEvidence = healthyClockBuildEvidence();
    const files: Record<string, string> = {
      '/proc/self/status': 'Cpus_allowed_list:\t0\nvoluntary_ctxt_switches:\t2\nnonvoluntary_ctxt_switches:\t3\n',
      '/proc/self/cgroup': identity.membership.text, '/proc/self/mountinfo': identity.mountinfo.text,
      '/proc/self/stat': '123 (fixture with spaces) ' + ['S', ...Array(50).fill('0')].join(' '),
      '/sys/kernel/sched_ext/state': 'disabled\n',
      ...Object.fromEntries(Object.entries(clockEvidence.files).map(([file, value]) => [file, value.text])),
    };
    for (const scope of identity.scopes) {
      files[scope.directory + '/cgroup.controllers'] = 'cpu memory';
      files[scope.directory + '/cgroup.subtree_control'] = scope.path === '/system.slice/hosted-compute-agent.service' ? '' : 'cpu memory';
      if (scope.path !== '/') {
        files[scope.directory + '/cgroup.type'] = 'domain';
        files[scope.directory + '/cpu.max'] = '400000 100000';
        files[scope.directory + '/cpu.stat'] = Object.entries(healthy).map(([key, value]) => key + ' ' + value).join('\n');
      }
    }
    files[leaf + '/cpu.stat'] = Object.entries(counters).map(([key, value]) => key + ' ' + value).join('\n');
    if (quota === null) delete files[leaf + '/cpu.max']; else files[leaf + '/cpu.max'] = quota;
    const hashBinary = vi.fn(() => hash), reads: string[] = [], validatorErrors: unknown[] = [];
    const errors: Record<string, string> = {}, inodes: Record<string, bigint> = {}, onRead: Record<string, () => void> = {};
    const objects: Record<string, { directory?: boolean; fsType?: bigint; statError?: string; fsError?: string }> = {};
    const host = { release: SERVER_PROFILE.clockError.kernelRelease };
    // Точные функции owner, независимые файлы; без пакетов, CPU и браузера.
    const realm = createContext({
      readFileSync(file: string) {
        reads.push(file); onRead[file]?.();
        if (errors[file] || !Object.hasOwn(files, file)) throw Object.assign(new Error('fixture read: ' + file), { code: errors[file] ?? 'ENOENT' });
        return files[file];
      },
      readlinkSync(file: keyof typeof clockEvidence.namespaces) {
        const value = clockEvidence.namespaces[file];
        if (!value) throw Object.assign(new Error('fixture link: ' + file), { code: 'ENOENT' });
        if ('error' in value) throw Object.assign(new Error(value.error.message), { code: value.error.code });
        return value.target;
      },
      spawnSync(_command: string, args: string[]) {
        return clockEvidence.packages.find(record => record.args[2] === args[2])
          ?? { status: 1, signal: null, stdout: '', stderr: 'package not found' };
      },
      verifyServerClockBuildEvidence: (value: unknown, machine: unknown) => verifyServerClockBuildEvidence(JSON.parse(JSON.stringify(value)), machine),
      statSync: (file: string) => {
        if (objects[file]?.statError) throw Object.assign(new Error('fixture stat'), { code: objects[file]!.statError });
        return { dev: 31n, ino: inodes[file] ?? BigInt(file.length), isDirectory: () => objects[file]?.directory ?? true };
      },
      statfsSync: (file: string) => {
        if (objects[file]?.fsError) throw Object.assign(new Error('fixture statfs'), { code: objects[file]!.fsError });
        return { type: objects[file]?.fsType ?? 0x63677270n };
      }, path,
      errorRecord: (error: Error & { code?: string }) => ({ message: error.message, code: error.code }),
      validateServerResourceIdentity(value: unknown) {
        try { return resourceValidator(JSON.parse(JSON.stringify(value))); }
        catch (error) { validatorErrors.push(error); throw error; }
      },
      serverResourceBinding: (value: unknown) => serverResourceBinding(JSON.parse(JSON.stringify(value))),
      existsSync: (file: string) => Object.hasOwn(files, file), loadavg: () => [0, 0, 0],
      platform: () => 'linux', release: () => host.release, arch: () => 'x64', hostname: () => 'fixture',
      cpus: () => [{ model: 'fixture' }], totalmem: () => 1024, sha256File: hashBinary, serverProfileDigest,
      process: { version: 'v24.19.0', execPath: '/fixture/node', execArgv: [], memoryUsage: () => ({ heapUsed: 1 }) },
    });
    const owner = runInContext(common + '\n' + capture + '\n({ captureServerMachine, captureServerClockBuildEvidence });', realm);
    return { capture: owner.captureServerMachine, collect: owner.captureServerClockBuildEvidence, hashBinary, files, errors, inodes, reads, leaf, onRead, clockEvidence, objects, host, validatorErrors };
  }

  it('prior cgroup owner counterexample loses captured object on owned rejection', () => {
    const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('    let info, fs;'), end = source.indexOf('    scopes.push(', begin);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    // Exact minimal pre-fix block from 5e0f5e87; deliberate mutation of the current owner.
    const priorBlock = "    let object;\n    try {\n      const info = statSync(directory, { bigint: true }), fs = statfsSync(directory, { bigint: true });\n      object = { dev: String(info.dev), ino: String(info.ino), fsType: String(fs.type) };\n      if (!info.isDirectory() || fs.type !== 0x63677270n) refuse('объект не cgroup2 directory');\n    } catch (error) { throw Object.assign(new Error('server profile: cgroup object недоступен; до samples'), { raw: { ...raw, directory, error: errorRecord(error) } }); }\n";
    const prior = source.slice(0, begin) + priorBlock + source.slice(end);
    const fixture = machine('400000 100000', healthy, prior);
    fixture.objects[fixture.leaf] = { directory: false };
    let caught: any;
    try { fixture.capture(); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(caught.raw.object).toBeUndefined();
    expect(caught.raw.error).toBeDefined();
  });

  it('valid cgroup object retains identity', () => {
    const fixture = machine();
    const captured = fixture.capture();
    expect(captured.identity.resource.scopes[0]).toMatchObject({ dev: '31', ino: String(fixture.leaf.length), fsType: String(0x63677270) });
  });

  it.each(['non-directory', 'wrong-filesystem', 'stat-error', 'statfs-error'] as const)
  ('cgroup object diagnostic distinguishes %s', (fault) => {
    const fixture = machine();
    fixture.objects[fixture.leaf] = fault === 'non-directory' ? { directory: false }
      : fault === 'wrong-filesystem' ? { fsType: 0x1234n }
        : fault === 'stat-error' ? { statError: 'EACCES' } : { fsError: 'EIO' };
    let caught: any;
    try { fixture.capture(); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(caught.raw.directory).toBe(fixture.leaf);
    if (fault === 'stat-error' || fault === 'statfs-error') {
      expect(caught.raw.error.code).toBe(fault === 'stat-error' ? 'EACCES' : 'EIO');
      expect(caught.raw.object).toBeUndefined();
    } else {
      expect(caught.raw.error).toBeUndefined();
      expect(caught.raw.object).toEqual({ dev: '31', ino: String(fixture.leaf.length),
        fsType: String(fault === 'wrong-filesystem' ? 0x1234 : 0x63677270) });
    }
  });

  it.each(['config', 'signature', 'modules-package', 'read-error', 'children-namespace', 'self-offset'] as const)
  ('реальный machine capture отвергает current-run %s до admission с сохранёнными observations', (fault) => {
    const fixture = machine();
    if (fault === 'modules-package' || fault === 'children-namespace') mutateClockBuild(fixture.clockEvidence, fault);
    else if (fault === 'read-error') fixture.errors[`/boot/config-${SERVER_PROFILE.clockError.kernelRelease}`] = 'EIO';
    else {
      const evidence = mutateClockBuild(healthyClockBuildEvidence(), fault);
      for (const [file, value] of Object.entries(evidence.files) as [string, { text: string }][]) fixture.files[file] = value.text;
    }
    let caught: any;
    try { fixture.capture(); } catch (error) { caught = error; }
    expect(caught?.message).toContain('clock build');
    expect(caught.raw.clockBuildEvidence).toBeDefined();
    expect(caught.raw.machine.identity.affinity).toBe('0');
    expect(caught.raw.machine.identity.resource.scopes).toHaveLength(3);
    expect(fixture.hashBinary).toHaveBeenCalled();
    expect(fixture.reads).toContain('/proc/self/status');
  });

  it('kernel mismatch and inaccessible resource preserve both raw witnesses without admitted machine', () => {
    const fixture = machine();
    fixture.host.release += '-changed';
    fixture.objects[fixture.leaf] = { statError: 'EACCES' };
    let caught: any;
    try { fixture.capture(); } catch (error) { caught = error; }
    expect(caught.raw.error.code).toBe('EACCES');
    expect(caught.raw.directory).toBe(fixture.leaf);
    expect(caught.raw.clockBuildEvidence).toBeDefined();
    expect(caught.raw.machine).toBeUndefined();
    expect(() => verifyServerClockBuildEvidence(caught.raw.clockBuildEvidence, { release: fixture.host.release, arch: 'x64' }))
      .toThrow(/clock build/);
    expect(fixture.hashBinary).not.toHaveBeenCalled();
  });

  it('kernel mismatch retains available identity and resources but refuses admission', () => {
    const fixture = machine();
    fixture.host.release += '-changed';
    let caught: any;
    try { fixture.capture(); } catch (error) { caught = error; }
    expect(caught?.message).toContain('clock build');
    expect(caught.raw.machine.identity).toMatchObject({ release: fixture.host.release, affinity: '0', cpu: 'fixture',
      logicalCpus: 1, totalMemoryBytes: 1024, node: 'v24.19.0', cgroupCpuMax: '400000 100000' });
    expect(caught.raw.machine.identity.resource.scopes).toHaveLength(3);
    expect(caught.raw.machine.sha256).toBe(serverProfileDigest(caught.raw.machine.identity));
    expect(caught.raw.clockBuildEvidence).toBeDefined();
    expect(() => verifyServerClockBuildEvidence(caught.raw.clockBuildEvidence, caught.raw.machine.identity)).toThrow(/clock build/);
  });

  it('capture самостоятельно собирает witness без supplied historical evidence', () => {
    const fixture = machine(), captured = fixture.capture();
    expect(captured.identity.clockBuildEvidence.files[`/boot/config-${SERVER_PROFILE.clockError.kernelRelease}`].text).toBe(qualifiedConfig);
    expect(verifyServerClockBuildEvidence(JSON.parse(JSON.stringify(captured.identity.clockBuildEvidence)), captured.identity).configSha256)
      .toBe(SERVER_PROFILE.clockError.kernelBuild.configSha256);
    expect(captured.identity.clockBuildEvidence.namespaces['/proc/1/ns/time'].error.code).toBe('EACCES');
    expect(fixture.reads.filter(file => file === '/proc/version_signature')).toHaveLength(1);
  });

  it('разрешает наблюдённую service membership и сохраняет квоту предка без округления', () => {
    // Given: root не имеет cpu.max, service unlimited, parent имеет 1/2 CPU.
    const fixture = machine('max 100000');
    fixture.files['/sys/fs/cgroup/system.slice/cpu.max'] = '50000 100000';
    // When
    const captured = fixture.capture();
    // Then
    expect(captured.identity.resource.scopes.map((scope: { path: string }) => scope.path)).toEqual([
      '/system.slice/hosted-compute-agent.service', '/system.slice', '/',
    ]);
    expect(validateServerResourceIdentity(JSON.parse(JSON.stringify(captured.identity.resource))).cpuCeiling).toEqual({ numerator: '50000', denominator: '100000' });
    expect(fixture.reads).toContain(fixture.leaf + '/cpu.stat');
    expect(fixture.reads).not.toContain('/sys/fs/cgroup/cpu.stat');
  });

  it('принимает policy 0 с явным disabled и пустым subtree_control populated leaf', () => {
    // Given
    const fixture = machine();
    // When
    const captured = fixture.capture();
    // Then
    expect(captured.identity.resource.scheduler).toBe('0');
    expect(captured.identity.resource.schedExtState).toEqual({ model: 'linux-v6.18.44-v7.0-sched-ext-state', text: 'disabled' });
    expect(captured.identity.resource.scopes[0].subtreeControl).toEqual({ text: '' });
    expect(() => validateServerResourceIdentity(JSON.parse(JSON.stringify(captured.identity.resource)))).not.toThrow();
  });

  it.each(['enabled', 'enabling', 'disabling', 'unknown', '', 'disabled\nenabled'])(
    'отказывает policy 0 при sched_ext state=%j до hashing/setup', (state) => {
      // Given: политика не меняется при full-switch sched_ext.
      const fixture = machine(); fixture.files['/sys/kernel/sched_ext/state'] = state;
      // When / Then
      expect(() => fixture.capture()).toThrow(/sched_ext/);
      expect(fixture.hashBinary).not.toHaveBeenCalled();
    });

  it.each(['ENOENT', 'EACCES', 'EIO'])('сохраняет sched_ext read %s как unknown, не disabled', (code) => {
    // Given
    const fixture = machine(); fixture.errors['/sys/kernel/sched_ext/state'] = code;
    // When / Then
    expect(() => fixture.capture()).toThrow(/sched_ext applicability unknown/);
    expect(fixture.hashBinary).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'unknown', 'missing', 'wrong-model', 'read-error'])(
    'независимый artifact validator отвергает sched_ext %s даже с новым digest', (fault) => {
      // Given
      const value = registeredRefusal();
      const witness = fault === 'missing' ? undefined : fault === 'read-error'
        ? { model: 'linux-v6.18.44-v7.0-sched-ext-state', text: 'disabled', error: { code: 'EIO', message: 'unreadable' } }
        : { model: fault === 'wrong-model' ? 'unqualified' : 'linux-v6.18.44-v7.0-sched-ext-state',
          text: fault === 'wrong-model' ? 'disabled' : fault };
      Object.assign(value.registration.machine.identity.resource, { schedExtState: witness });
      value.registration.machine.sha256 = serverProfileDigest(value.registration.machine.identity);
      value.registrationDigest = serverProfileDigest(value.registration);
      // When / Then
      expect(() => validateServerArtifact(value)).toThrow(/sched_ext/);
    });

  it('отвергает sched_ext включение на точном событии чтения counters', () => {
    // Given
    const fixture = machine();
    fixture.onRead[fixture.leaf + '/cpu.stat'] = () => { fixture.files['/sys/kernel/sched_ext/state'] = 'enabled'; };
    // When / Then
    expect(() => fixture.capture()).toThrow(/sched_ext/);
    expect(fixture.hashBinary).not.toHaveBeenCalled();
  });

  it('owner передаёт ancestor throttle при неизменном leaf независимому validator', () => {
    // Given
    const fixture = machine(), before = fixture.capture(), value = stage();
    const block = value.blocks[0]; if (!block) throw new Error('missing fixture block');
    fixture.files['/sys/fs/cgroup/system.slice/cpu.stat'] = Object.entries({ ...healthy, nr_throttled: 3 })
      .map(([key, count]) => key + ' ' + count).join('\n');
    // When
    const after = fixture.capture();
    block.before = JSON.parse(JSON.stringify(before.observation.resource));
    block.after = JSON.parse(JSON.stringify(after.observation.resource));
    block.delta = { usage_usec: 0, user_usec: 0, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
    block.scopeDeltas = [{ path: '/system.slice/hosted-compute-agent.service', delta: { ...block.delta } },
      { path: '/system.slice', delta: { ...block.delta, nr_throttled: 1 } }];
    const reasons = serverResourceReasons([value], JSON.parse(JSON.stringify(before.identity)));
    // Then
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/throttling: \/system\.slice$/);
    expect(block.before.cpuStat).toEqual(block.after.cpuStat);
  });

  it('перенос mountpoint остаётся частным знанием owner', () => {
    // Given
    const fixture = machine(), before = fixture.capture().identity.resource;
    for (const [file, value] of Object.entries(fixture.files)) if (file.startsWith('/sys/fs/cgroup/')) {
      fixture.files[file.replace('/sys/fs/cgroup', '/run/cgroup space')] = value; delete fixture.files[file];
    }
    fixture.files['/proc/self/mountinfo'] = resourceIdentity().mountinfo.text.replace('/sys/fs/cgroup', '/run/cgroup\\040space');
    // When
    const result = fixture.capture().identity.resource;
    // Then
    expect(result.scopes.map((scope: { path: string }) => scope.path)).toEqual(before.scopes.map((scope: { path: string }) => scope.path));
    expect(result.scopes[0].directory).toBe('/run/cgroup space/system.slice/hosted-compute-agent.service');
  });

  it.each(['bind', 'alias', 'overmount', 'missing-membership', 'duplicate-membership', 'parent-traversal', 'namespace-root', 'threaded', 'cpu-disabled', 'denied', 'period-zero', 'duplicate-counter', 'scheduler'])(
    'отказывает unsupported topology %s до hashing/setup', (fault) => {
      // Given
      const fixture = machine();
      expect(fixture.capture().identity.resource.scopes).toHaveLength(3);
      fixture.hashBinary.mockClear();
      switch (fault) {
        case 'bind': fixture.files['/proc/self/mountinfo'] = resourceIdentity().mountinfo.text.replace('0:31 / ', '0:31 /system.slice '); break;
        case 'alias': fixture.files['/proc/self/mountinfo'] += '\n38 31 0:31 / /alias rw - cgroup2 cgroup2 rw'; break;
        case 'overmount': fixture.files['/proc/self/mountinfo'] += '\n38 37 0:32 / /sys/fs/cgroup/system.slice rw - tmpfs tmpfs rw'; break;
        case 'missing-membership': fixture.files['/proc/self/cgroup'] = '1:cpu:/service'; break;
        case 'duplicate-membership': fixture.files['/proc/self/cgroup'] += '\n0::/other'; break;
        case 'parent-traversal': fixture.files['/proc/self/cgroup'] = '0::/../service'; break;
        case 'namespace-root': fixture.files['/sys/fs/cgroup/cgroup.type'] = 'domain'; break;
        case 'threaded': fixture.files[fixture.leaf + '/cgroup.type'] = 'domain threaded'; break;
        case 'cpu-disabled': fixture.files['/sys/fs/cgroup/system.slice/cgroup.subtree_control'] = 'memory'; break;
        case 'denied': fixture.errors[fixture.leaf + '/cpu.max'] = 'EACCES'; break;
        case 'period-zero': fixture.files[fixture.leaf + '/cpu.max'] = '100000 0'; break;
        case 'duplicate-counter': fixture.files[fixture.leaf + '/cpu.stat'] += '\nnr_throttled 0'; break;
        case 'scheduler': fixture.files['/proc/self/stat'] = '123 (fixture) ' + Array(51).fill('1').join(' '); break;
        default: throw new Error('unknown fixture mutation: ' + fault);
      }
      const membership = { text: fixture.files['/proc/self/cgroup'] };
      const mountinfo = { text: fixture.files['/proc/self/mountinfo'] };
      const leaf = '/system.slice/hosted-compute-agent.service';
      const expectedRaw: Record<string, object> = {
        bind: { membership, mountinfo, mount: { root: '/system.slice' } },
        alias: { membership, mountinfo },
        overmount: { membership, mountinfo, mount: { point: '/sys/fs/cgroup' } },
        'missing-membership': { membership, mountinfo },
        'duplicate-membership': { membership, mountinfo },
        'parent-traversal': { membership, mountinfo },
        'namespace-root': { resource: { scopes: [{ path: leaf }, { path: '/system.slice' }, { path: '/', type: { text: 'domain' } }] } },
        threaded: { resource: { scopes: [{ path: leaf, type: { text: 'domain threaded' } }, { path: '/system.slice' }, { path: '/' }] } },
        'cpu-disabled': { resource: { scopes: [{ path: leaf }, { path: '/system.slice', subtreeControl: { text: 'memory' } }, { path: '/' }] } },
        denied: { resource: { scopes: [{ path: leaf, cpuMax: { error: { code: 'EACCES' } } }, { path: '/system.slice' }, { path: '/' }] } },
        'period-zero': { resource: { scopes: [{ path: leaf, cpuMax: { text: '100000 0' } }, { path: '/system.slice' }, { path: '/' }] } },
        'duplicate-counter': { resource: { path: leaf, read: { text: fixture.files[fixture.leaf + '/cpu.stat'] } } },
        scheduler: { membership, mountinfo, scheduler: { text: fixture.files['/proc/self/stat'] } },
      };
      // When / Then: проверяется свидетельство отказа, не текст сообщения из другого realm.
      let caught: unknown;
      try { fixture.capture(); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ name: 'Error', raw: expectedRaw[fault] });
      if (['namespace-root', 'threaded', 'cpu-disabled', 'denied', 'period-zero'].includes(fault)) {
        expectResourceValidatorRefusal(fixture.validatorErrors);
      } else expect(fixture.validatorErrors).toHaveLength(0);
      expect(fixture.hashBinary).not.toHaveBeenCalled();
    });

  it('oracle отвергает скрытый TypeError при удалении quota invariant настоящего validator', () => {
    const source = readFileSync(new URL('../bench/profile/server-profile-contract.mjs', import.meta.url), 'utf8');
    const validatorBegin = source.indexOf('export function validateServerResourceIdentity(');
    const validatorEnd = source.indexOf('\nexport function serverResourceBinding(', validatorBegin);
    const invariantBegin = source.indexOf('function invariant(');
    const invariantEnd = source.indexOf('\nfunction positive(', invariantBegin);
    expect(validatorBegin).toBeGreaterThanOrEqual(0);
    expect(validatorEnd).toBeGreaterThan(validatorBegin);
    expect(invariantBegin).toBeGreaterThanOrEqual(0);
    expect(invariantEnd).toBeGreaterThan(invariantBegin);
    const validator = source.slice(validatorBegin, validatorEnd).replace(/^export /, '');
    const mutant = validator.replace(/^    invariant\(quota &&[^\n]*\n/m, '');
    expect(mutant).not.toBe(validator);
    const realm = createContext({ isDeepStrictEqual });
    const validateMutant = runInContext(source.slice(invariantBegin, invariantEnd) + '\n' + mutant +
      '\n(value) => validateServerResourceIdentity(JSON.parse(JSON.stringify(value)));', realm);
    const fixture = machine('400000 100000', healthy, undefined, validateMutant);
    expect(fixture.capture().identity.resource.scopes).toHaveLength(3);
    expect(fixture.validatorErrors).toHaveLength(0);
    fixture.hashBinary.mockClear();
    fixture.files[fixture.leaf + '/cpu.max'] = '100000 0';
    let caught: unknown;
    try { fixture.capture(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: 'Error', raw: { resource: { scopes: [
      { cpuMax: { text: '100000 0' } }, { path: '/system.slice' }, { path: '/' },
    ] } } });
    expect(fixture.validatorErrors).toHaveLength(1);
    expect(fixture.validatorErrors[0]).toMatchObject({ name: 'TypeError' });
    let oracleFailure: unknown;
    try { expectResourceValidatorRefusal(fixture.validatorErrors); } catch (error) { oracleFailure = error; }
    expect(oracleFailure).toMatchObject({ name: 'AssertionError' });
    expect(fixture.hashBinary).not.toHaveBeenCalled();
  });

  it('посторонний mount во время snapshot не прерывает захват машины', () => {
    // Given: изменение происходит точно между двумя configuration reads.
    const fixture = machine();
    fixture.onRead[fixture.leaf + '/cpu.stat'] = () => {
      fixture.files['/proc/self/mountinfo'] += '\n38 31 0:32 / /unrelated rw - tmpfs tmpfs rw';
    };
    // When
    const captured = fixture.capture();
    // Then
    expect(captured.identity.affinity).toBe('0');
    expect(captured.identity.resource.scopes).toHaveLength(3);
    expect(fixture.hashBinary).toHaveBeenCalledTimes(1);
  });

  it.each(['unrelated', 'mount-swap', 'ancestor'] as const)('реальный verify привязывает %s к регистрации', (change) => {
    // Given: исполнено тело verify из runner, внешние provenance effects пусты.
    const fixture = machine(), registered = fixture.capture().identity;
    const expectedArgs = healthyClockBuildEvidence().packages[0].args;
    expect(isDeepStrictEqual(registered.clockBuildEvidence.packages[0].args, expectedArgs)).toBe(false);
    expect(isDeepStrictEqual(JSON.parse(JSON.stringify(registered.clockBuildEvidence.packages[0].args)), expectedArgs)).toBe(true);
    switch (change) {
      case 'unrelated': fixture.files['/proc/self/mountinfo'] += '\n38 31 0:32 / /unrelated rw - tmpfs tmpfs rw'; break;
      case 'mount-swap': fixture.files['/proc/self/mountinfo'] = resourceIdentity().mountinfo.text.replace(/^37 /, '38 '); break;
      case 'ancestor': fixture.files['/sys/fs/cgroup/system.slice/cpu.max'] = '50000 100000'; break;
      default: { const exhaustive: never = change; throw new Error(String(exhaustive)); }
    }
    const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8');
    const begin = source.indexOf('  const verify = (registration = artifact.registration) => {');
    const end = source.indexOf('\n  try {\n    checkpoint();', begin);
    if (begin < 0 || end <= begin) throw new Error('missing runner verify body');
    const context = createContext({ engineClock: undefined, artifact: { registration: { machine: { identity: registered } } },
      captureServerClockBuildEvidence: () => healthyClockBuildEvidence(), release: () => SERVER_PROFILE.clockError.kernelRelease, arch: () => 'x64',
      verifyServerClockBuildEvidence: (value: unknown, identity: unknown) => verifyServerClockBuildEvidence(JSON.parse(JSON.stringify(value)), identity),
      captureServerLoad: () => fixture.capture().observation.resource, serverProfileDigest,
      serverResourceBinding: (value: unknown) => serverResourceBinding(JSON.parse(JSON.stringify(value))),
      registrationAttempt: { machine: { identity: registered } }, prepared: {}, packages: {}, harness: {}, assertFileHashesUnchanged: vi.fn() });
    const verify = runInContext(`(() => { ${source.slice(begin, end)} return verify; })()`, context);
    // When / Then
    if (change === 'unrelated') expect(() => verify()).not.toThrow();
    else expect(() => verify()).toThrow();
  });

  it.each(['membership', 'inode', 'quota', 'burst', 'mount-swap', 'overmount'])('отвергает %s drift во время snapshot', (fault) => {
    // Given: событие чтения счётчика меняет следующий configuration snapshot.
    const fixture = machine();
    fixture.onRead[fixture.leaf + '/cpu.stat'] = () => {
      switch (fault) {
        case 'membership': fixture.files['/proc/self/cgroup'] = '0::/other'; break;
        case 'inode': fixture.inodes[fixture.leaf] = 9000n; break;
        case 'quota': fixture.files['/sys/fs/cgroup/system.slice/cpu.max'] = '50000 100000'; break;
        case 'burst': fixture.files['/sys/fs/cgroup/system.slice/cpu.max.burst'] = '1000'; break;
        case 'mount-swap': fixture.files['/proc/self/mountinfo'] = resourceIdentity().mountinfo.text.replace(/^37 /, '38 '); break;
        case 'overmount': fixture.files['/proc/self/mountinfo'] += '\n38 37 0:32 / /sys/fs/cgroup/system.slice rw - tmpfs tmpfs rw'; break;
        default: throw new Error('unknown fixture mutation: ' + fault);
      }
    };
    // When / Then
    expect(() => fixture.capture()).toThrow();
    expect(fixture.hashBinary).not.toHaveBeenCalled();
  });

  it('stable parent limit drift не заменяет регистрацию', () => {
    // Given
    const fixture = machine(), initial = fixture.capture().identity.resource;
    fixture.files['/sys/fs/cgroup/system.slice/cpu.max'] = '200000 400000';
    // When
    const changed = fixture.capture().identity.resource;
    // Then
    expect(changed.scopes[0].cpuMax).toEqual(initial.scopes[0].cpuMax);
    expect(serverProfileDigest(changed)).not.toBe(serverProfileDigest(initial));
    expect(validateServerResourceIdentity(JSON.parse(JSON.stringify(changed))).cpuCeiling).toEqual({ numerator: '200000', denominator: '400000' });
  });

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
    expect(failure).toBeDefined();
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
      expect(failure).toBeDefined();
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
