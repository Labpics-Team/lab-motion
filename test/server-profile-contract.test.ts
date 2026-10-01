import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { SERVER_PROFILE, planServerSampleSize, serverProfileDigest, serverTailPolicy, verifyServerProfile } from '../bench/profile/server-profile-registration.mjs';
import { serverCalibrationVerdict, serverCellPairs, serverFamilyIntervals, serverMetricCells, serverOrders,
  compactServerSemanticEvidence, serverArtifactChunks, serverArtifactDigest, serverBrowserClockBounds, serverOrderStatisticBounds, serverResourceReasons,
  validateServerArtifact, validateServerBrowserSample, validateServerJournal, writeServerArtifact } from '../bench/profile/server-profile-contract.mjs';
import { deriveRealmTimerStep } from '../bench/compare/methodology.mjs';
import { measureServerBrowser } from '../bench/profile/server-profile-runner.mjs';

const hash = 'a'.repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
function pairs(runs = SERVER_PROFILE.minRuns, ratio = 1) {
  return serverMetricCells().map(({ id }) => ({ id, left: Array(runs).fill(100), right: Array(runs).fill(100 * ratio),
    leftBounds: Array.from({ length: runs }, () => ({ low: 100, high: 100 })),
    rightBounds: Array.from({ length: runs }, () => ({ low: 100 * ratio, high: 100 * ratio })) }));
}

function normalMotion(scene: any) {
  const times = scene.staggerGapMs > 0 ? [0.2, 0.5, 0.8].map((fraction) => SERVER_PROFILE.durationMs * fraction) : [SERVER_PROFILE.durationMs / 4];
  const positions = (time: number) => Array.from({ length: scene.targetsPerCall }, (_, index) =>
    SERVER_PROFILE.toPx * Math.max(0, Math.min(1, (time - scene.staggerGapMs * index) / SERVER_PROFILE.durationMs)));
  return compactServerSemanticEvidence({ valid: true, topology: { calls: 1, targetsPerCall: scene.targetsPerCall, staggerGapMs: scene.staggerGapMs,
    durationMs: SERVER_PROFILE.durationMs, toPx: SERVER_PROFILE.toPx }, callStartedAtMs: [0],
    checkpoints: times.map((time) => ({ groups: [{ readStartedMs: time, readEndedMs: time + 0.1, positions: positions(time) }] })),
    terminal: [Array(scene.targetsPerCall).fill(SERVER_PROFILE.toPx)] });
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
          const count = (scene as any).count;
          const semantic = { valid: true, targets: count, frames: 6, finished: true, pending: 0, onCompleteCalls: 0,
            previousFinished: (scene as any).lifecycle === 'fresh' ? null : true, previousCompleteCalls: 0,
            targetTraceHashes: { encoding: 'repeat', count, value: hash } };
          raw = Array.from({ length: SERVER_PROFILE.repetitions * multiplier }, () => ({ operationNs: 1_000_000, frameNs: Array(6).fill(1_000_000), cancelDrainNs: 500_000, semantic }));
          extra = { operationNs: 1_000_000 * multiplier, meanFrameNs: 1_000_000 * multiplier, cancelDrainNs: 500_000 * multiplier };
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
        samples[id] = { raw, ...extra, semantic: true, workMultiplier: multiplier, repetitions: SERVER_PROFILE.repetitions, denominator: SERVER_PROFILE.denominator };
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
    browser: 'chromium', browserVersion: SERVER_PROFILE.clockError.browserVersion, browserExecutableSha256: SERVER_PROFILE.clockError.browserExecutableSha256,
    clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError), browserTree: { sha256: hash, files: 1 },
    provenance: { baseline: provenance, candidate: { ...provenance, revision: 'b'.repeat(40) } },
    machine: { identity: machineIdentity, sha256: serverProfileDigest(machineIdentity) },
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
      if ((index + 1) % 8 === 0) events.push({ type: 'resources-block', value: { stage: name, ...current.blocks[Math.floor(index / 8)] } });
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

function chain(events: any[]) {
  let previous = '0'.repeat(64);
  return events.map((event) => {
    const payload = { sequenceDigest: previous, ...event }; previous = serverProfileDigest(payload);
    return { ...payload, digest: previous };
  });
}

// Исполняем настоящий browser owner в VM с независимым линейным DOM и
// намеренно грубыми часами. Это synthetic fault test, не performance sample.
function syntheticBrowser(options: { startCostMs?: number; snap?: boolean; snapAt?: number; cancelAt?: number; rejectTiming?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'motion-server-synthetic-'));
  const source = path.join(directory, 'adapter.js'); writeFileSync(source, '// Синтетический adapter задан VM.\n');
  let timeMs = 100, starts = 0, cancels = 0;
  const children: any[] = [];
  const position = (element: any) => element.motion ? SERVER_PROFILE.toPx * Math.max(0, Math.min(1,
    (timeMs - element.motion.startedMs - element.motion.delayMs) / element.motion.durationMs)) : element.x;
  const start = (elements: any[], to: number, duration: number, gap = 0) => {
    starts++;
    const startedMs = timeMs;
    for (const [index, element] of elements.entries()) {
      if (options.snap || starts === options.snapAt) { element.x = to; element.motion = null; }
      else element.motion = { startedMs, durationMs: duration, delayMs: index * gap };
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
  } }, document: { createElement() { return { x: 0, motion: null, isConnected: false,
    getAnimations: () => [], remove() { this.isConnected = false; } }; }, body: { appendChild(element: any) { element.isConnected = true; children.push(element); } } },
  getComputedStyle: (element: any) => ({ transform: String(position(element)) }), DOMMatrixReadOnly: class { e: number; constructor(value: string) { this.e = Number(value); } },
  setTimeout(callback: () => void, delay: number) { timeMs += delay; queueMicrotask(callback); },
  requestAnimationFrame(callback: (time: number) => void) { timeMs += 16; queueMicrotask(() => callback(timeMs)); },
  __adapterModule: { start, startStagger: start } };
  sandbox.window = sandbox;
  const realm = createContext(sandbox);
  const page = { goto: async () => {}, exposeFunction: async (name: string, fn: Function) => { sandbox[name] = fn; },
    async evaluate(fn: Function, argument?: any) {
      if (options.rejectTiming && fn.toString().includes('const raw = [], warmup')) throw undefined;
      return runInContext(`(${fn.toString()})`, realm)(argument);
    } };
  const context = { newPage: async () => page, close: async () => {} };
  return { browser: { newContext: async () => context }, adapter: { path: source },
    dispose: () => rmSync(directory, { recursive: true, force: true }), read: () => ({ starts, cancels, connected: children.filter((element) => element.isConnected).length }) };
}

describe('серверный PROFILE: clock/progress falsifiers', () => {
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

  it('endpoint snap и stateful nth-call snap отказывают до semantic:true', async () => {
    for (const options of [{ snap: true }, { snapAt: 9 }]) {
      const fake = syntheticBrowser(options);
      try { await expect(measureServerBrowser(fake.browser, { url: 'synthetic://profile' }, fake.adapter, SERVER_PROFILE.browserScenes[0])).rejects.toMatchObject({ name: 'AggregateError' }); }
      finally { fake.dispose(); }
    }
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
    expect(planServerSampleSize(pairs(SERVER_PROFILE.pilotRuns))).toMatchObject({ runs: 288, feasible: true });
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
    expect(policy.minimumBlocks).toBe(144);
    expect(serverOrderStatisticBounds(Array(143).fill(1), 0.95, policy.alphaPerTail).high).toBeNull();
    expect(serverOrderStatisticBounds(Array(144).fill(1), 0.95, policy.alphaPerTail).high).toBe(1);
    expect(19n ** 144n * 1600n <= 20n ** 144n).toBe(true);
    expect(19n ** 143n * 1600n <= 20n ** 143n).toBe(false);
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

  it('имя positive не позволяет спрятать одиночную работу; RLE не доверяет чужой длине', () => {
    const positive = stage('positive'); positive.name = 'aa';
    expect(() => serverCellPairs(positive, 2, 'positive')).toThrow(/имя стадии/);
    const wrongCount = stage(); wrongCount.rows[0].samples.left.raw[0].semantic.targetTraceHashes.count -= 1;
    expect(() => serverCellPairs(wrongCount, 2, 'aa')).toThrow(/lifecycle witness/);
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
    const artifact = healthyAdmission();
    expect(validateServerArtifact(artifact).verdict).toBe('PASS');
    const events = admissionEvents(artifact);
    expect(validateServerJournal(artifact, chain(events))).toHaveProperty('journalFinalDigest');
    const earlyCalibration = events.filter((event) => event.type !== 'calibration');
    earlyCalibration.splice(earlyCalibration.findIndex((event) => event.type === 'N-frozen-before-calibration-and-AB') + 1, 0,
      { type: 'calibration', value: artifact.calibration });
    expect(() => validateServerJournal(artifact, chain(earlyCalibration))).toThrow(/до завершения/);
    const alwaysLeft = events.map((event) => event.type === 'sample' ? { ...event, value: { ...event.value } } : event);
    const firstOpposite = alwaysLeft.findIndex((event) => event.type === 'sample' && event.value.participant === 'right');
    [alwaysLeft[firstOpposite], alwaysLeft[firstOpposite + 1]] = [alwaysLeft[firstOpposite + 1], alwaysLeft[firstOpposite]];
    expect(() => validateServerJournal(artifact, chain(alwaysLeft))).toThrow(/порядок/);
    const ignoredFailure = [...events.slice(0, -1), { type: 'failure', value: { stage: 'ab', error: { message: 'retained reviewer failure' } } }, events.at(-1)];
    expect(() => validateServerJournal(artifact, chain(ignoredFailure))).toThrow(/failures/);
    const wrongPositive = { ...artifact, positive: { ...artifact.positive, name: 'aa' } };
    expect(() => validateServerArtifact(wrongPositive)).toThrow(/имя стадии/);
    const wrongFinish = [...events.slice(0, -1), { type: 'finished', value: { verdict: 'PASS', digest: 'b'.repeat(64) } }];
    expect(() => validateServerJournal(artifact, chain(wrongFinish))).toThrow(/финальная/);
  }, 30_000);

  it('сохраняет partial A/B и поздний отказ, а пропавшие comparator/retention не допускает', () => {
    const complete = healthyAdmission();
    const partial: any = clone(complete); partial.verdict = 'UNPROVEN';
    const completeEvents = admissionEvents(complete);
    const firstAb = completeEvents.findIndex((event) => event.type === 'sample' && event.value.stage === 'ab');
    const failed = completeEvents[firstAb + 1].value;
    const error = { name: 'Error', message: 'timeout второго участника; первый raw сохранён', raw: { completed: [] } };
    partial.failures = [{ stage: 'ab', error }];
    partial.ab.rows = [{ ...partial.ab.rows[0], samples: { [completeEvents[firstAb].value.participant]: completeEvents[firstAb].value.value } }];
    partial.ab.blocks = []; delete partial.comparison; delete partial.comparators; delete partial.retention;
    const partialEvents = [...completeEvents.slice(0, firstAb + 1), { type: 'failed-sample', value: { ...failed, value: undefined, error } },
      { type: 'failure', value: partial.failures[0] }, { type: 'finished', value: { verdict: 'UNPROVEN', digest: serverArtifactDigest(partial) } }];
    expect(validateServerArtifact(partial).verification).toBe('partial-samples-refused');
    expect(validateServerJournal(partial, chain(partialEvents))).toHaveProperty('journalFinalDigest');
    const missingFailure = partialEvents.filter((event) => event.type !== 'failure');
    expect(() => validateServerJournal(partial, chain(missingFailure))).toThrow(/failures/);

    const late: any = clone(complete); late.verdict = 'UNPROVEN';
    const firstComparator = completeEvents.findIndex((event) => event.type === 'comparator-sample');
    const comparatorFailure = completeEvents[firstComparator + 1].value;
    late.failures = [{ stage: 'ab', error }]; late.comparators = [{ ...late.comparators[0], rows: [late.comparators[0].rows[0]] }];
    delete late.retention;
    const lateEvents = [...completeEvents.slice(0, firstComparator + 1), { type: 'failed-comparator-sample', value: { ...comparatorFailure, stage: 'ab', error } },
      { type: 'failure', value: late.failures[0] }, { type: 'finished', value: { verdict: 'UNPROVEN', digest: serverArtifactDigest(late) } }];
    expect(validateServerArtifact(late).verification).toBe('completed-samples-refused');
    expect(validateServerJournal(late, chain(lateEvents))).toHaveProperty('journalFinalDigest');

    const dropped: any = clone(complete); delete dropped.retention.candidate;
    expect(() => validateServerArtifact(dropped)).toThrow(/retention/);
    const omitted = completeEvents.filter((event) => event.type !== 'comparator-sample');
    expect(() => validateServerJournal(complete, chain(omitted))).toThrow(/retention/);
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
