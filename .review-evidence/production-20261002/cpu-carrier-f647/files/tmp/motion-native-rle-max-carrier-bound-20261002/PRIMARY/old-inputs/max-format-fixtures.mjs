import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { createHash } from "node:crypto";
import { SERVER_PROFILE, planServerSampleSize, serverProfileDigest } from "/workspace/lab-motion/bench/profile/server-profile-registration.mjs";
import {
  serverCalibrationVerdict,
  serverCellPairs,
  serverFamilyIntervals,
  serverMetricCells,
  serverOrders,
  compactServerSemanticEvidence,
  serverArtifactDigest,
  serverBrowserSemanticClockErrorMs
} from "/workspace/lab-motion/bench/profile/server-profile-contract.mjs";
import { deriveRealmTimerStep, evaluateStartSemanticEvidence } from "/workspace/lab-motion/bench/compare/methodology.mjs";
const hash = "a".repeat(64);
const clone = (value) => structuredClone(value);
function pairs(runs = SERVER_PROFILE.minRuns, ratio = 1) {
  return serverMetricCells().map(({ id }) => ({
    id,
    left: Array(runs).fill(100),
    right: Array(runs).fill(100 * ratio),
    leftBounds: Array.from({ length: runs }, () => ({ low: 100, high: 100 })),
    rightBounds: Array.from({ length: runs }, () => ({ low: 100 * ratio, high: 100 * ratio }))
  }));
}
function normalMotion(scene) {
  const times = (scene.staggerGapMs > 0 ? [0.2, 0.5, 0.8] : [0.25, 0.5, 0.625]).map((fraction) => SERVER_PROFILE.durationMs * fraction);
  const positions = (time) => Array.from({ length: scene.targetsPerCall }, (_, index) => SERVER_PROFILE.toPx * Math.max(0, Math.min(1, (time - scene.staggerGapMs * index) / SERVER_PROFILE.durationMs)));
  return compactServerSemanticEvidence({
    valid: true,
    topology: {
      calls: 1,
      targetsPerCall: scene.targetsPerCall,
      staggerGapMs: scene.staggerGapMs,
      durationMs: SERVER_PROFILE.durationMs,
      toPx: SERVER_PROFILE.toPx
    },
    callStartedAtMs: [0],
    onset: {
      before: [{ readStartedMs: 0, readEndedMs: 0, documentFrame: { beforeMs: 0, afterMs: 0 }, positions: Array(scene.targetsPerCall).fill(0) }],
      after: [{ readStartedMs: 0.025, readEndedMs: 0.05, documentFrame: { beforeMs: 0, afterMs: 0 }, positions: Array(scene.targetsPerCall).fill(0) }],
      firstFrame: { frameTimestampMs: 0, groups: [{
        readStartedMs: 0.06,
        readEndedMs: 0.07,
        documentFrame: { beforeMs: 0, afterMs: 0 },
        positions: Array(scene.targetsPerCall).fill(0)
      }] }
    },
    checkpoints: times.map((time) => ({ frameTimestampMs: time, groups: [{
      readStartedMs: time,
      readEndedMs: time + 0.1,
      documentFrame: { beforeMs: time, afterMs: time },
      positions: positions(time)
    }] })),
    terminal: [Array(scene.targetsPerCall).fill(SERVER_PROFILE.toPx)]
  });
}
function engineRaw(scene) {
  const render = ([x, y, scaleX, scaleY, rotate, skewX, skewY]) => `translate(${x}px, ${y}px) scaleX(${scaleX}) scaleY(${scaleY}) rotate(${rotate}deg) skew(${skewX}deg, ${skewY}deg)`;
  const live = scene.lifecycle === "live";
  const offsets = [0, 16, 32, 48, 64, 80], setupOffsets = live ? [0, 32] : [];
  const setup = live ? [[0, 0, 1, 1, 0, 0, 0], [16, 8, 1.25, 1.5, 8, 2, 4]].map(render) : [];
  const values = live ? [16, 46, 76, 106, 136, 166].map((x) => render([x, 8, 1.25, 1.5, 8, 2, 4])) : [
    [0, 0, 1, 1, 0, 0, 0],
    [32, 20, 1.375, 1.5, 12, 3, 5],
    [64, 40, 1.75, 2, 24, 6, 10],
    [96, 60, 2.125, 2.5, 36, 9, 15],
    [128, 80, 2.5, 3, 48, 12, 20],
    [160, 100, 2.875, 3.5, 60, 15, 25]
  ].map(render);
  const base = 1e6 + (live ? 48 : 0);
  const steps = [
    ...setupOffsets.map((offset, index) => ({ stage: "setup", index, phase: "setup", timestampMs: 1e6 + offset })),
    ...offsets.map((offset, index) => ({ stage: "frame", index, phase: "frames", timestampMs: base + offset })),
    { stage: "cancel-drain", index: null, phase: "outside", timestampMs: base + 128 },
    ...[256, 384].map((offset) => ({ stage: "idle", index: null, phase: "outside", timestampMs: base + offset }))
  ].map((step, sequence) => ({ sequence, ...step }));
  const events = steps.filter((step) => ["setup", "frame"].includes(step.stage)).map((step, sequence) => ({
    sequence,
    phase: step.phase,
    index: step.index,
    step: step.sequence,
    timestampMs: step.timestampMs,
    property: "transform",
    value: step.stage === "setup" ? setup[step.index] : values[step.index]
  }));
  const clockReads = [
    { metric: "operationNs", frame: null },
    ...offsets.map((_, frame) => ({ metric: "frameNs", frame })),
    { metric: "cancelDrainNs", frame: null }
  ].flatMap(({ metric, frame }, interval) => ["before", "after"].map((edge, half) => ({
    sequence: interval * 2 + half,
    metric,
    frame,
    edge,
    valueNs: String(1e7 + interval * 2e6 + (half ? metric === "cancelDrainNs" ? 5e5 : 1e6 : 0))
  })));
  return {
    operationNs: 1e6,
    frameNs: Array(6).fill(1e6),
    cancelDrainNs: 5e5,
    raw: {
      schemaVersion: 1,
      case: { count: scene.count, lifecycle: scene.lifecycle, channels: scene.channels },
      clockReads,
      cpuReads: clockReads.map((read) => ({ sequence: read.sequence, userUs: Number(read.valueNs) / 1e3, systemUs: 0, valueNs: read.valueNs })),
      timeline: { clockOriginMs: 1e6, setupOffsetsMs: setupOffsets, frameOffsetsMs: offsets, successorBaseMs: base, steps },
      targetTraces: { encoding: "runs", count: scene.count, runs: [{
        from: 0,
        count: scene.count,
        trace: { value: values.at(-1), setup, setupWrites: setup.map(() => 1), values, writes: values.map(() => 1), outsideWrites: 0, events }
      }] }
    },
    semantic: {
      valid: true,
      targets: scene.count,
      frames: 6,
      finished: true,
      pending: 0,
      onCompleteCalls: 0,
      previousFinished: live ? true : null,
      previousCompleteCalls: 0,
      requests: live ? 9 : 7,
      executions: live ? 9 : 7,
      targetTraceHashes: { encoding: "repeat", count: scene.count, value: createHash("sha256").update(JSON.stringify(values)).digest("hex") }
    }
  };
}
function stockRaw(scene, multiplier = 1, timed = true) {
  const calls = scene.callsPerRepetition * multiplier;
  const clockReads = timed ? ["before", "after"].map((edge, sequence) => ({
    sequence,
    metric: "operationNs",
    frame: null,
    edge,
    valueNs: String(1e7 + sequence * scene.callsPerRepetition * multiplier * 1e6)
  })) : [];
  return { operationNs: timed ? 1e6 * multiplier : null, raw: {
    schemaVersion: 1,
    scene: scene.id,
    phase: timed ? "timed" : "warmup",
    calls,
    completed: calls,
    denominator: scene.callsPerRepetition,
    clockReads,
    cpuReads: clockReads.map((read) => ({ sequence: read.sequence, userUs: Number(read.valueNs) / 1e3, systemUs: 0, valueNs: read.valueNs })),
    outcomes: { encoding: "runs", count: calls, runs: [{ from: 0, count: calls, value: 100, frames: 47 }] }
  } };
}
function stage(name = "aa", runs = 2) {
  const rows = [];
  for (let run = 0; run < runs; run++) for (const [kind, scenes] of [["engine", SERVER_PROFILE.engineScenes], ["browser", SERVER_PROFILE.browserScenes]]) {
    for (const scene of scenes) {
      const samples = {};
      for (const id of ["left", "right"]) {
        const multiplier = name === "positive" && id === "right" ? 2 : 1;
        let raw;
        let extra = {};
        if (kind === "engine") {
          if (scene.workload === "stock-c") {
            raw = Array.from({ length: SERVER_PROFILE.repetitions }, () => stockRaw(scene, multiplier));
            extra = {
              operationNs: 1e6 * multiplier,
              cpuScope: SERVER_PROFILE.stockCpuScope,
              warmup: Array.from({ length: scene.warmupBatches }, () => stockRaw(scene, 1, false))
            };
          } else {
            raw = Array.from({ length: SERVER_PROFILE.repetitions * multiplier }, () => engineRaw(scene));
            extra = { operationNs: 1e6 * multiplier, meanFrameNs: 1e6 * multiplier, cancelDrainNs: 5e5 * multiplier };
          }
        } else {
          const timerEvidence = { crossOriginIsolated: true, probes: ["before", "after"].map((phase) => ({
            phase,
            timeOriginMs: 1e3,
            performanceNowDeltasMs: Array(64).fill(5e-3)
          })) };
          const count = scene.targetsPerCall;
          const calls = SERVER_PROFILE.browserBatchCalls * multiplier;
          const cancellation = (targets) => ({
            connectedTargets: targets,
            activeWaapiBefore: 0,
            transformsBefore: { encoding: "repeat", count: targets, value: 0 },
            frames: Array.from({ length: SERVER_PROFILE.browserCancellationWitness.frames }, () => ({ connectedTargets: targets, activeWaapi: 0, transforms: { encoding: "repeat", count: targets, value: 0 } })),
            cancelDrainMs: 64
          });
          raw = Array.from({ length: SERVER_PROFILE.repetitions }, (_, index) => {
            const beginMs = 100 + index * 1e3, endMs = beginMs + SERVER_PROFILE.browserBatchCalls * multiplier;
            return {
              startMs: multiplier,
              cancelMs: 0.5 * multiplier,
              batchStartMs: SERVER_PROFILE.browserBatchCalls * multiplier,
              batchCancelMs: SERVER_PROFILE.browserBatchCalls * 0.5 * multiplier,
              calls,
              ownersStarted: calls,
              ownersCancelled: calls,
              startClock: { beginMs, endMs },
              cancelClock: { beginMs: endMs + 3, endMs: endMs + 3 + SERVER_PROFILE.browserBatchCalls * 0.5 * multiplier },
              startWitness: {
                connectedTargets: calls * count,
                activeWaapi: 0,
                leadingPositions: { encoding: "repeat", count: calls, value: 0 },
                readClock: { beginMs: endMs + 1, endMs: endMs + 2 }
              },
              cancelWitness: cancellation(calls * count)
            };
          });
          extra = {
            startMs: 1 * multiplier,
            cancelMs: 0.5 * multiplier,
            timerEvidence,
            timerStepMs: deriveRealmTimerStep("fixture", timerEvidence),
            measurementTimeOriginMs: 1e3,
            endpoints: Array(count).fill(SERVER_PROFILE.toPx),
            controlCancelMs: 0.5,
            controlCancelWitness: cancellation(count),
            warmup: [raw[0]],
            semanticEvidence: normalMotion(scene),
            monotonicHostUpperNs: "1000000000000",
            clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError)
          };
        }
        samples[id] = { raw, ...extra, semantic: true, workMultiplier: multiplier, repetitions: SERVER_PROFILE.repetitions, denominator: SERVER_PROFILE.denominator };
      }
      rows.push({ kind, scene: scene.id, run, order: serverOrders(runs)[run], samples });
    }
  }
  const blocks = Array.from({ length: runs / 2 }, (_, block) => {
    const cpuStat = { usage_usec: 10 + block * 10, user_usec: 10 + block * 10, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
    return {
      block,
      before: { cpuStat, affinity: "0", cpuMax: "400000 100000" },
      after: { cpuStat: { ...cpuStat, usage_usec: cpuStat.usage_usec + 10, user_usec: cpuStat.user_usec + 10 }, affinity: "0", cpuMax: "400000 100000" },
      delta: { usage_usec: 10, user_usec: 10, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 }
    };
  });
  return { name, rows, blocks };
}
function registeredRefusal() {
  const packageInfo = { version: "1.0.0", sha256: hash, files: 1 };
  const provenance = {
    revision: SERVER_PROFILE.baselineRevision,
    dirty: false,
    trackedRevisionSha256: hash,
    worktreeSha256: hash,
    distRuntime: { sha256: hash, files: 1 },
    inputs: Object.fromEntries(["root/package.json", "root/pnpm-lock.yaml", "bench/package.json", "bench/pnpm-lock.yaml"].map((name) => [name, hash])),
    environment: {
      node: SERVER_PROFILE.clockError.nodeVersion,
      nodeExecutableSha256: SERVER_PROFILE.clockError.nodeExecutableSha256,
      pnpm: "11.11.0",
      packages: Object.fromEntries(["esbuild", "playwright", "motion", "gsap", "animejs"].map((name) => [name, packageInfo])),
      rootPackages: Object.fromEntries(["tsup", "typescript", "esbuild"].map((name) => [name, packageInfo]))
    }
  };
  const machineIdentity = {
    affinity: "0",
    cgroupCpuMax: "400000 100000",
    platform: "linux",
    release: SERVER_PROFILE.clockError.kernelRelease,
    node: SERVER_PROFILE.clockError.nodeVersion,
    nodeExecutableSha256: SERVER_PROFILE.clockError.nodeExecutableSha256
  };
  const consumer = { tarballSha256: hash, treeSha256: hash };
  const registration = {
    protocolDigest: serverProfileDigest(SERVER_PROFILE),
    candidateSamplesObserved: false,
    candidateSamplesObservedScope: SERVER_PROFILE.candidateSamplesObservedScope,
    browser: "chromium",
    browserVersion: SERVER_PROFILE.clockError.browserVersion,
    browserExecutableSha256: SERVER_PROFILE.clockError.browserExecutableSha256,
    clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError),
    browserTree: { sha256: hash, files: 1 },
    provenance: { baseline: provenance, candidate: { ...provenance, revision: "b".repeat(40) } },
    machine: { identity: machineIdentity, sha256: serverProfileDigest(machineIdentity) },
    harness: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), { sha256: hash }])),
    packages: Object.fromEntries(["baseline", "candidate", ...SERVER_PROFILE.comparators.filter((x) => x !== "waapi-ctl")].map((name) => [name, clone(consumer)])),
    transitivePackages: { one: consumer, two: consumer, three: consumer }
  };
  return {
    schema: 1,
    protocol: SERVER_PROFILE,
    registration,
    registrationDigest: serverProfileDigest(registration),
    verdict: "UNPROVEN",
    failures: [{ stage: "warmup", error: { message: "\u043D\u0435\u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u0430\u044F \u043A\u043E\u043D\u0442\u0440\u043E\u043B\u044C\u043D\u0430\u044F \u0441\u0435\u0440\u0438\u044F" } }]
  };
}
function healthyAdmission() {
  const artifact = registeredRefusal();
  artifact.failures = [];
  artifact.verdict = "PASS";
  artifact.warmup = stage("warmup", SERVER_PROFILE.warmupRuns);
  artifact.pilot = stage("pilot", SERVER_PROFILE.pilotRuns);
  artifact.samplePlan = planServerSampleSize(serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, "pilot"));
  const runs = artifact.samplePlan.runs;
  artifact.aa = stage("aa", runs);
  artifact.positive = stage("positive", runs);
  artifact.ab = stage("ab", runs);
  artifact.frozenPlanDigest = serverProfileDigest({ registrationDigest: artifact.registrationDigest, samplePlan: artifact.samplePlan });
  const aa = serverFamilyIntervals(serverCellPairs(artifact.aa, runs, "aa"));
  const positive = serverFamilyIntervals(serverCellPairs(artifact.positive, runs, "positive"));
  artifact.calibration = { ...serverCalibrationVerdict(aa, positive, artifact.samplePlan), aa, positive };
  artifact.comparison = serverFamilyIntervals(serverCellPairs(artifact.ab, runs, "ab"));
  const control = {
    noMotion: { equal: true, beforeSha256: hash, afterSha256: hash },
    reduced: { prefersReducedMotion: true, x: SERVER_PROFILE.toPx, rafRequests: 0, activeWaapi: 0 }
  };
  artifact.rawControls = { baseline: clone(control), candidate: clone(control) };
  artifact.comparators = SERVER_PROFILE.browserScenes.flatMap((scene) => SERVER_PROFILE.comparators.map((id) => {
    if (scene.staggerGapMs > 0 && ["motion-mini", "anime-waapi"].includes(id)) return {
      scene: scene.id,
      id,
      status: "UNPROVEN",
      reason: "\u043E\u0431\u0449\u0435\u0433\u043E stagger API \u043D\u0435\u0442"
    };
    const sample = artifact.ab.rows.find((row) => row.scene === scene.id).samples.left;
    return { scene: scene.id, id, rows: Array.from({ length: runs }, () => sample) };
  }));
  const retention = { verdict: "COMPLETE", failure: null, rows: SERVER_PROFILE.engineScenes.map((scene) => ({
    scene: scene.id,
    before: { heapUsed: 1e3 },
    after: { heapUsed: 900 },
    retainedHeapDeltaBytes: -100
  })) };
  artifact.retention = { baseline: clone(retention), candidate: clone(retention) };
  return artifact;
}
function admissionEvents(artifact) {
  const events = [
    { type: "registration-before-any-sample", value: { registration: artifact.registration, digest: artifact.registrationDigest } },
    { type: "raw-controls-baseline", value: artifact.rawControls.baseline }
  ];
  for (const name of ["warmup", "pilot", "aa", "positive", "ab"]) {
    if (name === "aa") events.push({ type: "N-frozen-before-calibration-and-AB", value: { samplePlan: artifact.samplePlan, digest: artifact.frozenPlanDigest } });
    if (name === "ab") events.push({ type: "calibration", value: artifact.calibration }, { type: "raw-controls-candidate-after-calibration", value: artifact.rawControls.candidate });
    const current = artifact[name];
    current.rows.forEach((row, index) => {
      for (const participant of row.order) events.push({ type: "sample", value: {
        stage: name,
        kind: row.kind,
        scene: row.scene,
        run: row.run,
        participant,
        build: name === "ab" && participant === "right" ? "candidate" : "baseline",
        value: row.samples[participant]
      } });
      const blockRows = (SERVER_PROFILE.engineScenes.length + SERVER_PROFILE.browserScenes.length) * 2;
      if ((index + 1) % blockRows === 0) events.push({ type: "resources-block", value: { stage: name, ...current.blocks[Math.floor(index / blockRows)] } });
    });
  }
  for (const comparator of artifact.comparators) for (let run = 0; run < (comparator.rows ?? []).length; run++) {
    events.push({ type: "comparator-sample", value: { scene: comparator.scene, id: comparator.id, run, sample: comparator.rows[run] } });
  }
  for (const id of ["baseline", "candidate"]) events.push({ type: "retention-sample", value: { id, value: artifact.retention[id] } });
  events.push({ type: "retention-separate-forced-GC", value: artifact.retention });
  events.push({ type: "finished", value: { verdict: artifact.verdict, digest: serverArtifactDigest(artifact) } });
  return events;
}
function chain(events, shared) {
  let prefix = 0;
  while (shared && prefix < events.length && events[prefix] === shared.events[prefix]) prefix++;
  let previous = prefix ? shared.records[prefix - 1].digest : "0".repeat(64);
  return [...shared?.records.slice(0, prefix) ?? [], ...events.slice(prefix).map((event) => {
    const payload = { sequenceDigest: previous, ...event };
    previous = serverProfileDigest(payload);
    return { ...payload, digest: previous };
  })];
}
let sharedAdmission;
function admissionHistory() {
  if (!sharedAdmission) {
    const artifact = healthyAdmission(), events = admissionEvents(artifact);
    sharedAdmission = { artifact, events, records: chain(events) };
  }
  return sharedAdmission;
}
function syntheticBrowser(options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "motion-server-synthetic-"));
  const source = path.join(directory, "adapter.js");
  writeFileSync(source, "// \u0421\u0438\u043D\u0442\u0435\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0439 adapter \u0437\u0430\u0434\u0430\u043D VM.\n");
  let timeMs = 100, frameTimeMs = timeMs - (options.documentOriginLagMs ?? 0), frameReads = 0, frames = 0, starts = 0, cancels = 0;
  const children = [];
  const position = (element) => {
    if (!element.motion) return element.x;
    if (element.motion.pendingFrame) return SERVER_PROFILE.toPx * element.motion.initialProgress;
    const progress = Math.max(0, Math.min(1, (timeMs - element.motion.startedMs - element.motion.delayMs) / element.motion.durationMs + element.motion.initialProgress));
    return SERVER_PROFILE.toPx * (options.shape === "quadratic" ? progress * progress : progress);
  };
  const start = (elements, to, duration, gap = 0) => {
    starts++;
    const startedMs = timeMs;
    for (const [index, element] of elements.entries()) {
      if (options.snap || starts === options.snapAt) {
        element.x = to;
        element.motion = null;
      } else element.motion = {
        startedMs,
        durationMs: duration * (options.durationMultiplier ?? 1),
        delayMs: index * gap,
        pendingFrame: true,
        initialProgress: starts >= (options.initialProgressAt ?? 1) ? options.initialProgress ?? 0 : 0
      };
    }
    timeMs += options.startCostMs ?? 0.025;
    return { cancel() {
      cancels++;
      if (cancels === options.cancelAt) throw void 0;
      timeMs += 0.05;
      for (const element of elements) {
        element.x = position(element);
        element.motion = null;
      }
    } };
  };
  const sandbox = {
    crossOriginIsolated: true,
    performance: { timeOrigin: 1e3, now() {
      timeMs += 1e-3;
      return Math.floor(timeMs / 5e-3) * 5e-3;
    } },
    document: { timeline: { get currentTime() {
      if (options.documentClock === "missing") return null;
      return frameTimeMs + (options.documentClock === "unstable" ? ++frameReads * 0.01 : options.documentClock === "unrelated" ? 1 : 0);
    } }, createElement() {
      return {
        x: 0,
        motion: null,
        isConnected: false,
        getAnimations: () => [],
        remove() {
          this.isConnected = false;
        }
      };
    }, body: { appendChild(element) {
      element.isConnected = true;
      children.push(element);
    } } },
    getComputedStyle: (element) => {
      if (starts === 0 && children.indexOf(element) === options.onsetReadAt) throw new Error("\u0441\u0438\u043D\u0442\u0435\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u043E\u0442\u043A\u0430\u0437 acquired onset prefix");
      const transform = String(position(element));
      timeMs += options.readCostMs ?? 0;
      return { transform };
    },
    DOMMatrixReadOnly: class {
      e;
      constructor(value) {
        this.e = Number(value);
      }
    },
    setTimeout(callback, delay) {
      for (const element of children) if (element.motion?.pendingFrame) {
        element.motion.startedMs += options.rafStepMs ?? 16;
        element.motion.pendingFrame = false;
      }
      timeMs += delay + (options.timerLagMs ?? 0);
      queueMicrotask(callback);
    },
    requestAnimationFrame(callback) {
      timeMs += options.rafStepMs ?? 16;
      frameTimeMs = timeMs;
      frames++;
      for (const element of children) if (element.motion) {
        if (element.motion.pendingFrame) {
          element.motion.startedMs = frameTimeMs;
          element.motion.pendingFrame = false;
        }
        if (frames === (options.quarterAtFirstFrame ? 1 : options.quarterAtFrame)) element.motion.initialProgress = 0.25;
      }
      queueMicrotask(() => callback(timeMs));
    },
    __adapterModule: { start, startStagger: start }
  };
  sandbox.window = sandbox;
  const realm = createContext(sandbox);
  const page = {
    goto: async () => {
    },
    exposeFunction: async (name, fn) => {
      sandbox[name] = fn;
    },
    async evaluate(fn, argument) {
      if (options.rejectTiming && fn.toString().includes("const raw = [], warmup")) throw void 0;
      return runInContext(`(${fn.toString()})`, realm)(argument);
    }
  };
  const context = { newPage: async () => page, close: async () => {
  } };
  return {
    browser: { newContext: async () => context },
    page,
    adapter: { path: source },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
    read: () => ({ starts, cancels, connected: children.filter((element) => element.isConnected).length })
  };
}
async function syntheticSemanticControl(fake, scene) {
  const bench = readFileSync(new URL("/workspace/lab-motion/bench/compare/bench.mjs", import.meta.url), "utf8");
  const source = bench.slice(bench.indexOf("export async function runSemanticStartCheck("), bench.indexOf("// \u2500\u2500\u2500 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0439 S5:")).trim().replace(/^export /, "");
  const runCheck = Function("evaluateStartSemanticEvidence", `return (${source})`)(evaluateStartSemanticEvidence);
  const semanticClockErrorMs = serverBrowserSemanticClockErrorMs("1000000000000");
  return runCheck(fake.page, {
    ...scene,
    ...SERVER_PROFILE.browserSemantics,
    semanticClockErrorMs,
    durationMs: SERVER_PROFILE.durationMs,
    toPx: SERVER_PROFILE.toPx
  }, SERVER_PROFILE.browserSemanticCalls);
}
export {
  admissionEvents,
  registeredRefusal,
  stage
};
