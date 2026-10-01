// Один контроль каждой зарегистрированной сцены: реальные браузер и packed
// потребитель. Это не pilot, не серия API costs и не выбор N.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_PROFILE, serverProfileDigest } from '/workspace/lab-motion/bench/profile/server-profile-registration.mjs';
import { serverBrowserSemanticClockErrorMs } from '/workspace/lab-motion/bench/profile/server-profile-contract.mjs';
import { PRODUCTION_ADAPTER_PROFILE } from '/workspace/lab-motion/bench/compare/methodology.mjs';
import { runSemanticStartCheck, startBenchmarkOrigin } from '/workspace/lab-motion/bench/compare/bench.mjs';
import { hashFileTree, sha256File } from '/workspace/lab-motion/bench/compare/provenance.mjs';

const out = path.dirname(fileURLToPath(import.meta.url));
const root = '/workspace/lab-motion', BENCH = path.join(root, 'bench/compare');
const requireBench = createRequire(path.join(BENCH, 'package.json'));
const tarball = path.join(root, 'scratchpad/final-runtime-candidate/packed-upstream-30e73995/labpics-motion-0.3.0.tgz');
const browserExecutable = '/home/agent/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const source = readFileSync(path.join(root, 'bench/profile/server-profile-runner.mjs'), 'utf8');
const buildSource = source.slice(source.indexOf('function buildAdapter('), source.indexOf('function threadCpuNs('));
const buildAdapter = Function('BENCH', 'readFileSync', 'path', 'PRODUCTION_ADAPTER_PROFILE', 'sha256File', `${buildSource}\nreturn buildAdapter;`)(
  BENCH, readFileSync, path, PRODUCTION_ADAPTER_PROFILE, sha256File);
if (sha256File(tarball) !== '46c9067832760159d35ccd2166b28e6486a57602b1e96d6d23e1c4c06804a402' ||
    process.version !== SERVER_PROFILE.clockError.nodeVersion ||
    sha256File(process.execPath) !== SERVER_PROFILE.clockError.nodeExecutableSha256 ||
    sha256File(browserExecutable) !== SERVER_PROFILE.clockError.browserExecutableSha256) throw new Error('контроль отказал: tool/package identity изменились');
const adapter = buildAdapter('candidate', path.join(out, 'consumer'), requireBench('esbuild'), out);
const report = { protocolDigest: serverProfileDigest(SERVER_PROFILE), actualRegisteredPerformanceSamples: 0,
  scope: 'Один healthy normal-motion control S2/S3, actual costs/N/calibration не собираются.',
  source: ['bench/compare/bench.mjs', 'bench/compare/methodology.mjs', 'bench/profile/server-profile-contract.mjs',
    'bench/profile/server-profile-runner.mjs', 'bench/profile/server-profile-registration.mjs'].map((name) => ({ name, sha256: sha256File(path.join(root, name)) })),
  tarball: { path: tarball, sha256: sha256File(tarball) }, packageTree: hashFileTree(path.join(out, 'consumer/package')),
  node: { version: process.version, executable: process.execPath, sha256: sha256File(process.execPath) },
  browser: { executable: browserExecutable, sha256: sha256File(browserExecutable) }, adapter, buildFunctionSha256: sha256(buildSource), rows: [] };
let browser, origin;
try {
  origin = await startBenchmarkOrigin();
  browser = await requireBench('playwright').chromium.launch({ executablePath: browserExecutable, headless: true });
  report.browser.version = browser.version();
  if (report.browser.version !== SERVER_PROFILE.clockError.browserVersion) throw new Error('контроль отказал: browser version изменился');
  for (const scene of SERVER_PROFILE.browserScenes) {
    const row = { scene, actualRegisteredPerformanceSamples: 0 }; report.rows.push(row);
    const context = await browser.newContext({ viewport: SERVER_PROFILE.viewport, deviceScaleFactor: SERVER_PROFILE.deviceScaleFactor, reducedMotion: 'no-preference' });
    try {
      const page = await context.newPage(); await page.goto(origin.url);
      await page.evaluate(() => {
        const events = [], ids = new WeakMap(); let nextId = 0;
        const id = (element) => { if (!ids.has(element)) ids.set(element, nextId++); return ids.get(element); };
        const now = performance.now.bind(performance), frame = window.requestAnimationFrame.bind(window), style = window.getComputedStyle.bind(window);
        const native = Element.prototype.animate;
        window.__healthyObservation = { events };
        performance.now = () => { const value = now(); events.push({ kind: 'owner-clock', valueMs: value, documentTimeMs: document.timeline.currentTime }); return value; };
        window.requestAnimationFrame = (callback) => {
          events.push({ kind: 'raf-request', valueMs: now(), documentTimeMs: document.timeline.currentTime });
          return frame((timestamp) => { events.push({ kind: 'raf-callback', valueMs: now(), timestampMs: timestamp, documentTimeMs: document.timeline.currentTime }); callback(timestamp); });
        };
        window.getComputedStyle = (element, pseudo) => {
          const before = document.timeline.currentTime, result = style(element, pseudo);
          events.push({ kind: 'CSS', target: id(element), documentBeforeMs: before, documentAfterMs: document.timeline.currentTime });
          return result;
        };
        Element.prototype.animate = function (frames, options) {
          const before = now(), documentBeforeMs = document.timeline.currentTime;
          const animation = native.call(this, frames, options);
          events.push({ kind: 'native-start', target: id(this), beforeMs: before, afterMs: now(), documentBeforeMs,
            documentAfterMs: document.timeline.currentTime, frames, options, currentTime: animation.currentTime, playState: animation.playState });
          return animation;
        };
      });
      await page.addScriptTag({ path: adapter.path });
      row.realm = await page.evaluate(() => ({ crossOriginIsolated, timeOriginMs: performance.timeOrigin, documentTimeMs: document.timeline.currentTime,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, userAgent: navigator.userAgent }));
      if (!row.realm.crossOriginIsolated || row.realm.reducedMotion) throw new Error('контроль отказал: неверный normal-motion realm');
      row.monotonicHostUpperNs = process.hrtime.bigint().toString();
      const semanticClockErrorMs = serverBrowserSemanticClockErrorMs(row.monotonicHostUpperNs);
      row.config = { ...scene, ...SERVER_PROFILE.browserSemantics, durationMs: SERVER_PROFILE.durationMs, toPx: SERVER_PROFILE.toPx, semanticClockErrorMs };
      row.evidence = await runSemanticStartCheck(page, row.config, SERVER_PROFILE.browserSemanticCalls);
      row.observed = await page.evaluate(() => ({ ...window.__healthyObservation,
        remainingElements: document.querySelectorAll('.box').length, activeNative: document.getAnimations().length,
        documentTimeMs: document.timeline.currentTime, performanceNowMs: performance.now() }));
      row.accepted = row.evidence.valid === true;
    } catch (error) { row.accepted = false; row.error = { name: error.name, message: error.message, raw: error.raw ?? null }; }
    finally { await context.close(); }
    writeFileSync(path.join(out, 'semantic-only-result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'w' });
  }
} finally {
  if (browser) await browser.close();
  if (origin) await origin.close();
  writeFileSync(path.join(out, 'semantic-only-result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'w' });
}
if (report.rows.length !== SERVER_PROFILE.browserScenes.length || report.rows.some((row) => !row.accepted)) process.exitCode = 1;
