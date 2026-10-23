import { readFileSync, writeFileSync, appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

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
const group = process.argv[4] ?? 'full';
if (!['full', 'native', 'spring-pair', 'js-pair'].includes(group)) throw new Error('Unknown capability group');
const paired = group.endsWith('-pair');
if (paired && !baselinePath) throw new Error('Paired runtime profile requires an immutable baseline');
const ids = paired ? ['lab'] : group === 'native'
  ? ['lab', 'lab-nano', 'motion-mini', 'waapi-ctl']
  : ['lab', 'motion', 'gsap', 'anime', 'waapi-ctl'];
if (baselinePath) ids.push('baseline');
const counts = [1, 100, 1000];
const rounds = Math.ceil(20 / ids.length) * ids.length, durationMs = 400, watchdogMs = 10_000;
const entries = { 'lab-nano': 'lab-nano', lab: 'lab', motion: 'motion', gsap: 'gsap', anime: 'anime', 'waapi-ctl': 'waapi-control', 'motion-mini': 'motion-mini', 'anime-waapi': 'anime-waapi' };
if (baselinePath) entries.baseline = 'lab';
const adapters = Object.fromEntries(Object.entries(entries).map(([id, entry]) => {
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
const orders = makeRoundRobinOrders(ids, rounds, 0x5A71);
const origin = await startBenchmarkOrigin();
const browser = await chromium.launch({ headless: false, args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const metadata = {
  schema: 1, generatedAt: new Date().toISOString(), revision: execFileSync('git', ['-C', rootPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  profileSha256: hash(readFileSync(new URL(import.meta.url))),
  versions: { lab: root.version, ...installed, chromium: browser.version(), node: process.version },
  environment: { cpu: os.cpus()[0].model, cpuMax: optionalFile('/sys/fs/cgroup/cpu.max'), memoryMax: optionalFile('/sys/fs/cgroup/memory.max') },
  scenario: { group, counts, rounds, durationMs: group === 'spring-pair' ? null : durationMs, watchdogMs, targetPx: 300, easing: group === 'spring-pair' ? 'default spring' : group === 'js-pair' ? 'p*p*(3-2*p), custom JS callback' : 'linear', viewport: { width: 1200, height: 600 }, page: 'fresh realm; modules loaded before measurement', timeDomain: 'threadTicks', intervals: 'actual completion plus two frames and cancel/remove/two-frame cleanup; DOM construction and geometry validation excluded' },
  adapters, orders, sourceIdentity,
};
writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
const samples = [];
const metrics = async c => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const settle = async page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function pageFor(id) {
  const context = await browser.newContext({ viewport: metadata.scenario.viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.goto(origin.url); await page.bringToFront();
  await page.addScriptTag({ path: adapters[id].path });
  return { context, page };
}
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
  for (const id of ids) {
    const { context, page } = await pageFor(id);
    try {
      if (!await page.evaluate(() => typeof window.__adapterModule.startStagger === 'function')) {
        writeFileSync(path.join(output, id + '-original-semantic.json'), JSON.stringify({ status: 'not-applicable', reason: 'adapter-has-no-stagger' }));
        continue;
      }
      const evidence = await runSemanticStartCheck(page, START_SCENARIO_MANIFEST.s2, 5);
      writeFileSync(path.join(output, `${id}-original-semantic.json`), JSON.stringify(evidence));
      console.log(`ORIGINAL_ORACLE ${id} ${evidence.valid}`);
    } finally { await context.close(); }
  }
  for (let round = 0; round < rounds; round++) {
    for (const count of counts) for (const id of orders[round]) {
      const { context, page } = await pageFor(id);
      const cdp = await context.newCDPSession(page);
      try {
        await page.evaluate(count => {
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
        const started = await page.evaluate(duration => {
          const start = performance.now();
          window.__control = window.__adapterModule.start(window.__targets, 300, duration);
          return { apiMs: performance.now() - start, start };
        }, durationMs);
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
        sample.valid = endpoint.count === count && endpoint.finite && endpoint.maxError <= 0.05 && effects === 0 && ['apiMs', 'completionMs', 'taskCpuMs', 'threadCpuMs', 'scriptCpuMs', 'styleCpuMs', 'layoutCpuMs'].every(k => Number.isFinite(sample[k]) && sample[k] >= 0);
        samples.push(sample); appendFileSync(path.join(output, 'samples.jsonl'), JSON.stringify(sample) + '\n');
        if (!sample.valid) throw new Error(`Invalid sample ${round}/${count}/${id}: ${JSON.stringify({ endpoint, effects })}`);
      } catch (error) {
        appendFileSync(path.join(output, 'failures.jsonl'), JSON.stringify({
          round, count, id, error: String(error?.stack ?? error),
        }) + '\n');
        throw error;
      } finally { await context.close(); }
    }
    console.log(`ROUND ${round + 1}/${rounds}`);
  }
  for (const [id, adapter] of Object.entries(adapters)) if (hash(readFileSync(adapter.path)) !== adapter.sha256) throw new Error(`Adapter changed: ${id}`);
  for (const [id, directory] of Object.entries(measuredRoots)) {
    if (hashFileTree(path.join(directory, 'dist')).sha256 !== sourceIdentity[id].dist.sha256)
      throw new Error(`Measured dist changed: ${id}`);
  }
  const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const summary = counts.flatMap(count => ids.map(id => {
    const rows = samples.filter(s => s.count === count && s.id === id);
    return { count, id, n: rows.length, taskP50: quantile(rows.map(s => s.taskCpuMs), .5), taskP95: quantile(rows.map(s => s.taskCpuMs), .95), threadP50: quantile(rows.map(s => s.threadCpuMs), .5), apiP50: quantile(rows.map(s => s.apiMs), .5), completionP50: quantile(rows.map(s => s.completionMs), .5), styleP50: quantile(rows.map(s => s.styleCpuMs), .5), layoutP50: quantile(rows.map(s => s.layoutCpuMs), .5), scriptP50: quantile(rows.map(s => s.scriptCpuMs), .5) };
  }));
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally { await browser.close(); await origin.close(); }
