// Расширение существующего bench owner: общие сборка, origin, адаптеры и законы
// round-robin. Ни одного вывода о физическом мобильном устройстве здесь нет.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, hostname, loadavg, platform, release, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PerformanceObserver } from 'node:perf_hooks';
import { runTransformLifecycleSample } from '../../scripts/bench-transform-support.mjs';
import { createMotionValueDefaultBenchmark } from '../../scripts/bench-support.mjs';
import { runSemanticStartCheck, startBenchmarkOrigin } from '../compare/bench.mjs';
import { compactStockMotionValueOutcomes, deriveRealmTimerStep, PRODUCTION_ADAPTER_PROFILE, validateStockMotionValueBatch } from '../compare/methodology.mjs';
import { assertCheckoutUnchanged, assertFileHashesUnchanged, assertInstalledPackageTreesUnchanged,
  hashFileTree, prepareBenchmarkCheckout, sha256File } from '../compare/provenance.mjs';
import { SERVER_PROFILE, planServerSampleSize, serverProfileDigest } from './server-profile-registration.mjs';
import { prepareServerThreadCpuClock, readServerThreadCpuEndpoint } from './server-thread-cpu-clock.mjs';
import { compactServerCpuEvidence, compactServerSemanticEvidence, serverBrowserSemanticClockErrorMs, serverCalibrationVerdict, serverCellPairs,
  serverFamilyIntervals, serverOrders, serverResourceReasons, validateServerBrowserSample, validateServerEngineSample, verifyServerClockRegistration } from './server-profile-contract.mjs';
import { writeServerArtifact } from './server-profile-artifact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BENCH = path.join(ROOT, 'bench/compare');
const requireBench = createRequire(path.join(BENCH, 'package.json'));
const HARNESS_FILES = ['bench/profile/server-profile-registration.mjs', 'bench/profile/server-profile-contract.mjs',
  'bench/profile/server-profile-artifact.mjs',
  'bench/profile/server-profile-runner.mjs', 'bench/profile/server-profile-retention.mjs',
  'bench/profile/server-thread-cpu-clock.mjs', ...Object.keys(SERVER_PROFILE.clockError.nativeSourceFiles),
  'scripts/bench-transform-support.mjs', 'scripts/bench-support.mjs', 'scripts/bench.mjs', 'bench/compare/bench.mjs',
  'bench/compare/methodology.mjs', 'bench/compare/provenance.mjs'];
const ENTRIES = ['lab', ...SERVER_PROFILE.comparators];
const PACKAGES = { motion: 'motion', gsap: 'gsap', anime: 'animejs', 'motion-mini': 'motion', 'anime-waapi': 'animejs' };

function preserveRawNumbers(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return { nonfinite: String(value) };
  if (Array.isArray(value)) return value.map(preserveRawNumbers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, preserveRawNumbers(child)]));
  return value;
}

function errorRecord(error) {
  const code = error == null ? undefined : Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return { name: error?.name ?? typeof error, message: String(error?.message ?? error),
    ...(typeof code === 'string' ? { code } : {}),
    ...(error?.errors ? { errors: error.errors.map(errorRecord) } : {}),
    ...(error?.raw ? { raw: preserveRawNumbers(error.raw) } : {}), ...(error?.timerEvidence ? { timerEvidence: preserveRawNumbers(error.timerEvidence) } : {}) };
}
function readOptional(file) { return existsSync(file) ? readFileSync(file, 'utf8').trim() : null; }
function contextSwitches() {
  const status = readFileSync('/proc/self/status', 'utf8');
  return Object.fromEntries(['voluntary_ctxt_switches', 'nonvoluntary_ctxt_switches'].map((name) =>
    [name, Number(new RegExp(`^${name}:\\s*(\\d+)$`, 'm').exec(status)?.[1])]));
}
function captureServerLoad() {
  const raw = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
  const cpuStat = Object.fromEntries(raw.trim().split('\n').map((line) => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
  return { at: new Date().toISOString(), affinity: /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1],
    cpuMax: readOptional('/sys/fs/cgroup/cpu.max'), cpuStat, loadavg: loadavg(), contextSwitches: contextSwitches(), scope: 'весь cgroup, включая возможные фоновые процессы' };
}
async function withBrowserTimeout(promise, label) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`server profile: ${label} превысил ${SERVER_PROFILE.browserOperationTimeoutMs} ms`)), SERVER_PROFILE.browserOperationTimeoutMs);
    })]);
  } finally { clearTimeout(timeout); }
}
export function captureServerMachine() {
  const affinity = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
  if (!/^\d+$/.test(affinity ?? '')) throw new Error('server profile: нужен один CPU через taskset, общий scheduler не закреплён');
  const cgroupCpuMax = readOptional('/sys/fs/cgroup/cpu.max');
  if (typeof cgroupCpuMax !== 'string' || cgroupCpuMax.length === 0) {
    throw Object.assign(new Error('server profile: нет cgroup v2 cpu.max; ресурсный контракт невыполним до samples'),
      { raw: { affinity, cgroupCpuMax } });
  }
  const resource = captureServerLoad();
  const resourceKeys = ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'];
  if (!resourceKeys.every((key) => Number.isSafeInteger(resource.cpuStat[key]) && resource.cpuStat[key] >= 0)) {
    throw Object.assign(new Error('server profile: cpu.stat не содержит шесть безопасных неотрицательных счётчиков; ресурсный контракт невыполним до samples'),
      { raw: { resource } });
  }
  const identity = { platform: platform(), release: release(), arch: arch(), host: hostname(),
    cpu: cpus()[Number(affinity)]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), affinity,
    cgroupCpuMax, cgroupMemoryMax: readOptional('/sys/fs/cgroup/memory.max'),
    governor: readOptional(`/sys/devices/system/cpu/cpu${affinity}/cpufreq/scaling_governor`),
    display: 'headless; физический экран отсутствует', power: 'среда сервера; не устройство', thermal: 'не измеряется',
    node: process.version, nodeExecutableSha256: sha256File(process.execPath), execArgv: process.execArgv };
  return { identity, sha256: serverProfileDigest(identity), observation: { at: new Date().toISOString(), loadavg: loadavg(), memory: process.memoryUsage() } };
}

export function createServerJournal(out) {
  mkdirSync(out, { recursive: false });
  let previous = '0'.repeat(64);
  const file = path.join(out, 'journal.ndjson');
  return (type, value) => {
    const payload = { sequenceDigest: previous, type, value };
    const digest = serverProfileDigest(payload);
    appendFileSync(file, `${JSON.stringify({ ...payload, digest })}\n`, { flag: 'a' });
    previous = digest;
    return digest;
  };
}

export async function withServerProfileSignals(run) {
  const controller = new AbortController();
  const stop = (signal) => {
    if (controller.signal.aborted) return;
    controller.abort(Object.assign(new Error(`server profile: оператор запросил ${signal}`), {
      name: 'AbortError', code: 'OPERATOR_INTERRUPTION', raw: { signal, receivedAt: new Date().toISOString() },
    }));
  };
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try { return await run(controller.signal); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

export async function runServerProfileCalibration(artifact, runStage, journal) {
  artifact.warmup = await runStage('warmup', SERVER_PROFILE.warmupRuns);
  artifact.pilot = await runStage('pilot', SERVER_PROFILE.pilotRuns);
  artifact.samplePlan = planServerSampleSize(serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, 'pilot', artifact.registration.engineClock));
  artifact.frozenPlanDigest = serverProfileDigest({ registrationDigest: artifact.registrationDigest, samplePlan: artifact.samplePlan });
  journal('N-frozen-before-calibration-and-AB', { samplePlan: artifact.samplePlan, digest: artifact.frozenPlanDigest });
  if (!artifact.samplePlan.feasible) throw Object.assign(new Error(`server profile: pilot требует ${artifact.samplePlan.requiredRuns} runs, предел ${SERVER_PROFILE.maxRuns}`), {
    code: 'UNPROVEN_POWER', raw: { samplePlan: artifact.samplePlan, frozenPlanDigest: artifact.frozenPlanDigest },
  });
  artifact.aa = await runStage('aa', artifact.samplePlan.runs);
  artifact.positive = await runStage('positive', artifact.samplePlan.runs);
  const aa = serverFamilyIntervals(serverCellPairs(artifact.aa, artifact.samplePlan.runs, 'aa', artifact.registration.engineClock));
  const positiveControl = serverFamilyIntervals(serverCellPairs(artifact.positive, artifact.samplePlan.runs, 'positive', artifact.registration.engineClock));
  const calibrated = serverCalibrationVerdict(aa, positiveControl, artifact.samplePlan);
  calibrated.reasons.push(...serverResourceReasons([artifact.warmup, artifact.pilot, artifact.aa, artifact.positive], artifact.registration.machine.identity));
  calibrated.verdict = calibrated.reasons.length ? 'UNPROVEN' : 'PASS';
  artifact.calibration = { ...calibrated, aa, positive: positiveControl };
  journal('calibration', artifact.calibration);
  return artifact.calibration.verdict === 'PASS';
}

function buildToStderr(root) {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32', timeout: 180_000 });
}

// Игнорирование publish scripts запрещает vendor prepack rebuild другим toolchain.
// Фактический npm-consumer получает именно unpacked архив; workspace dist не импортируется.
function packConsumer(packageRoot, directory, nodeModules) {
  mkdirSync(directory, { recursive: true });
  const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const tarball = path.join(directory, 'consumer.tgz');
  execFileSync('pnpm', ['--config.ignore-scripts=true', 'pack', '--out', tarball], {
    cwd: packageRoot, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  execFileSync('tar', ['-xzf', tarball, '-C', directory], { stdio: 'pipe', timeout: 30_000 });
  const packageDirectory = path.join(directory, 'package');
  const consumerName = path.join(nodeModules, metadata.name);
  mkdirSync(path.dirname(consumerName), { recursive: true });
  symlinkSync(packageDirectory, consumerName, 'dir');
  const tree = hashFileTree(packageDirectory);
  return { name: metadata.name, version: metadata.version, tarball, tarballSha256: sha256File(tarball),
    directory: packageDirectory, treeSha256: tree.sha256, files: tree.files };
}

function packageClosure(name, out, nodeModules, packed = new Map()) {
  const packageRoot = realpathSync(path.join(BENCH, 'node_modules', name));
  return packDependency(packageRoot);
  function packDependency(directory) {
    const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (packed.has(metadata.name)) return packed.get(metadata.name);
    const consumer = packConsumer(directory, path.join(out, metadata.name.replaceAll('/', '__')), nodeModules);
    packed.set(metadata.name, consumer);
    const resolver = createRequire(path.join(directory, 'package.json'));
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      const entry = resolver.resolve(dependency);
      let cursor = path.dirname(realpathSync(entry));
      while (!existsSync(path.join(cursor, 'package.json')) || JSON.parse(readFileSync(path.join(cursor, 'package.json'), 'utf8')).name !== dependency) {
        const parent = path.dirname(cursor); if (parent === cursor) throw new Error('server profile: не разрешён transitive package'); cursor = parent;
      }
      packDependency(cursor);
    }
    return consumer;
  }
}

function buildAdapter(id, consumerRoot, esbuild, out) {
  const owner = id === 'baseline' || id === 'candidate' ? 'lab' : id;
  const entry = path.join(BENCH, `entries/${owner === 'waapi-ctl' ? 'waapi-control' : owner}.entry.mjs`);
  const original = readFileSync(entry, 'utf8');
  const contents = owner === 'lab' ? original.replace("'../../../dist/animate/index.js'", "'@labpics/motion/animate'") : original;
  const artifact = path.join(out, `${id}.iife.js`);
  esbuild.buildSync({ ...PRODUCTION_ADAPTER_PROFILE, stdin: { contents, resolveDir: consumerRoot, sourcefile: path.basename(entry) },
    nodePaths: [path.join(consumerRoot, 'node_modules')], format: 'iife', globalName: '__adapterModule', outfile: artifact, logLevel: 'silent' });
  return { path: artifact, sha256: sha256File(artifact), ownerEntry: entry, ownerEntrySha256: sha256File(entry) };
}

function threadCpuNs(reads) {
  const endpoint = readServerThreadCpuEndpoint();
  const acquired = { sequence: reads.length, ...endpoint };
  reads.push(acquired);
  if (acquired.clock !== 'CLOCK_THREAD_CPUTIME_ID' || acquired.pid !== process.pid || acquired.tid !== process.pid ||
      typeof acquired.seconds !== 'string' || !/^(0|[1-9]\d*)$/.test(acquired.seconds) ||
      !Number.isSafeInteger(acquired.nanoseconds) || acquired.nanoseconds < 0 || acquired.nanoseconds >= 1_000_000_000) {
    throw Object.assign(new Error('server profile: unsafe native scheduled CPU endpoint вне clock model'), { raw: acquired });
  }
  const valueNs = BigInt(acquired.seconds) * 1_000_000_000n + BigInt(acquired.nanoseconds);
  if (acquired.valueNs !== String(valueNs)) throw Object.assign(new Error('server profile: native CPU value не пересчитывается из sec/nsec'), { raw: acquired });
  return valueNs;
}

function sampleCpuClock(raw) {
  const endpoint = raw[0]?.raw?.cpuReads?.[0];
  return { clock: endpoint?.clock, pid: endpoint?.pid, tid: endpoint?.tid };
}

function compactSampleCpuEvidence(sample) {
  // Никакой частичной замены при отказе encoder: исходные массивы остаются в error.raw.
  let encoded;
  try { encoded = sample.raw.map((measured) => compactServerCpuEvidence(measured.raw.cpuReads)); }
  catch (error) { throw Object.assign(new AggregateError([error], 'server profile: native CPU carrier не завершён'), { raw: sample }); }
  for (let index = 0; index < sample.raw.length; index++) sample.raw[index].raw.cpuReads = encoded[index];
}

export async function measureServerEngine(animate, scene, workMultiplier = 1) {
  if (scene.workload === 'stock-c') return measureServerStockC(animate, scene, workMultiplier);
  const raw = [];
  const before = process.memoryUsage();
  const contextBefore = contextSwitches();
  let cpuReads = [];
  let sampleResult;
  try {
    for (let repetition = 0; repetition < SERVER_PROFILE.repetitions; repetition++) {
      for (let extra = 0; extra < workMultiplier; extra++) {
        cpuReads = [];
        const measured = await runTransformLifecycleSample({ animate,
          count: scene.count, lifecycle: scene.lifecycle, channels: scene.channels, nowNs: () => threadCpuNs(cpuReads) });
        measured.raw.cpuReads = cpuReads;
        const hashes = measured.semantic.targetTraceHashes;
        if (hashes.every((hash) => hash === hashes[0])) measured.semantic.targetTraceHashes = { encoding: 'repeat', count: hashes.length, value: hashes[0] };
        raw.push(measured);
      }
    }
    const aggregate = (read) => raw.reduce((sum, sample) => sum + read(sample), 0) / SERVER_PROFILE.repetitions;
    sampleResult = { operationNs: aggregate((sample) => sample.operationNs),
      meanFrameNs: aggregate((sample) => sample.frameNs.reduce((a, b) => a + b, 0) / sample.frameNs.length),
      cancelDrainNs: aggregate((sample) => sample.cancelDrainNs), semantic: raw.every((sample) => sample.semantic.valid),
      repetitions: SERVER_PROFILE.repetitions, workMultiplier, denominator: SERVER_PROFILE.denominator,
      cpuClock: sampleCpuClock(raw),
      contextSwitchObservation: { before: contextBefore, after: contextSwitches(), scope: 'Node process; timing использует только CPU текущего потока' },
      allocationObservation: { before, after: process.memoryUsage(), scope: 'пакет + независимый oracle + harness; allocator/GC не разложены' }, raw };
    validateServerEngineSample(sampleResult, scene, workMultiplier);
    return sampleResult;
  } catch (error) {
    throw Object.assign(new AggregateError([error], 'server profile: engine sample не завершён'), { raw: sampleResult ?? {
      completed: raw, failedRepetition: preserveRawNumbers(error?.raw ? { ...error.raw, cpuReads } : { cpuReads }), before, after: process.memoryUsage() } });
  }
}

/** Штатный stock C: per-call evidence stores внутри CPU, oracle/RLE снаружи. */
export async function measureServerStockC(MotionValue, scene, workMultiplier = 1) {
  const raw = [], warmup = [];
  const before = process.memoryUsage(), contextBefore = contextSwitches();
  let current = null;
  let sampleResult;
  try {
    if (typeof MotionValue !== 'function' || ![1, 2].includes(workMultiplier)) throw new Error('stock C: неизвестный constructor/work multiplier');
    const macro = createMotionValueDefaultBenchmark(MotionValue, scene.spring);
    const batch = (timed, multiplier) => {
      const calls = scene.callsPerRepetition * multiplier;
      const values = new Array(calls), frames = new Array(calls);
      const cpuReads = [], clockReads = [];
      current = { raw: { schemaVersion: 1, scene: scene.id, phase: timed ? 'timed' : 'warmup', calls,
        denominator: scene.callsPerRepetition, completed: 0, clockReads, cpuReads, values, frames, unfinishedOperation: null } };
      const read = (edge) => {
        const valueNs = threadCpuNs(cpuReads);
        clockReads.push({ sequence: clockReads.length, metric: 'operationNs', frame: null, edge, valueNs: String(valueNs) });
        return valueNs;
      };
      const start = timed ? read('before') : null;
      for (let operation = 0; operation < calls; operation++) {
        // Чтение frame count необходимо для каждого вызова: среднее47
        // не отличает две неправильные операции0/94. Два массива выделены
        // до CPU, а преобразование в RLE и oracle выполняются после него.
        const value = macro.run();
        values[operation] = value;
        frames[operation] = macro.getFrameCount();
        current.raw.completed++;
      }
      const end = timed ? read('after') : null;
      const result = { operationNs: timed ? Number(end - start) / scene.callsPerRepetition : null,
        raw: { schemaVersion: 1, scene: scene.id, phase: timed ? 'timed' : 'warmup', calls,
          denominator: scene.callsPerRepetition, completed: calls, clockReads, cpuReads,
          outcomes: compactStockMotionValueOutcomes(values, frames) } };
      current = result;
      validateStockMotionValueBatch(result, scene, multiplier, timed);
      return result;
    };
    // Штатные две warmup batches до первой измеренной работы; candidate
    // попадает сюда только после общей calibration и frozen N.
    for (let index = 0; index < scene.warmupBatches; index++) warmup.push(batch(false, 1));
    for (let repetition = 0; repetition < SERVER_PROFILE.repetitions; repetition++) raw.push(batch(true, workMultiplier));
    sampleResult = { operationNs: raw.reduce((sum, result) => sum + result.operationNs, 0) / SERVER_PROFILE.repetitions,
      semantic: true, repetitions: SERVER_PROFILE.repetitions, workMultiplier, denominator: SERVER_PROFILE.denominator,
      cpuScope: SERVER_PROFILE.stockCpuScope, warmup, raw,
      cpuClock: sampleCpuClock(raw),
      contextSwitchObservation: { before: contextBefore, after: contextSwitches(), scope: 'Node process; CPU только текущего потока' },
      allocationObservation: { before, after: process.memoryUsage(), scope: 'whole macro + recorder + oracle + harness; retained отдельно' } };
    validateServerEngineSample(sampleResult, scene, workMultiplier);
    return sampleResult;
  } catch (error) {
    if (current?.raw?.values) {
      const completed = current.raw.completed;
      const valueAcquired = Object.hasOwn(current.raw.values, completed);
      const frameAcquired = Object.hasOwn(current.raw.frames, completed);
      current.raw.unfinishedOperation = { index: completed, valueAcquired, frameAcquired };
      const acquired = (values, count) => values.slice(0, count).map((value) => value === undefined ? { type: 'undefined' }
        : Object.is(value, -0) ? { number: '-0' } : value);
      current.raw.values = acquired(current.raw.values, completed + Number(valueAcquired));
      current.raw.frames = acquired(current.raw.frames, completed + Number(frameAcquired));
    }
    throw Object.assign(new AggregateError([error], 'server profile: stock C sample не завершён'), { raw: sampleResult ?? preserveRawNumbers({
      warmup, completed: raw, failedRepetition: current, before, after: process.memoryUsage() }) });
  }
}

async function browserTimerProbe(page, phase) {
  const raw = await withBrowserTimeout(page.evaluate(() => {
    const deltas = [];
    for (let i = 0; i < 64; i++) {
      const begin = performance.now(); let end = begin;
      for (let attempts = 0; attempts < 1_000_000 && end === begin; attempts++) end = performance.now();
      if (end > begin) deltas.push(end - begin);
    }
    return { timeOriginMs: performance.timeOrigin, performanceNowDeltasMs: deltas };
  }), 'browser timer probe');
  return { phase, ...raw };
}

export async function measureServerBrowser(browser, origin, adapter, scene, workMultiplier = 1) {
  const context = await withBrowserTimeout(browser.newContext({ viewport: SERVER_PROFILE.viewport, deviceScaleFactor: SERVER_PROFILE.deviceScaleFactor }), 'browser context');
  const partial = [];
  let before, sampleResult, failure;
  try {
    const page = await context.newPage(); await page.goto(origin.url, { waitUntil: 'load' });
    await page.exposeFunction('__serverSavePartial', (value) => { partial.push(preserveRawNumbers(value)); });
    if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error('server profile: отсутствует изоляция realm часов');
    const source = readFileSync(adapter.path, 'utf8');
    const coldImportMs = await withBrowserTimeout(page.evaluate((source) => {
      const begin = performance.now(); (0, eval)(source); return performance.now() - begin;
    }, source), 'browser cold import');
    partial.push({ phase: 'cold-import', coldImportMs });
    const semanticClockErrorMs = serverBrowserSemanticClockErrorMs(process.hrtime.bigint().toString());
    const semanticConfig = { ...scene, ...SERVER_PROFILE.browserSemantics, semanticClockErrorMs,
      durationMs: SERVER_PROFILE.durationMs, toPx: SERVER_PROFILE.toPx };
    const semanticEvidence = compactServerSemanticEvidence(await withBrowserTimeout(
      runSemanticStartCheck(page, semanticConfig, SERVER_PROFILE.browserSemanticCalls), 'browser normal-motion semantic control'));
    partial.push({ phase: 'normal-motion', evidence: semanticEvidence });
    if (!semanticEvidence.valid) throw Object.assign(new Error('server profile: normal motion/topology не доказаны существующим oracle'), { raw: { partial, semanticEvidence } });
    before = await browserTimerProbe(page, 'before');
    const result = await withBrowserTimeout(page.evaluate(async (config) => {
      const A = window.__adapterModule;
      const drain = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const compact = (values) => {
        if (values.every((value) => Object.is(value, values[0]))) return { encoding: 'repeat', count: values.length, value: values[0] };
        const runs = [];
        for (const value of values) {
          if (runs.length && Object.is(runs.at(-1)[1], value)) runs.at(-1)[0]++;
          else runs.push([1, value]);
        }
        return { encoding: 'rle', count: values.length, runs };
      };
      const expand = (values) => Array.isArray(values) ? values : values.encoding === 'repeat' ? Array(values.count).fill(values.value)
        : values.runs.flatMap(([length, value]) => Array(length).fill(value));
      const snapshot = (els) => ({ connectedTargets: els.filter((element) => element.isConnected).length,
        activeWaapi: els.reduce((sum, element) => sum + element.getAnimations().length, 0),
        transforms: compact(els.map((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).e)) });
      const cancellationWitness = async (els, cancelBegin) => {
        const before = snapshot(els), frames = [];
        for (let frame = 0; frame < config.cancellation.frames; frame++) { await drain(); frames.push(snapshot(els)); }
        return { connectedTargets: before.connectedTargets, activeWaapiBefore: before.activeWaapi,
          transformsBefore: before.transforms, frames, cancelDrainMs: performance.now() - cancelBegin };
      };
      const assertCancellation = (witness, targets) => {
        const before = expand(witness.transformsBefore);
        if (witness.connectedTargets !== targets || witness.activeWaapiBefore !== 0 ||
            witness.frames.some((frame) => frame.connectedTargets !== targets || frame.activeWaapi !== 0 ||
              expand(frame.transforms).some((value, index) => !Number.isFinite(value) || Math.abs(value - before[index]) > config.cancellation.transformTolerancePx))) {
          throw new Error('cancel не достиг наблюдаемой неподвижности attached targets после двух rAF');
        }
      };
      const create = () => Array.from({ length: config.scene.targetsPerCall }, () => {
        const el = document.createElement('div'); el.className = 'box'; document.body.appendChild(el); return el;
      });
      const start = (els) => config.scene.staggerGapMs > 0
        ? A.startStagger(els, config.toPx, config.durationMs, config.scene.staggerGapMs)
        : A.start(els, config.toPx, config.durationMs);
      if (typeof start !== 'function' || !A?.start || (config.scene.staggerGapMs > 0 && !A.startStagger)) throw new Error('нет общего API сцены');
      // Независимый CSS matrix oracle подтверждает реальный линейный endpoint.
      const witness = create();
      const controlStartBegin = performance.now(); const control = start(witness); const controlStartMs = performance.now() - controlStartBegin;
      await new Promise((resolve) => setTimeout(resolve, config.durationMs + (witness.length - 1) * config.scene.staggerGapMs + 100));
      const endpoints = witness.map((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).e);
      await window.__serverSavePartial({ phase: 'endpoint-observed-before-cancel', controlStartMs, endpoints });
      const controlCancelBegin = performance.now(); control.cancel(); const controlCancelMs = performance.now() - controlCancelBegin;
      await window.__serverSavePartial({ phase: 'endpoint-before-cleanup', controlStartMs, controlCancelMs, endpoints });
      const controlCancelWitness = await cancellationWitness(witness, controlCancelBegin);
      await window.__serverSavePartial({ phase: 'endpoint', controlStartMs, controlCancelMs, endpoints, controlCancelWitness });
      assertCancellation(controlCancelWitness, config.scene.targetsPerCall);
      witness.forEach((element) => element.remove());
      if (endpoints.some((value) => !Number.isFinite(value) || Math.abs(value - config.toPx) > 2)) throw new Error('не совпал endpoint oracle');
      const raw = [], warmup = [];
      for (let repetition = -1; repetition < config.repetitions; repetition++) {
          const calls = config.batchCalls * config.workMultiplier;
          const groups = Array.from({ length: calls }, create), owners = [];
          const beginMs = performance.now();
          try { for (const targets of groups) owners.push(start(targets)); } catch (error) {
            await window.__serverSavePartial({ phase: 'batch-start-failed', repetition, calls, ownersStarted: owners.length,
              unfinishedStartClock: { beginMs, endMs: performance.now() }, error: { name: error?.name ?? typeof error, message: String(error?.message ?? error) } });
            throw error;
          }
          const startClock = { beginMs, endMs: performance.now() };
          const batchStartMs = startClock.endMs - startClock.beginMs;
          const readBeginMs = performance.now();
          const targets = groups.flat();
          const startWitness = { connectedTargets: targets.filter((element) => element.isConnected).length,
            activeWaapi: targets.reduce((sum, element) => sum + element.getAnimations().length, 0),
            leadingPositions: compact(groups.map((elements) => new DOMMatrixReadOnly(getComputedStyle(elements[0]).transform).e)),
            readClock: { beginMs: readBeginMs, endMs: performance.now() } };
          await window.__serverSavePartial({ phase: 'batch-started-before-cancel', repetition, calls, startClock, startWitness,
            acquiredBatchStartMs: batchStartMs, ownersStarted: owners.length });
          let ownersCancelled = 0;
          const cancelBegin = performance.now();
          try { for (const owner of owners) { owner.cancel(); ownersCancelled++; } } catch (error) {
            await window.__serverSavePartial({ phase: 'batch-cancel-failed', repetition, calls, startClock, startWitness,
              batchStartMs, ownersStarted: owners.length, ownersCancelled, unfinishedCancelClock: { beginMs: cancelBegin, endMs: performance.now() },
              error: { name: error?.name ?? typeof error, message: String(error?.message ?? error) } });
            throw error;
          }
          const cancelClock = { beginMs: cancelBegin, endMs: performance.now() };
          const batchCancelMs = cancelClock.endMs - cancelClock.beginMs;
          const row = { startMs: batchStartMs / config.batchCalls, cancelMs: batchCancelMs / config.batchCalls,
            batchStartMs, batchCancelMs, calls, ownersStarted: owners.length, ownersCancelled, startClock, cancelClock, startWitness };
          if (repetition < 0) warmup.push(row); else raw.push(row);
          await window.__serverSavePartial({ phase: 'timing-before-cleanup', repetition, ...row });
          row.cancelWitness = await cancellationWitness(targets, cancelBegin);
          await window.__serverSavePartial({ phase: repetition < 0 ? 'warmup' : 'timing', repetition, ...row });
          assertCancellation(row.cancelWitness, calls * config.scene.targetsPerCall);
          if (expand(startWitness.leadingPositions).some((value) => !Number.isFinite(value) || value < -2 || value >= config.toPx - 2)) {
            throw new Error('timed owner не сохранил окно до endpoint');
          }
          targets.forEach((element) => element.remove()); await Promise.resolve();
      }
      return { raw, warmup, endpoints, controlStartMs, controlCancelMs, controlCancelWitness, measurementTimeOriginMs: performance.timeOrigin,
        heapObservation: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null };
    }, { scene, workMultiplier, repetitions: SERVER_PROFILE.repetitions, durationMs: SERVER_PROFILE.durationMs, toPx: SERVER_PROFILE.toPx,
      batchCalls: SERVER_PROFILE.browserBatchCalls, cancellation: SERVER_PROFILE.browserCancellationWitness }), 'browser API sample');
    const after = await browserTimerProbe(page, 'after');
    const timerEvidence = { crossOriginIsolated: true, probes: [before, after] };
    const timerStepMs = deriveRealmTimerStep('server browser', timerEvidence);
    const monotonicHostUpperNs = process.hrtime.bigint().toString();
    sampleResult = { ...result, coldImportMs, semanticEvidence, timerEvidence, timerStepMs, monotonicHostUpperNs,
      clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError),
      startMs: result.raw.reduce((sum, row) => sum + row.startMs, 0) / SERVER_PROFILE.repetitions,
      cancelMs: result.raw.reduce((sum, row) => sum + row.cancelMs, 0) / SERVER_PROFILE.repetitions,
      repetitions: SERVER_PROFILE.repetitions, workMultiplier, denominator: SERVER_PROFILE.denominator, semantic: true };
    validateServerBrowserSample(sampleResult, scene, workMultiplier);
  } catch (error) {
    failure = Object.assign(new AggregateError([error], 'server profile: browser sample не завершён'), {
      raw: sampleResult ?? error?.raw ?? { partial, timerBefore: before, scene, workMultiplier }, timerEvidence: error?.timerEvidence });
  } finally {
    try { await withBrowserTimeout(context.close(), 'browser context cleanup'); } catch (error) {
      failure = Object.assign(new AggregateError([...(failure ? [failure] : []), error], 'server profile: browser cleanup не завершён'),
        { raw: sampleResult ?? failure?.raw ?? { partial, timerBefore: before, scene, workMultiplier } });
    }
  }
  if (failure) throw failure;
  return sampleResult;
}

async function measureBrowserRawControls(browser, origin, adapter, out, id) {
  const context = await withBrowserTimeout(browser.newContext({ viewport: SERVER_PROFILE.viewport, deviceScaleFactor: SERVER_PROFILE.deviceScaleFactor, reducedMotion: 'reduce' }), 'raw-control browser context');
  let result, failure;
  const partial = {};
  try {
    await context.addInitScript(() => {
      window.__serverRafCount = 0;
      const request = globalThis.requestAnimationFrame.bind(globalThis);
      globalThis.requestAnimationFrame = (callback) => { window.__serverRafCount++; return request(callback); };
    });
    const page = await context.newPage(); await page.goto(origin.url);
    await page.addScriptTag({ path: adapter.path });
    await page.evaluate(() => {
      const el = document.createElement('div'); el.className = 'box'; el.id = 'static-control'; document.body.appendChild(el);
    });
    const first = await page.screenshot(); const second = await page.screenshot();
    const firstFile = path.join(out, `${id}-no-motion-before.png`), secondFile = path.join(out, `${id}-no-motion-after.png`);
    writeFileSync(firstFile, first, { flag: 'wx' }); writeFileSync(secondFile, second, { flag: 'wx' });
    partial.noMotion = { firstFile, secondFile, beforeSha256: sha256File(firstFile), afterSha256: sha256File(secondFile), equal: first.equals(second) };
    if (!first.equals(second)) throw Object.assign(new Error('server profile: no-motion PNG различаются'), {
      raw: { firstFile, secondFile, beforeSha256: sha256File(firstFile), afterSha256: sha256File(secondFile) } });
    const reduced = await withBrowserTimeout(page.evaluate(async (config) => {
      const el = document.getElementById('static-control'); const before = window.__serverRafCount;
      const owner = window.__adapterModule.start([el], config.toPx, config.durationMs);
      await Promise.resolve();
      const x = new DOMMatrixReadOnly(getComputedStyle(el).transform).e;
      const rafRequests = window.__serverRafCount - before; const activeWaapi = el.getAnimations().length;
      owner.cancel(); return { x, rafRequests, activeWaapi, prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
    }, SERVER_PROFILE), 'browser reduced-motion control');
    partial.reduced = reduced;
    if (!reduced.prefersReducedMotion || Math.abs(reduced.x - SERVER_PROFILE.toPx) > 2 || reduced.rafRequests !== 0 || reduced.activeWaapi !== 0) {
      throw Object.assign(new Error('server profile: reduced-motion не выполнил snap без движущего владельца'), { raw: reduced });
    }
    result = partial;
  } catch (error) {
    failure = Object.assign(new AggregateError([error], 'server profile: raw control не завершён'), { raw: { ...partial, failureRaw: error.raw ?? null } });
  } finally {
    try { await withBrowserTimeout(context.close(), 'raw-control context cleanup'); } catch (error) {
      failure = Object.assign(new AggregateError([...(failure ? [failure] : []), error], 'server profile: raw-control cleanup не завершён'), { raw: result ?? failure?.raw ?? partial });
    }
  }
  if (failure) throw failure;
  return result;
}

function makeRetention(packageDirectory) {
  const result = spawnSync(process.execPath, ['--expose-gc', path.join(ROOT, 'bench/profile/server-profile-retention.mjs'), packageDirectory],
    { encoding: 'utf8', timeout: 60_000 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { /* Даже malformed stdout сохраняется при отказе child. */ }
  if (result.status !== 0 || report?.verdict !== 'COMPLETE') throw Object.assign(new Error(`server profile retention: ${result.stderr || result.error?.message || result.status}`),
    { raw: { report, stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal } });
  return report;
}

export async function runServerProfile({ baseline, candidate, browser: browserName, out }, dependencies = {}) {
  const journal = createServerJournal(out);
  const artifact = { schema: 1, protocol: SERVER_PROFILE, registration: null, registrationDigest: null,
    verdict: 'UNPROVEN', failures: [], warmup: [], gc: [], stages: [],
    jitObservation: { status: 'UNPROVEN', reason: 'GC events наблюдаются; точная JIT attribution требует отдельного intrusive trace и не подменяется гипотезой' } };
  let browser, origin, observer, engineClock, interruptionRecorded = false;
  const checkpoint = () => dependencies.signal?.throwIfAborted();
  let prepared = {}, roots = {}, harness = {}, packages = {};
  const verify = () => {
    engineClock?.assertUnchanged();
    if (artifact.registration) {
      const current = captureServerLoad(), registered = artifact.registration.machine.identity;
      if (current.affinity !== registered.affinity || current.cpuMax !== registered.cgroupCpuMax) {
        throw Object.assign(new Error('server profile: machine affinity/quota изменились после регистрации'), { raw: { current, registered } });
      }
    }
    for (const [id, provenance] of Object.entries(prepared)) {
      assertCheckoutUnchanged(roots[id], provenance);
      assertInstalledPackageTreesUnchanged(roots[id], provenance.environment.rootPackages);
      assertInstalledPackageTreesUnchanged(BENCH, provenance.environment.packages);
    }
    assertFileHashesUnchanged(harness);
    for (const consumer of [...Object.values(packages), ...Object.values(artifact.registration?.transitivePackages ?? {})]) {
      if (sha256File(consumer.tarball) !== consumer.tarballSha256 || hashFileTree(consumer.directory).sha256 !== consumer.treeSha256) throw new Error('server profile: изменились consumer bytes');
    }
    if (artifact.registration?.browserTree && hashFileTree(artifact.registration.browserTree.directory).sha256 !== artifact.registration.browserTree.sha256) throw new Error('server profile: изменились browser bytes');
  };
  try {
    checkpoint();
    if (!SERVER_PROFILE.browsers.includes(browserName)) throw new Error('server profile: неизвестный browser');
    if (browserName !== SERVER_PROFILE.clockError.browser) throw new Error('server profile: clock model этого browser пока UNPROVEN');
    roots = { baseline: realpathSync(baseline), candidate: realpathSync(candidate) };
    if (roots.baseline === roots.candidate) throw new Error('server profile: baseline/candidate требуют разных checkout');
    engineClock = prepareServerThreadCpuClock({ directory: out });
    artifact.engineClockPreparation = engineClock.metadata;
    const machine = captureServerMachine();
    const esbuild = requireBench('esbuild'); const playwright = requireBench('playwright');
    const browserType = playwright[browserName];
    const executable = browserType.executablePath();
    const browserExecutableSha256 = sha256File(executable);
    const browserTree = { directory: path.dirname(executable), ...hashFileTree(path.dirname(executable)) };
    harness = Object.fromEntries([...HARNESS_FILES, ...ENTRIES.map((id) => `bench/compare/entries/${id === 'waapi-ctl' ? 'waapi-control' : id}.entry.mjs`)]
      .map((file) => [file, { path: path.join(ROOT, file), sha256: sha256File(path.join(ROOT, file)) }]));
    for (const id of ['baseline', 'candidate']) {
      prepared[id] = prepareBenchmarkCheckout({ root: roots[id], benchDirectory: BENCH, build: buildToStderr,
        requiredDist: ['dist/animate/index.js', 'dist/index.js'], requiredPackages: ['esbuild', 'playwright', 'motion', 'gsap', 'animejs'],
        requiredRootPackages: ['tsup', 'typescript', 'esbuild'], requiredInputs: Object.entries(harness).map(([key, info]) => [key, info.path]) });
    }
    if (prepared.baseline.revision !== SERVER_PROFILE.baselineRevision) throw new Error('server profile: baseline отличается от регистрации');
    const consumers = {};
    for (const id of ['baseline', 'candidate', 'comparators']) {
      consumers[id] = path.join(out, 'consumers', id); mkdirSync(path.join(consumers[id], 'node_modules'), { recursive: true });
    }
    for (const id of ['baseline', 'candidate']) packages[id] = packConsumer(roots[id], path.join(out, 'packages', id), path.join(consumers[id], 'node_modules'));
    const closure = new Map();
    for (const [id, name] of Object.entries(PACKAGES)) packages[id] = packageClosure(name, path.join(out, 'packages', 'vendors'), path.join(consumers.comparators, 'node_modules'), closure);
    const adapters = {};
    for (const id of ['baseline', 'candidate', ...SERVER_PROFILE.comparators]) adapters[id] = buildAdapter(id, consumers[id] ?? consumers.comparators, esbuild, out);
    Object.entries(adapters).forEach(([id, value]) => { harness[`adapter:${id}`] = value; });
    origin = await startBenchmarkOrigin(); checkpoint();
    browser = await browserType.launch({ headless: SERVER_PROFILE.headless, executablePath: executable }); checkpoint();
    artifact.registration = { protocolDigest: serverProfileDigest(SERVER_PROFILE), candidateSamplesObserved: false,
      candidateSamplesObservedScope: SERVER_PROFILE.candidateSamplesObservedScope,
      clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError),
      registeredAt: new Date().toISOString(), browser: browserName, browserVersion: browser.version(), browserExecutableSha256, browserTree,
      machine, engineClock: engineClock.metadata, provenance: prepared, packages, transitivePackages: Object.fromEntries(closure), harness,
      allocationScope: 'observational heap + GC; retained отдельным процессом после timing' };
    verifyServerClockRegistration(artifact.registration);
    artifact.registrationDigest = serverProfileDigest(artifact.registration);
    journal('registration-before-any-sample', { registration: artifact.registration, digest: artifact.registrationDigest });
    checkpoint();
    verify();
    artifact.rawControls = { baseline: await measureBrowserRawControls(browser, origin, adapters.baseline, out, 'baseline') };
    journal('raw-controls-baseline', artifact.rawControls.baseline);
    checkpoint();
    const implementations = {};
    const loadImplementation = async (id) => {
      const metadata = JSON.parse(readFileSync(path.join(packages[id].directory, 'package.json'), 'utf8'));
      const entry = metadata.exports['./animate'].import.default;
      implementations[id] = (await import(pathToFileURL(path.join(packages[id].directory, entry)).href)).animate;
      const main = metadata.exports['.'].import.default;
      implementations[`${id}:stock-c`] = (await import(pathToFileURL(path.join(packages[id].directory, main)).href)).MotionValue;
    };
    await loadImplementation('baseline');
    observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) artifact.gc.push({ startTime: entry.startTime, duration: entry.duration, detail: entry.detail }); });
    observer.observe({ entryTypes: ['gc'] });
    const engineMeasure = dependencies.engineMeasure ?? measureServerEngine;
    const browserMeasure = dependencies.browserMeasure ?? measureServerBrowser;
    const runStage = async (name, runs) => {
      checkpoint();
      const stage = { name, rows: [], blocks: [] }; artifact[name] = stage; artifact.stages.push(name);
      let resourceBefore;
      for (let run = 0; run < runs; run++) {
        if (run % 2 === 0) resourceBefore = captureServerLoad();
        for (const [kind, scenes] of [['engine', SERVER_PROFILE.engineScenes], ['browser', SERVER_PROFILE.browserScenes]]) {
          const row = { kind, scene: scenes[0]?.id, run, order: serverOrders(runs)[run], samples: {} };
          for (const scene of scenes) {
            const current = { ...row, scene: scene.id, samples: {} };
            stage.rows.push(current);
            for (const id of current.order) {
              checkpoint();
              const build = name === 'ab' && id === 'right' ? 'candidate' : 'baseline';
              const multiplier = name === 'positive' && id === 'right' ? SERVER_PROFILE.positiveWorkMultiplier : 1;
              try {
                const sample = kind === 'engine' ? await engineMeasure(implementations[scene.workload === 'stock-c' ? `${build}:stock-c` : build], scene, multiplier)
                  : await browserMeasure(browser, origin, adapters[build], scene, multiplier);
                if (kind === 'engine') compactSampleCpuEvidence(sample);
                current.samples[id] = sample;
                journal('sample', { stage: name, kind, scene: scene.id, run, participant: id, build, value: current.samples[id] });
              } catch (error) {
                journal('failed-sample', { stage: name, kind, scene: scene.id, run, participant: id, build, error: errorRecord(error),
                  partial: error.raw ?? null, timerEvidence: error.timerEvidence ?? null });
                throw error;
              }
              checkpoint();
            }
          }
        }
        if (run % 2 === 1) {
          const after = captureServerLoad();
          const block = { block: Math.floor(run / 2), before: resourceBefore, after,
            delta: Object.fromEntries(['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'].map((key) => [key, after.cpuStat[key] - resourceBefore.cpuStat[key]])) };
          stage.blocks.push(block); journal('resources-block', { stage: name, ...block });
        }
        process.stderr.write(`server profile ${name}: ${run + 1}/${runs}\n`);
      }
      verify(); return stage;
    };
    if (!await runServerProfileCalibration(artifact, runStage, journal)) return artifact;
    checkpoint();
    await loadImplementation('candidate');
    checkpoint();
    artifact.rawControls.candidate = await measureBrowserRawControls(browser, origin, adapters.candidate, out, 'candidate');
    journal('raw-controls-candidate-after-calibration', artifact.rawControls.candidate);
    checkpoint();
    artifact.ab = await runStage('ab', artifact.samplePlan.runs);
    artifact.comparison = serverFamilyIntervals(serverCellPairs(artifact.ab, artifact.samplePlan.runs, 'ab', artifact.registration.engineClock));
    const abResourceReasons = serverResourceReasons([artifact.ab], artifact.registration.machine.identity);
    if (abResourceReasons.length) throw new Error(`server profile: условия A/B нарушены: ${abResourceReasons.join('; ')}`);
    artifact.comparators = [];
    for (const scene of SERVER_PROFILE.browserScenes) for (const id of SERVER_PROFILE.comparators) {
      checkpoint();
      if (scene.staggerGapMs > 0 && ['motion-mini', 'anime-waapi'].includes(id)) {
        artifact.comparators.push({ scene: scene.id, id, status: 'UNPROVEN', reason: 'existing owner entry не реализует общий stagger API' }); continue;
      }
      const comparison = { scene: scene.id, id, rows: [], claim: 'raw API cost; descriptive only, без рейтинга и M-05 superiority' };
      artifact.comparators.push(comparison);
      for (let run = 0; run < artifact.samplePlan.runs; run++) {
        checkpoint();
        try {
          const sample = await browserMeasure(browser, origin, adapters[id], scene);
          comparison.rows.push(sample); journal('comparator-sample', { scene: scene.id, id, run, sample });
        } catch (error) {
          journal('failed-comparator-sample', { stage: 'ab', scene: scene.id, id, run, error: errorRecord(error) }); throw error;
        }
        checkpoint();
      }
    }
    artifact.retention = {};
    for (const id of ['baseline', 'candidate']) {
      checkpoint();
      artifact.retention[id] = makeRetention(packages[id].directory);
      journal('retention-sample', { id, value: artifact.retention[id] });
      checkpoint();
    }
    journal('retention-separate-forced-GC', artifact.retention);
    artifact.verdict = artifact.comparison.every((cell) => cell.p95.bounded && cell.p95.high <= SERVER_PROFILE.nonInferiorityUpper) ? 'PASS' : 'NO-GO';
    return artifact;
  } catch (error) {
    interruptionRecorded = dependencies.signal?.aborted && error === dependencies.signal.reason;
    artifact.failures.push({ stage: artifact.stages.at(-1) ?? 'preparation', at: new Date().toISOString(), error: errorRecord(error) });
    journal('failure', artifact.failures.at(-1)); return artifact;
  } finally {
    if (observer) {
      for (const entry of observer.takeRecords()) artifact.gc.push({ startTime: entry.startTime, duration: entry.duration, detail: entry.detail });
      observer.disconnect();
    }
    try { verify(); } catch (error) {
      artifact.verdict = 'UNPROVEN'; const failure = { stage: 'final-provenance', error: errorRecord(error) };
      artifact.failures.push(failure); journal('failure', failure);
    }
    for (const [resource, close] of [['browser', () => browser?.close()], ['origin', () => origin?.close()]]) {
      try { await withBrowserTimeout(close(), `${resource} cleanup`); } catch (error) {
        artifact.verdict = 'UNPROVEN'; const failure = { stage: 'cleanup', resource, error: errorRecord(error) };
        artifact.failures.push(failure); journal('failure', failure);
      }
    }
    if (dependencies.signal?.aborted && !interruptionRecorded) {
      artifact.verdict = 'UNPROVEN';
      const failure = { stage: 'operator-interruption', error: errorRecord(dependencies.signal.reason) };
      artifact.failures.push(failure); journal('failure', failure);
    }
    artifact.finishedAt = new Date().toISOString();
    const { sha256: digest } = writeServerArtifact(path.join(out, 'server-profile.json'), artifact);
    writeFileSync(path.join(out, 'server-profile.sha256'), `${digest}  server-profile.json\n`, { flag: 'wx' });
    journal('finished', { verdict: artifact.verdict, digest });
  }
}

export function parseServerProfileArgs(args) {
  if (args.length !== 8 || args[0] !== '--baseline' || args[2] !== '--candidate' || args[4] !== '--browser' || args[6] !== '--out' ||
      args.filter((_, i) => i % 2 === 1).some((x) => !x || x.startsWith('--'))) {
    throw new Error('server profile: нужны ровно --baseline <root> --candidate <root> --browser chromium|firefox|webkit --out <новый каталог>');
  }
  return { baseline: args[1], candidate: args[3], browser: args[5], out: path.resolve(args[7]) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const artifact = await withServerProfileSignals((signal) => runServerProfile(parseServerProfileArgs(process.argv.slice(2)), { signal }));
    process.stdout.write(`${JSON.stringify({ verdict: artifact.verdict, registrationDigest: artifact.registrationDigest, failures: artifact.failures,
      artifact: path.join(parseServerProfileArgs(process.argv.slice(2)).out, 'server-profile.json') })}\n`);
    process.exitCode = artifact.verdict === 'PASS' ? 0 : 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
