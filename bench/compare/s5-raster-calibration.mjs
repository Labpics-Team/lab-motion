// Disposable finite static raster experiment. No dynamic S5 qualification or fractional extractor.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBenchmarkOrigin, colorLeftEdge } from './bench.mjs';
import { bounded, VERSION } from './s5-cdp-boundary-probe.mjs';

const require = createRequire(import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const POSITIONS = Object.freeze([117, 117.125, 117.25, 117.375, 117.5, 117.875]);
export const VIEWPORT = Object.freeze({ width: 800, height: 200 });
const options = { format: 'png', everyNthFrame: 1, maxWidth: 800, maxHeight: 200 };
const errorData = error => ({ name: error.name, message: error.message });

export function admitStaticFrame(bytes, metadata, setup) {
  const issues = [];
  if (!POSITIONS.includes(setup.authoredX) || setup.deviceScaleFactor !== 1
    || setup.viewport?.width !== 800 || setup.viewport?.height !== 200
    || setup.domOwned !== true) issues.push('unsupported-setup');
  if (!Number.isFinite(metadata?.timestamp) || metadata.timestamp < 0
    || metadata.offsetTop !== 0 || metadata.pageScaleFactor !== 1
    || metadata.deviceWidth !== 800 || metadata.deviceHeight !== 200
    || metadata.scrollOffsetX !== 0 || metadata.scrollOffsetY !== 0) issues.push('unsupported-metadata');
  if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { status: 'rejected', issues: [...issues, 'not-png'], classifier: null };
  let image;
  try { image = require('pngjs').PNG.sync.read(bytes); }
  catch (error) { return { status: 'rejected', issues: [...issues, 'png-decode'], error: errorData(error), classifier: null }; }
  const format = { width: image.width, height: image.height, depth: image.depth, colorType: image.colorType };
  // pngjs returns RGBA byte data even for the retained 8-bit RGB input.
  if (image.width !== 800 || image.height !== 200 || image.depth !== 8 || ![2, 6].includes(image.colorType))
    issues.push('unsupported-png-format');
  if (!issues.length) {
    const left = Math.floor(setup.authoredX), right = Math.ceil(setup.authoredX + 30);
    const fractional = !Number.isInteger(setup.authoredX);
    let bad = false;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 800; x++) {
      const i = (y * 800 + x) * 4;
      const [r, g, b, a] = image.data.subarray(i, i + 4);
      const inside = y >= 20 && y < 50 && x >= left && x < right;
      const edge = fractional && inside && (x === left || x === right - 1);
      if (a !== 255 || r !== 255 || (inside ? edge ? g !== b || g === 255 : g !== 0 || b !== 0 : g !== 255 || b !== 255)) bad = true;
    }
    if (bad) issues.push('unexpected-scene-shape-or-color');
  }
  const classifier = colorLeftEdge(bytes, 0);
  return { status: issues.length ? 'rejected' : 'admitted', issues, format, classifier,
    authoredX: setup.authoredX, classifierMinusAuthored: classifier === null ? null : classifier - setup.authoredX,
    geometricEquality: classifier === setup.authoredX, subpixelInference: 'unsupported' };
}

// First delivery is retained before decoding; no selection of a later convenient frame.
export async function collectStaticFrame(cdp, setup, retain, timers = globalThis) {
  const state = { status: 'incomplete', frames: [], errors: [], admission: null };
  let resolveFirst, rejectFailure, deadline, attempted = false;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const acknowledgements = [];
  const fail = (phase, error) => {
    state.errors.push({ phase, ...errorData(error) }); rejectFailure(error);
    try { retain(state); } catch (retentionError) { state.errors.push({ phase: 'retention', ...errorData(retentionError) }); }
  };
  const onFrame = event => {
    const index = state.frames.length;
    try {
      state.frames.push(structuredClone(event)); retain(state);
      if (!Number.isSafeInteger(event.sessionId) || event.sessionId < 0 || typeof event.data !== 'string'
        || event.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.data))
        throw new Error('Invalid frame payload/session identity');
      // Delivery index identifies observations; sessionId is ACK routing and may repeat.
      if (index === 0) {
        const bytes = Buffer.from(event.data, 'base64');
        state.admission = admitStaticFrame(bytes, event.metadata, setup); retain(state);
        resolveFirst();
      }
    } catch (error) { fail('frame-consumer', error); }
    finally {
      try {
        acknowledgements.push(bounded(() => cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }), 'frame ACK', 10000, timers)
          .catch(error => { fail('frame-ack', error); }));
      } catch (error) { fail('frame-ack', error); }
    }
  };
  const onDetached = () => fail('cdp-detached', new Error('CDP detached'));
  cdp.on('Page.screencastFrame', onFrame);
  cdp.on('Disconnected', onDetached);
  deadline = timers.setTimeout(() => fail('first-frame', new Error('first frame deadline')), 10000);
  try {
    attempted = true;
    await Promise.race([bounded(() => cdp.send('Page.startScreencast', options), 'start screencast', 10000, timers), failure]);
    await Promise.race([first, failure]);
  } catch (error) { state.errors.push({ phase: 'collection', ...errorData(error) }); }
  finally {
    timers.clearTimeout(deadline);
    if (attempted) {
      try { await bounded(() => cdp.send('Page.stopScreencast'), 'stop screencast', 10000, timers); }
      catch (error) { state.errors.push({ phase: 'stop', ...errorData(error) }); }
    }
    cdp.off('Page.screencastFrame', onFrame); cdp.off('Disconnected', onDetached);
    await Promise.all(acknowledgements);
    state.status = state.errors.length || state.admission?.status !== 'admitted' ? 'incomplete' : 'complete';
    retain(state);
  }
  return state;
}

export async function runCalibration(output) {
  if (!path.isAbsolute(output)) throw new Error('Absolute output directory required');
  mkdirSync(output, { recursive: true });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const report = { status: 'incomplete', qualification: false, historicalS5Verdict: 'unchanged-fail',
    scope: 'six-authored-static-inputs-only', errors: [], cases: [], metadata: {} };
  const save = () => writeFileSync(path.join(output, 'calibration.json'), JSON.stringify(report, null, 2));
  let browser, origin;
  save();
  try {
    report.metadata.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    report.metadata.files = Object.fromEntries(['bench/compare/bench.mjs', 'bench/compare/s5-raster-calibration.mjs',
      'bench/compare/s5-raster-calibration.test.mjs', '.github/workflows/s5-raster-calibration.yml']
      .map(file => [file, sha(readFileSync(path.join(root, file)))]));
    if (require('playwright/package.json').version !== '1.61.1' || require('pngjs/package.json').version !== '7.0.0')
      throw new Error('Pinned dependency mismatch');
    const { chromium } = require('playwright');
    browser = await bounded(() => chromium.launch({ headless: false, args: ['--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'] }), 'launch', 30000);
    report.metadata.browserVersion = browser.version();
    report.metadata.executableSha256 = sha(readFileSync(chromium.executablePath()));
    if (browser.version() !== VERSION) throw new Error('Pinned Chromium mismatch');
    origin = await startBenchmarkOrigin();
    for (const authoredX of POSITIONS) {
      const entry = { authoredX, status: 'incomplete', errors: [] }; report.cases.push(entry); save();
      let context;
      try {
        context = await bounded(() => browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 }), 'context');
        const page = await bounded(() => context.newPage(), 'page');
        await bounded(() => page.goto(origin.url, { waitUntil: 'load' }), 'fixture load');
        await bounded(() => page.bringToFront(), 'foreground');
        entry.setup = await bounded(() => page.evaluate(x => {
          const probe = document.createElement('div'); probe.id = 'probe';
          probe.style.transform = `translateX(${x}px)`; document.body.appendChild(probe);
          const rect = probe.getBoundingClientRect(), style = getComputedStyle(probe);
          const domOwned = document.body.children.length === 1 && probe.getAnimations().length === 0
            && crossOriginIsolated && document.visibilityState === 'visible' && devicePixelRatio === 1
            && rect.x === x && rect.y === 20 && rect.width === 30 && rect.height === 30
            && style.backgroundColor === 'rgb(255, 0, 0)' && style.opacity === '1';
          return { authoredX: x, authoredTransform: probe.style.transform, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            domOwned, deviceScaleFactor: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
        }, authoredX), 'static fixture ready');
        const cdp = await bounded(() => context.newCDPSession(page), 'page CDP');
        entry.collection = await collectStaticFrame(cdp, entry.setup, state => {
          entry.collection = state;
          state.frames.forEach((frame, index) => writeFileSync(path.join(output, `${authoredX}-${index}.png`), Buffer.from(frame.data, 'base64')));
          save();
        });
        entry.status = entry.collection.status;
      } catch (error) { entry.errors.push(errorData(error)); }
      finally {
        if (context) try { await bounded(() => context.close(), 'context close'); }
        catch (error) { entry.errors.push(errorData(error)); }
        if (entry.errors.length) entry.status = 'incomplete'; save();
      }
    }
  } catch (error) { report.errors.push(errorData(error)); }
  finally {
    if (browser) try { await bounded(() => browser.close(), 'browser close'); } catch (error) { report.errors.push(errorData(error)); }
    if (origin) try { await bounded(() => origin.close(), 'origin close'); } catch (error) { report.errors.push(errorData(error)); }
    report.status = report.errors.length === 0 && report.cases.length === 6 && report.cases.every(entry => entry.status === 'complete')
      && report.cases[0].collection?.admission.classifier === 117 ? 'complete' : 'incomplete';
    save();
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCalibration(process.argv[2] ?? '').then(report => { process.exitCode = report.status === 'complete' ? 0 : 1; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
