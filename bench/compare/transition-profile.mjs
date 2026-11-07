import { readFileSync, writeFileSync, appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const group = process.argv[4] ?? 'full';
const startupScenario = process.env.MOTION_STARTUP_DIAGNOSTIC_SCENARIO ?? '';
if (startupScenario && (group !== 'startup-diagnostic' || !['s2-warm', 's2-pre-read'].includes(startupScenario)))
  throw new Error('MOTION_STARTUP_DIAGNOSTIC_SCENARIO requires startup-diagnostic and s2-warm or s2-pre-read');
const preReadProbe = startupScenario === 's2-pre-read';
const s2Warm = startupScenario === 's2-warm' || preReadProbe;
const rootPath = realpathSync(process.argv[2] ?? process.cwd());
const baselinePath = process.argv[5] ? realpathSync(process.argv[5]) : undefined;
if (baselinePath === rootPath) throw new Error('Baseline and candidate must be distinct checkouts');
const benchPath = path.join(rootPath, 'bench/compare');
const output = path.resolve(process.argv[3] ?? path.join(benchPath, 'results', `transition-${Date.now()}`));
const load = file => import(pathToFileURL(path.join(rootPath, file)).href);
const { startBenchmarkOrigin, runSemanticStartCheck } = await load('bench/compare/bench.mjs');
const { START_SCENARIO_MANIFEST, makeRoundRobinOrders, PRODUCTION_ADAPTER_PROFILE } = await load('bench/compare/methodology.mjs');
const { canonicalGzip, observationalBrotli } = await load('scripts/compression-oracle.mjs');
const { hashFileTree } = await load('bench/compare/provenance.mjs');
const measuredRoots = { candidate: rootPath, ...(baselinePath ? { baseline: baselinePath } : {}) };
const sourceIdentity = Object.fromEntries(Object.entries(measuredRoots).map(([id, directory]) => [id, {
  revision: execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dist: hashFileTree(path.join(directory, 'dist')),
}]));
const require = createRequire(path.join(benchPath, 'package.json'));
const { chromium } = require('playwright');
const esbuild = require('esbuild');
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
mkdirSync(path.join(output, 'adapters'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalFile = file => { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } };
if (!['full', 'native', 'spring-pair', 'js-pair', 'startup-diagnostic'].includes(group)) throw new Error('Unknown capability group');
const diagnostic = group === 'startup-diagnostic';
if (diagnostic && baselinePath) throw new Error('Диагностика старта измеряет один неизменный продукт, а не сравнивает кандидатов');
const paired = group.endsWith('-pair');
if (paired && !baselinePath) throw new Error('Paired runtime profile requires an immutable baseline');
const ids = diagnostic ? s2Warm ? ['lab', 'motion', 'anime'] : ['lab', 'waapi-ctl'] : paired ? ['lab'] : group === 'native'
  ? ['lab', 'lab-native', 'motion-mini', 'waapi-ctl']
  : ['lab', 'motion', 'gsap', 'anime', 'waapi-ctl'];
if (baselinePath) ids.push('baseline');
const counts = diagnostic ? [s2Warm ? START_SCENARIO_MANIFEST.s2.targetsPerCall : 1000] : [1, 100, 1000];
const rounds = diagnostic ? s2Warm ? 6 : 4 : Math.ceil(20 / ids.length) * ids.length;
const durationMs = s2Warm ? START_SCENARIO_MANIFEST.s2.durationMs : 400, watchdogMs = 10_000;
const observations = diagnostic ? s2Warm ? ids.flatMap(id => preReadProbe ? [`${id}:control`, `${id}:pre-read`] : [`${id}:plain`, `${id}:profiled`]) : ['lab:plain', 'lab:profiled', 'waapi-ctl:plain', 'waapi-ctl:profiled'] : ids;
const entries = { 'lab-native': 'lab-native', lab: 'lab', motion: 'motion', gsap: 'gsap', anime: 'anime', 'waapi-ctl': 'waapi-control', 'motion-mini': 'motion-mini', 'anime-waapi': 'anime-waapi' };
if (baselinePath) entries.baseline = 'lab';
const adapters = Object.fromEntries(Object.entries(entries).filter(([id]) => !diagnostic || ids.includes(id)).map(([id, entry]) => {
  const outputPath = path.join(output, 'adapters', `${id}.js`);
  const directory = id === 'baseline' ? baselinePath : rootPath;
  const options = group === 'spring-pair' ? '{}' : '{duration, ease: p => p * p * (3 - 2 * p)}';
  const input = paired && (id === 'lab' || id === 'baseline')
    ? { stdin: { contents: 'import { animate } from ' + JSON.stringify(path.join(directory, 'dist/motion/index.js')) +
      '; export function start(els, px, duration) { const run = animate(els, {x:px}, ' + options +
      '); return {finished: () => run.finished, cancel: () => run.stop(), pause: () => run.pause(), seek: t => run.seek(t), duration: run.duration}; }',
      resolveDir: directory, sourcefile: 'root-pair.mjs', loader: 'js' } }
    : { entryPoints: [path.join(directory, 'bench/compare/entries', entry + '.entry.mjs')] };
  esbuild.buildSync({ ...PRODUCTION_ADAPTER_PROFILE, ...input, format: 'iife', globalName: '__adapterModule', outfile: outputPath });
  const bytes = readFileSync(outputPath);
  return [id, { path: outputPath, sha256: hash(bytes), raw: bytes.length, gzip: canonicalGzip(bytes).length, brotli: observationalBrotli(bytes).length }];
}));
const root = JSON.parse(readFileSync(path.join(rootPath, 'package.json')));
const manifest = JSON.parse(readFileSync(path.join(benchPath, 'package.json')));
const installed = Object.fromEntries(Object.entries(manifest.devDependencies).map(([name, expected]) => {
  const actual = JSON.parse(readFileSync(path.join(benchPath, 'node_modules', name, 'package.json'))).version;
  if (actual !== expected) throw new Error('Installed package differs from manifest: ' + name);
  return [name, actual];
}));
const orders = makeRoundRobinOrders(observations, rounds, 0x5A71);
const origin = await startBenchmarkOrigin();
const browser = await chromium.launch({ headless: false, args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const metadata = {
  schema: 1, generatedAt: new Date().toISOString(), revision: execFileSync('git', ['-C', rootPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  profileSha256: hash(readFileSync(new URL(import.meta.url))),
  versions: { lab: root.version, ...installed, chromium: browser.version(), node: process.version },
  environment: { cpu: os.cpus()[0].model, cpuMax: optionalFile('/sys/fs/cgroup/cpu.max'), memoryMax: optionalFile('/sys/fs/cgroup/memory.max') },
  scenario: { group, counts, rounds, durationMs: group === 'spring-pair' ? null : durationMs, watchdogMs, targetPx: 300, easing: group === 'spring-pair' ? 'default spring' : group === 'js-pair' ? 'p*p*(3-2*p), custom JS callback' : 'linear', viewport: { width: 1200, height: 600 }, page: 'fresh realm; modules loaded before measurement', timeDomain: 'threadTicks', intervals: s2Warm ? 'before/after total: optional profiler-start inspector overhead, DOM construction, one warmup and seven five-call starts, immediate cancel/remove/microtask/one-rAF drain; excludes profiler-stop and context-close; no natural completion' : 'actual completion plus two frames and cancel/remove/two-frame cleanup; DOM construction and geometry validation excluded' },
  adapters, orders, sourceIdentity,
  ...(preReadProbe ? { preReadProbe: { conditions: ['control', 'pre-read'], profiler: false,
    runtimeSha256: hash(readFileSync(path.join(rootPath, 'src/motion/runtime.ts'))),
    position: 'first target before each of five public starts; returned computed transform retained',
    accounting: 'pre-read inside before/after CPU and batch whole wall window including construction, start, cancel, remove and existing drain',
    interpretation: 'paired cost relocation falsifier; not an optimization, exact phase CPU or natural-completion measurement' } } : {}),
  ...(s2Warm ? { startupScenario, warmBatch: { ...START_SCENARIO_MANIFEST.s2, warmupBatches: 1, samples: 7, calls: 5 },
    cpuWindow: 'total thread CPU across DOM setup, one warmup and seven five-call batches, immediate cancel/remove/microtask/one-rAF drain; includes inspector overhead; no natural completion',
    phaseCpuMs: { start: null, cancel: null, cleanup: null }, phaseCpuStatus: 'unsupported: sampled stacks are attribution, not exact phase CPU' } : {}),
  ...(diagnostic ? { diagnostic: { interpretation: preReadProbe ? 'Paired pre-read cost relocation falsifier; compare whole useful work, not start-only speedup' : 'Только атрибуция; время под профайлером не доказывает ускорение', profiler: preReadProbe ? null : 'CDP Profiler, стандартный интервал выборки', observations, ...(s2Warm ? { offeredCalls: rounds * observations.length * 40, offeredTargets: rounds * observations.length * 4000, warmupCalls: rounds * observations.length * 5, measuredCalls: rounds * observations.length * 35 } : { offeredStarts: rounds * observations.length }), profileWindow: s2Warm ? 'S2 immediate-cancel batch lifecycle; includes setup, warmup and drain; attribution only' : 'От начала вычисления запуска до его ответа; может включать расходы инспектора и микрозадачи', coverage: 'Образец кадра адаптера ниже startupDiagnosticStart; отсутствие образцов не даёт вывода' } } : {}),
};
writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
const samples = [];
const metrics = async c => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const settle = async page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function pageFor(id, acquired = () => {}) {
  const context = await browser.newContext({ viewport: metadata.scenario.viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  acquired(context);
  const page = await context.newPage();
  await page.goto(origin.url); await page.bringToFront();
  if (diagnostic) await page.addScriptTag({ content: readFileSync(adapters[id].path, 'utf8') + `\n//# sourceURL=motion-startup-${id}.js` });
  else await page.addScriptTag({ path: adapters[id].path });
  return { context, page };
}
let runError;
try {
  if (paired) {
    // Сравнивается публичный seek в браузере; проверка не входит в timed samples.
    const evidence = {};
    for (const id of ids) {
      const { context, page } = await pageFor(id);
      try {
        await settle(page);
        evidence[id] = await page.evaluate(duration => {
          const els = Array.from({ length: 100 }, () => {
            const el = document.createElement('div');
            el.className = 'box'; document.body.appendChild(el); return el;
          });
          let run;
          try {
            run = window.__adapterModule.start(els, 300, duration);
            run.pause();
            const times = [0, 1, 16, 63, 127, 255, 399, 500, 999];
            return { duration: run.duration, samples: times.map(time => {
              run.seek(time);
              return { time, positions: els.map(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).e) };
            }) };
          } finally { run?.cancel(); for (const el of els) el.remove(); }
        }, durationMs);
      } finally { await context.close(); }
    }
    const exact = JSON.stringify(evidence.lab) === JSON.stringify(evidence.baseline);
    writeFileSync(path.join(output, 'paired-semantics.json'), JSON.stringify({ exact, evidence }, null, 2));
    if (!exact) throw new Error('Baseline and candidate public trajectories differ');
  }
  // Сохраняется исходная проверка траектории вместе с её отказами.
  for (const id of diagnostic && !s2Warm ? [] : ids) {
    const { context, page } = await pageFor(id);
    try {
      if (!await page.evaluate(() => typeof window.__adapterModule.startStagger === 'function')) {
        writeFileSync(path.join(output, id + '-original-semantic.json'), JSON.stringify({ status: 'not-applicable', reason: 'adapter-has-no-stagger' }));
        continue;
      }
      const evidence = await runSemanticStartCheck(page, START_SCENARIO_MANIFEST.s2, 5);
      writeFileSync(path.join(output, `${id}-original-semantic.json`), JSON.stringify(evidence));
      console.log(`ORIGINAL_ORACLE ${id} ${evidence.valid}`);
      if (s2Warm && !evidence.valid) throw new Error(`S2 semantic probe failed: ${id}`);
    } finally { await context.close(); }
  }
  if (preReadProbe) {
    const { context, page } = await pageFor('lab');
    try {
      const evidence = await page.evaluate(async () => {
        const sheet = document.createElement('style');
        sheet.textContent = '.pre-read-pose { transform: translate(20px, 40px) rotate(45deg); }';
        const element = document.createElement('div'); element.className = 'box pre-read-pose';
        document.head.appendChild(sheet); document.body.appendChild(element);
        let control;
        try {
          const text = getComputedStyle(element).getPropertyValue('transform');
          const before = new DOMMatrixReadOnly(text);
          if (Math.abs(before.e - 20) > 0.05 || Math.abs(before.f - 40) > 0.05 || Math.abs(before.b - Math.SQRT1_2) > 0.05)
            throw new Error('Stylesheet pose control not engaged');
          control = window.__adapterModule.start([element], 300, 0);
          await control.finished();
          const after = new DOMMatrixReadOnly(getComputedStyle(element).transform);
          if (Math.abs(after.e - 300) > 0.05 || Math.abs(after.f - 40) > 0.05 || Math.abs(after.b - Math.SQRT1_2) > 0.05)
            throw new Error('Pre-read changed composed stylesheet pose');
          control.cancel();
          if (element.getAnimations().length !== 0) throw new Error('Pre-read pose control retained animation');
          return { transform: text, before: { x: before.e, y: before.f, b: before.b },
            after: { x: after.e, y: after.f, b: after.b }, valid: true };
        } finally { control?.cancel(); element.remove(); sheet.remove(); }
      });
      writeFileSync(path.join(output, 'pre-read-pose-control.json'), JSON.stringify(evidence, null, 2));
    } finally { await context.close(); }
  }
  for (let round = 0; round < rounds; round++) {
    for (const count of counts) for (const observation of orders[round]) {
      const [id, condition] = diagnostic ? observation.split(':') : [observation];
      const profiled = condition === 'profiled';
      const profileFile = `${round}-${id}.cpuprofile`;
      let context, cdp, stage = 'context-acquire';
      let profiling = false, coverage, accepted = 0, completed = 0;
      let batchEvidence = { startAttempts: 0, acquiredCalls: 0, cancelReturnedCalls: 0, removedTargets: 0 };
      const errors = [];
      const recordFailure = (error, failureStage) => {
        errors.push(error);
        appendFileSync(path.join(output, 'failures.jsonl'), JSON.stringify({
          round, count, id, stage: failureStage, ...(diagnostic ? s2Warm ? { condition, offeredCalls: 40, offeredTargets: 4000, naturalCompletedCalls: null,
            startAttempts: batchEvidence.startAttempts, acquiredCalls: batchEvidence.acquiredCalls,
            cancelReturnedCalls: batchEvidence.cancelReturnedCalls, removedTargets: batchEvidence.removedTargets, coverage }
            : { condition, offered: count, accepted, completed, coverage } : {}), error: String(error?.stack ?? error),
        }) + '\n');
      };
      const stopProfile = async () => {
        const { profile } = await cdp.send('Profiler.stop');
        profiling = false;
        writeFileSync(path.join(output, profileFile), JSON.stringify(profile));
        const nodes = new Map(profile.nodes.map(node => [node.id, node]));
        const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
        const startupSamples = (profile.samples ?? []).filter(nodeId => {
          let adapter = false;
          for (let node = nodes.get(nodeId); node; node = nodes.get(parents.get(node.id))) {
            if (node.callFrame.functionName === 'startupDiagnosticStart') return adapter;
            adapter ||= node.callFrame.url === `motion-startup-${id}.js`;
          }
          return false;
        });
        const phaseSamples = s2Warm ? Object.fromEntries(['startupDiagnosticStart', 'startupDiagnosticCancel', 'startupDiagnosticCleanup', 'startupDiagnosticDrain'].map(phase => {
          const attributed = adapterRequired => (profile.samples ?? []).filter(nodeId => {
            let adapter = false;
            for (let node = nodes.get(nodeId); node; node = nodes.get(parents.get(node.id))) {
              if (node.callFrame.functionName === phase && node.callFrame.url === 'motion-s2-wrapper.js') return !adapterRequired || adapter;
              adapter ||= node.callFrame.url === `motion-startup-${id}.js`;
            }
            return false;
          }).length;
          const wrapperPresent = profile.nodes.some(node => node.callFrame.functionName === phase && node.callFrame.url === 'motion-s2-wrapper.js');
          return [phase, { inclusiveSamples: attributed(false), adapterSamples: attributed(true),
            status: wrapperPresent && attributed(false) > 0 ? 'sampled-wrapper' : 'unsupported-missing-wrapper-samples' }];
        })) : undefined;
        return { profileFile, samples: profile.samples?.length ?? 0, startupSamples: startupSamples.length,
          ...(s2Warm ? { phaseSamples, phaseCpuStatus: 'unsupported-exact-phase-cpu', attributionStatus: Object.values(phaseSamples).every(row => row.status === 'sampled-wrapper') ? 'sampled-all-phases' : 'inconclusive-missing-phase-samples' } : {}),
          status: startupSamples.length ? 'sampled-startup' : 'inconclusive-no-startup-samples' };
      };
      try {
        const { page } = await pageFor(id, acquired => { context = acquired; stage = 'page-setup'; });
        stage = 'cdp-session';
        cdp = await context.newCDPSession(page);
        stage = 'measurement';
        if (!s2Warm) await page.evaluate(count => {
          window.__targets = Array.from({ length: count }, (_, i) => {
            const el = document.createElement('div'); el.className = 'box';
            el.style.left = `${i % 50 * 12}px`; el.style.top = `${Math.floor(i / 50) * 12}px`;
            document.body.appendChild(el); return el;
          });
          document.body.getBoundingClientRect();
        }, count);
        await settle(page);
        await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
        const before = await metrics(cdp);
        if (profiled) {
          stage = 'profiler-enable';
          await cdp.send('Profiler.enable');
          stage = 'profiler-start';
          profiling = true; // Запуск мог состояться, даже если получение ответа завершилось отказом.
          await cdp.send('Profiler.start');
        }
        if (s2Warm) {
          stage = 's2-warm-batch';
          batchEvidence = { startAttempts: null, acquiredCalls: null, cancelReturnedCalls: null, removedTargets: null };
          const batchCall = async function s2WarmDiagnosticBatch(config) {
            const rows = [], errors = [];
            let documentEffects = 0;
            let acquiredCalls = 0, cancelReturnedCalls = 0, removedTargets = 0, startAttempts = 0;
            function startupDiagnosticStart(groups, controls, calls) {
              const began = performance.now();
              for (const elements of groups) {
                const callBegan = config.preReadProbe ? performance.now() : null;
                let preReadElapsedMs = null, transform = null;
                if (config.preReadProbe && config.preRead) {
                  const readBegan = performance.now();
                  transform = getComputedStyle(elements[0]).getPropertyValue('transform');
                  preReadElapsedMs = performance.now() - readBegan;
                }
                const startBegan = config.preReadProbe ? performance.now() : null;
                startAttempts++;
                controls.push(window.__adapterModule.start(elements, config.toPx, config.durationMs));
                acquiredCalls++;
                if (config.preReadProbe) {
                  const ended = performance.now();
                  calls.push({ call: calls.length, preReadElapsedMs, transform,
                    startElapsedMs: ended - startBegan, combinedElapsedMs: ended - callBegan });
                }
              }
              return performance.now() - began;
            }
            function startupDiagnosticCancel(controls) {
              for (const control of controls) {
                try { control.cancel(); cancelReturnedCalls++; }
                catch (error) { errors.push({ phase: 'cancel', error: String(error?.stack ?? error) }); }
              }
            }
            function startupDiagnosticCleanup(groups) {
              for (const elements of groups) for (const element of elements) { element.remove(); removedTargets++; }
            }
            for (let index = -1; index < config.warmSamples; index++) {
              const wholeBegan = config.preReadProbe ? performance.now() : null;
              const groups = Array.from({ length: config.warmCalls }, () => Array.from({ length: config.targetsPerCall }, () => {
                const element = document.createElement('div'); element.className = 'box'; document.body.appendChild(element); return element;
              }));
              const controls = [], calls = [];
              let batchElapsedMs;
              try { batchElapsedMs = startupDiagnosticStart(groups, controls, calls); }
              catch (error) { errors.push({ phase: 'start', error: String(error?.stack ?? error) }); }
              finally { startupDiagnosticCancel(controls); startupDiagnosticCleanup(groups); }
              await Promise.resolve();
              await new Promise(resolve => requestAnimationFrame(function startupDiagnosticDrain() { resolve(); }));
              documentEffects = document.getAnimations().length;
              rows.push({ warmup: index === -1, batchElapsedMs, connectedDocumentEffects: documentEffects,
                ...(config.preReadProbe ? { calls, wholeElapsedMs: performance.now() - wholeBegan } : {}) });
              if (errors.length) break;
            }
            return { rows, startAttempts, acquiredCalls, cancelReturnedCalls, removedTargets, connectedDocumentEffects: documentEffects, errors };
          };
          const batch = await page.evaluate(`(${batchCall.toString()})(${JSON.stringify({ ...START_SCENARIO_MANIFEST.s2, preReadProbe, preRead: condition === 'pre-read' })})\n//# sourceURL=motion-s2-wrapper.js`);
          batchEvidence = { startAttempts: batch.startAttempts, acquiredCalls: batch.acquiredCalls,
            cancelReturnedCalls: batch.cancelReturnedCalls, removedTargets: batch.removedTargets };
          stage = 's2-after-metrics';
          const after = await metrics(cdp);
          if (profiled) { stage = 'profiler-stop'; coverage = await stopProfile(); }
          const effects = batch.connectedDocumentEffects;
          const batches = START_SCENARIO_MANIFEST.s2.warmSamples + 1;
          const offeredCalls = batches * START_SCENARIO_MANIFEST.s2.warmCalls;
          const delta = key => 1000 * (after[key] - before[key]);
          const row = { round, count, id, condition, coverage, scenario: startupScenario, ...batch,
            offeredCalls, offeredTargets: offeredCalls * count, warmupCalls: START_SCENARIO_MANIFEST.s2.warmCalls,
            measuredCalls: START_SCENARIO_MANIFEST.s2.warmSamples * START_SCENARIO_MANIFEST.s2.warmCalls,
            naturalCompletedCalls: null, completionStatus: 'not-observed-immediate-cancel', effects,
            cancelEvidence: 'adapter cancel returned; adapters may swallow underlying errors; not confirmed cancellation',
            cleanupEvidence: 'connected-document effects after remove only; retained detached effects and memory unverified',
            taskCpuMs: delta('TaskDuration'), threadCpuMs: delta('ThreadTime'), scriptCpuMs: delta('ScriptDuration'),
            styleCpuMs: delta('RecalcStyleDuration'), layoutCpuMs: delta('LayoutDuration'), raw: { before, after },
            phaseCpuMs: { start: null, cancel: null, cleanup: null } };
          row.valid = !batch.errors.length && batch.rows.length === batches && batch.startAttempts === offeredCalls && batch.acquiredCalls === offeredCalls &&
            batch.cancelReturnedCalls === offeredCalls && batch.removedTargets === offeredCalls * count && effects === 0 &&
            batch.rows.every(sample => sample.connectedDocumentEffects === 0 && Number.isFinite(sample.batchElapsedMs) && sample.batchElapsedMs >= 0) &&
            ['taskCpuMs', 'threadCpuMs', 'scriptCpuMs', 'styleCpuMs', 'layoutCpuMs'].every(key => Number.isFinite(row[key]) && row[key] >= 0);
          if (preReadProbe) row.valid = row.valid && batch.rows.every(sample =>
            Number.isFinite(sample.wholeElapsedMs) && sample.wholeElapsedMs >= sample.batchElapsedMs &&
            sample.calls.length === START_SCENARIO_MANIFEST.s2.warmCalls && sample.calls.every((call, i) =>
              call.call === i && Number.isFinite(call.startElapsedMs) && call.startElapsedMs >= 0 &&
              Number.isFinite(call.combinedElapsedMs) && call.combinedElapsedMs >= call.startElapsedMs &&
              (condition === 'pre-read' ? typeof call.transform === 'string' &&
                Number.isFinite(call.preReadElapsedMs) && call.preReadElapsedMs >= 0 &&
                call.combinedElapsedMs >= call.preReadElapsedMs : call.transform === null && call.preReadElapsedMs === null)));
          samples.push(row); appendFileSync(path.join(output, 'samples.jsonl'), JSON.stringify(row) + '\n');
          if (!row.valid) {
            stage = 's2-lifecycle-validation';
            throw new Error(`Invalid S2 lifecycle: ${JSON.stringify(row)}`);
          }
        } else {
        stage = 'start';
        const startCall = diagnostic ? function startupDiagnosticStart(duration) {
          const start = performance.now();
          window.__control = window.__adapterModule.start(window.__targets, 300, duration);
          return { apiMs: performance.now() - start, start };
        } : duration => {
          const start = performance.now();
          window.__control = window.__adapterModule.start(window.__targets, 300, duration);
          return { apiMs: performance.now() - start, start };
        };
        // Approved b7bda counter delta: dispatch without a response is unknown, not zero work.
        if (diagnostic) { accepted = null; completed = null; }
        const started = await page.evaluate(startCall, durationMs);
        accepted = count;
        if (profiled) { stage = 'profiler-stop'; coverage = await stopProfile(); }
        stage = 'completion';
        const completionMs = await page.evaluate(async ({ start, watchdogMs }) => {
          let watchdog;
          try {
            const finished = window.__control.finished();
            if (typeof finished?.then !== 'function') throw new Error('Adapter completion is not awaitable');
            await Promise.race([finished, new Promise((_, reject) => {
              watchdog = setTimeout(() => reject(new Error('Completion watchdog expired')), watchdogMs);
            })]);
            return performance.now() - start;
          } finally { clearTimeout(watchdog); }
        }, { start: started.start, watchdogMs });
        completed = count;
        stage = 'validation-cleanup';
        await settle(page);
        const afterAnimation = await metrics(cdp);
        const endpoint = await page.evaluate(() => {
          const positions = window.__targets.map(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).e);
          return { count: positions.length, maxError: Math.max(...positions.map(x => Math.abs(x - 300))), finite: positions.every(Number.isFinite) };
        });
        const beforeCleanup = await metrics(cdp);
        await page.evaluate(() => { window.__control.cancel(); for (const el of window.__targets) el.remove(); window.__control = undefined; window.__targets = undefined; });
        await settle(page);
        const afterCleanup = await metrics(cdp);
        const effects = await page.evaluate(() => document.getAnimations().length);
        const delta = key => 1000 * ((afterAnimation[key] - before[key]) + (afterCleanup[key] - beforeCleanup[key]));
        const sample = { round, count, id, apiMs: started.apiMs, completionMs, taskCpuMs: delta('TaskDuration'), threadCpuMs: delta('ThreadTime'), scriptCpuMs: delta('ScriptDuration'), styleCpuMs: delta('RecalcStyleDuration'), layoutCpuMs: delta('LayoutDuration'), endpoint, effects, raw: { before, afterAnimation, beforeCleanup, afterCleanup } };
        if (diagnostic) Object.assign(sample, { condition, coverage, offered: count, accepted, completed });
        sample.valid = endpoint.count === count && endpoint.finite && endpoint.maxError <= 0.05 && effects === 0 && ['apiMs', 'completionMs', 'taskCpuMs', 'threadCpuMs', 'scriptCpuMs', 'styleCpuMs', 'layoutCpuMs'].every(k => Number.isFinite(sample[k]) && sample[k] >= 0);
        samples.push(sample); appendFileSync(path.join(output, 'samples.jsonl'), JSON.stringify(sample) + '\n');
        if (!sample.valid) throw new Error(`Invalid sample ${round}/${count}/${id}: ${JSON.stringify({ endpoint, effects })}`);
        }
      } catch (error) {
        recordFailure(error, stage);
        if (profiling) {
          try { coverage = await stopProfile(); }
          catch (profileError) {
            coverage = { profileFile, status: 'unrecoverable-profiler-stop' };
            recordFailure(profileError, 'profiler-stop-after-failure');
          }
        }
      } finally {
        if (context) {
          try { await context.close(); }
          catch (closeError) { recordFailure(closeError, 'context-close'); }
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Отказ наблюдения и очистки', { cause: errors[0] });
    }
    console.log(`ROUND ${round + 1}/${rounds}`);
  }
  for (const [id, adapter] of Object.entries(adapters)) if (hash(readFileSync(adapter.path)) !== adapter.sha256) throw new Error(`Adapter changed: ${id}`);
  for (const [id, directory] of Object.entries(measuredRoots)) {
    if (hashFileTree(path.join(directory, 'dist')).sha256 !== sourceIdentity[id].dist.sha256)
      throw new Error(`Measured dist changed: ${id}`);
  }
  if (preReadProbe && hash(readFileSync(path.join(rootPath, 'src/motion/runtime.ts'))) !== metadata.preReadProbe.runtimeSha256)
    throw new Error('Production runtime source changed during pre-read probe');
  if (diagnostic) {
    const result = s2Warm ? { interpretation: metadata.diagnostic.interpretation, scenario: startupScenario,
      observations: samples.length, offeredCalls: samples.reduce((sum, row) => sum + row.offeredCalls, 0),
      acquiredCalls: samples.reduce((sum, row) => sum + row.acquiredCalls, 0), cancelReturnedCalls: samples.reduce((sum, row) => sum + row.cancelReturnedCalls, 0),
      offeredTargets: samples.reduce((sum, row) => sum + row.offeredTargets, 0), removedTargets: samples.reduce((sum, row) => sum + row.removedTargets, 0),
      warmupCalls: samples.reduce((sum, row) => sum + row.warmupCalls, 0), measuredCalls: samples.reduce((sum, row) => sum + row.measuredCalls, 0),
      naturalCompletedCalls: null, phaseCpuMs: metadata.phaseCpuMs,
      coverage: samples.filter(row => row.condition === 'profiled').map(({ round, id, coverage }) => ({ round, id, ...coverage })) }
      : { interpretation: metadata.diagnostic.interpretation, offeredStarts: metadata.diagnostic.offeredStarts, completedStarts: samples.filter(row => row.valid).length, offeredTargets: samples.reduce((sum, row) => sum + row.offered, 0), completedTargets: samples.reduce((sum, row) => sum + row.completed, 0), coverage: samples.filter(row => row.condition === 'profiled').map(({ round, id, coverage }) => ({ round, id, ...coverage })) };
    writeFileSync(path.join(output, 'diagnostic.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else {
  const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const summary = counts.flatMap(count => ids.map(id => {
    const rows = samples.filter(s => s.count === count && s.id === id);
    return { count, id, n: rows.length, taskP50: quantile(rows.map(s => s.taskCpuMs), .5), taskP95: quantile(rows.map(s => s.taskCpuMs), .95), threadP50: quantile(rows.map(s => s.threadCpuMs), .5), apiP50: quantile(rows.map(s => s.apiMs), .5), completionP50: quantile(rows.map(s => s.completionMs), .5), styleP50: quantile(rows.map(s => s.styleCpuMs), .5), layoutP50: quantile(rows.map(s => s.layoutCpuMs), .5), scriptP50: quantile(rows.map(s => s.scriptCpuMs), .5) };
  }));
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  }
} catch (error) {
  runError = error;
} finally {
  const errors = runError ? [runError] : [];
  for (const [stage, close] of [['browser-close', () => browser.close()], ['origin-close', () => origin.close()]]) {
    try { await close(); }
    catch (error) {
      errors.push(error);
      appendFileSync(path.join(output, 'failures.jsonl'), JSON.stringify({ stage, error: String(error?.stack ?? error) }) + '\n');
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Отказ запуска и очистки', { cause: errors[0] });
}
