// Disposable real-browser exporter probe. No product imports or presentation join.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '149.0.7827.55';
export const CONFIG = Object.freeze({
  categories: 'cc,benchmark,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.timeline,blink.console,devtools.timeline',
  transferMode: 'ReportEvents',
});
const FLAGS = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const errorData = error => ({ name: error.name, message: error.message });

export async function bounded(action, label, ms = 10000, timers = globalThis) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => reject(new Error(`${label} deadline`)), ms);
  });
  try { return await Promise.race([Promise.resolve().then(action), deadline]); }
  finally { timers.clearTimeout(timer); }
}

// Subscribers exist before start/end; onChange persists partial state at each boundary.
export function traceObserver(cdp, onChange, timers = globalThis) {
  const state = { status: 'incomplete', fragments: [], commands: [], errors: [], completion: null };
  let resolveComplete;
  const completed = new Promise(resolve => { resolveComplete = resolve; });
  const collect = value => { state.fragments.push(value); onChange(state); };
  const finish = value => { state.completion = value; onChange(state); resolveComplete(value); };
  cdp.on('Tracing.dataCollected', collect);
  cdp.on('Tracing.tracingComplete', finish);
  const command = async (method, params = {}) => {
    const record = { method, params, status: 'pending' };
    state.commands.push(record); onChange(state);
    try {
      const value = await bounded(() => cdp.send(method, params), method, 10000, timers);
      record.status = 'complete'; return value;
    } catch (error) {
      record.status = 'failed'; record.error = errorData(error);
      state.errors.push({ phase: method, ...errorData(error) }); throw error;
    } finally { onChange(state); }
  };
  return {
    state,
    start: () => command('Tracing.start', CONFIG),
    async stop() {
      // End-command and completion deadlines are subscribed before end is sent.
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = timers.setTimeout(() => reject(new Error('Tracing.tracingComplete deadline')), 10000);
      });
      const completion = Promise.race([completed, deadline]);
      completion.catch(() => {}); // Await/rethrow below observes the rejection.
      try {
        await Promise.race([command('Tracing.end'), deadline]);
        await completion;
        state.status = state.completion.dataLossOccurred === false ? 'complete' : 'incomplete';
      } catch (error) {
        state.errors.push({ phase: 'trace-stop', ...errorData(error) }); throw error;
      } finally { timers.clearTimeout(timer); onChange(state); }
    },
    detach() {
      cdp.off('Tracing.dataCollected', collect); cdp.off('Tracing.tracingComplete', finish);
    },
  };
}

export function inventory(events) {
  const fields = {}, unsafeNumbers = [];
  const walk = (value, key, eventIndex) => {
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const entry = fields[key] ??= {};
    entry[type] = (entry[type] ?? 0) + 1;
    if (typeof value === 'number' && (!Number.isFinite(value)
      || Number.isInteger(value) && !Number.isSafeInteger(value))) unsafeNumbers.push({ eventIndex, path: key });
    if (value && typeof value === 'object') for (const [name, child] of Object.entries(value))
      walk(child, Array.isArray(value) ? `${key}[]` : `${key}.${name}`, eventIndex);
  };
  events.forEach((event, index) => walk(event, '$', index));
  return { fields, unsafeNumbers, numericIdentityAccepted: unsafeNumbers.length === 0,
    losslessUint64Export: 'unproved', rawWireBytesRetained: false };
}

// Machine-property controls only. These do not parse async ownership or join frames.
export function recordProperties(events) {
  const reporters = events.filter(event => event.name === 'PipelineReporter');
  const feedback = events.filter(event => event.name === 'SwapEndToPresentationCompositorFrame');
  const seen = new Set(); let duplicates = 0;
  for (const event of [...reporters, ...feedback]) {
    const serialized = JSON.stringify(event);
    if (seen.has(serialized)) duplicates++;
    seen.add(serialized);
  }
  return { reporters: reporters.length, feedback: feedback.length, duplicates,
    reportersWithArgs: reporters.filter(event => event.args && Object.keys(event.args).length > 0).length,
    numericIdentityAccepted: inventory([...reporters, ...feedback]).numericIdentityAccepted,
    timingShapes: feedback.map(event => ({ phase: event.ph ?? null,
      finiteTimestamp: Number.isFinite(event.ts),
      finiteDuration: Number.isFinite(event.dur) && event.dur > 0 })),
    presentationProof: 'unresolved', ownership: 'unresolved' };
}

export function mutationControls(events) {
  const reporter = events.find(event => event.name === 'PipelineReporter');
  const feedback = events.find(event => event.name === 'SwapEndToPresentationCompositorFrame');
  if (!reporter || !feedback) return { status: 'unavailable', reason: 'native-producer-or-feedback-not-observed' };
  return { status: 'offline-machine-controls-only',
    missingReporterArgs: recordProperties(events.map(event => event.name === 'PipelineReporter' ? { ...event, args: {} } : event)),
    missingFeedbackTiming: recordProperties(events.map(event => {
      if (event.name !== 'SwapEndToPresentationCompositorFrame') return event;
      const { ts, dur, ...withoutTiming } = event;
      return withoutTiming;
    })),
    missingReporter: recordProperties(events.filter(event => event.name !== 'PipelineReporter')),
    missingFeedback: recordProperties(events.filter(event => event.name !== 'SwapEndToPresentationCompositorFrame')),
    duplicate: recordProperties([...events, reporter, feedback]),
    unsafeNumeric: recordProperties([{ ...reporter, id: Number.MAX_SAFE_INTEGER + 1 }]),
    crossOwner: { status: 'unavailable', reason: 'no-proven-A-B-export-owner-discriminator' } };
}

// Native occurrence association only: no page owner, bitmap or presentation proof.
export function nativeIntervals(events) {
  const reporterName = 'PipelineReporter', feedbackName = 'SwapEndToPresentationCompositorFrame';
  const category = 'cc,benchmark,disabled-by-default-devtools.timeline.frame';
  const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
  const safeTime = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  const issues = [], tracks = new Map(), tuples = new Set(), occurrences = [], seen = new Set();
  const fail = (code, index) => issues.push({ code, index });
  const keyFor = event => JSON.stringify([event.cat, event.pid, event.id2?.local, event.scope ?? '']);
  // Discover scopes from native names, then validate every event on those local tracks before projection.
  const localTracks = new Set();
  events.forEach((event, index) => {
    if (![reporterName, feedbackName].includes(event.name)) return;
    if (!safeInteger(event.pid) || typeof event.id2?.local !== 'string') fail('invalid-native-scope', index);
    else localTracks.add(JSON.stringify([event.pid, event.id2.local]));
  });
  events.forEach((event, index) => {
    if (!localTracks.has(JSON.stringify([event.pid, event.id2?.local]))) return;
    if (event.cat !== category || typeof event.name !== 'string' || !['b', 'e'].includes(event.ph)
      || !safeInteger(event.pid) || !safeInteger(event.tid) || !safeTime(event.ts)
      || !/^0x[0-9a-f]+$/i.test(event.id2?.local) || Object.keys(event.id2).length !== 1
      || event.id !== undefined || event.scope !== undefined && typeof event.scope !== 'string') {
      fail('invalid-consumed-field', index); return;
    }
    const key = keyFor(event);
    const track = tracks.get(key) ?? { entries: [], lastTimestamp: -1 };
    if (event.ts < track.lastTimestamp) fail('reversed-track-time', index);
    track.lastTimestamp = event.ts;
    const signature = JSON.stringify([key, event.name, event.ph, event.ts]);
    if (seen.has(signature)) fail('duplicate-track-event', index);
    seen.add(signature);
    track.entries.push({ event, index }); tracks.set(key, track);
  });
  for (const [key, track] of tracks) {
    const stack = []; let reporter = null;
    // Retained stream order is authoritative, including equal timestamp ends. Never force name order.
    for (const entry of track.entries) {
      const { event, index } = entry;
      if (event.ph === 'b') {
        if (event.name === reporterName) {
          if (reporter || stack.length) fail('overlapping-reporter', index);
          const fields = event.args?.frame_reporter;
          const tuple = [event.pid, fields?.frame_source, fields?.frame_sequence, fields?.layer_tree_host_id];
          if (!tuple.every(safeInteger) || typeof fields?.has_missing_content !== 'boolean'
            || !['STATE_PRESENTED_ALL', 'STATE_PRESENTED_PARTIAL', 'STATE_NO_UPDATE_DESIRED', 'STATE_DROPPED'].includes(fields?.state))
            fail('invalid-reporter-fields', index);
          const tupleKey = JSON.stringify(tuple);
          if (tuples.has(tupleKey)) fail('colliding-reporter-tuple', index);
          tuples.add(tupleKey);
          reporter = { track: key, beginIndex: index, beginTimestamp: event.ts, tuple,
            state: fields?.state, hasMissingContent: fields?.has_missing_content, feedback: [] };
        } else if (!reporter) fail('orphan-track-begin', index);
        if (event.name === feedbackName) {
          if (!reporter || stack.at(-1)?.event.name !== 'SubmitCompositorFrameToPresentationCompositorFrame')
            fail('wrong-feedback-parent', index);
          if (reporter?.feedback.length || stack.some(item => item.event.name === feedbackName))
            fail('duplicate-feedback', index);
        }
        stack.push(entry);
      } else {
        const begin = stack.at(-1);
        if (!begin || begin.event.name !== event.name) { fail('wrong-top-end', index); continue; }
        stack.pop();
        if (event.name === feedbackName && reporter) {
          if (event.ts <= begin.event.ts) fail('nonpositive-feedback-duration', index);
          reporter.feedback.push({ beginIndex: begin.index, endIndex: index,
            beginTimestamp: begin.event.ts, endTimestamp: event.ts });
        }
        if (event.name === reporterName && reporter) {
          if (stack.length) fail('wrong-reporter-parent', index);
          const eligible = reporter.state === 'STATE_PRESENTED_ALL' && reporter.hasMissingContent === false;
          if (eligible && reporter.feedback.length !== 1) fail('missing-eligible-feedback', index);
          if (reporter.state === 'STATE_NO_UPDATE_DESIRED' && reporter.feedback.length) fail('unexpected-no-update-feedback', index);
          occurrences.push({ ...reporter, endIndex: index, endTimestamp: event.ts, eligible }); reporter = null;
        }
      }
    }
    if (stack.length || reporter) fail('open-track', track.entries.at(-1).index);
  }
  return { status: issues.length ? 'rejected' : 'accepted', consumedIdentityAccepted: issues.length === 0,
    issues, occurrences, associations: issues.length ? [] : occurrences.filter(item => item.eligible),
    presentationProof: 'unresolved', ownership: 'unresolved', nativeUUID: 'unproved' };
}

// Shared by real runProbe finalization and CLI. Boundary completion is not presentation proof.
export function finalizeBoundary(report) {
  const events = report.trace?.fragments.flatMap(fragment => fragment.value ?? []) ?? [];
  report.transportStatus = report.trace?.status ?? 'incomplete';
  report.markers = Object.fromEntries(['A:start', 'A:end', 'B:start', 'B:end'].map(label => [label,
    events.filter(event => event.name === 'TimeStamp' && event.args?.data?.message === `${report.metadata.markerToken}:${label}`)]));
  report.nativeIntervals = nativeIntervals(events);
  if (report.transportStatus !== 'complete' || report.trace.completion?.dataLossOccurred !== false || report.errors.length) {
    report.nativeIntervals.status = 'rejected';
    report.nativeIntervals.consumedIdentityAccepted = false;
    report.nativeIntervals.associations = [];
    report.nativeIntervals.issues.push({ code: 'incomplete-native-transport', index: null });
  }
  const markerIdentityAccepted = Object.values(report.markers).flat().every(event =>
    Number.isSafeInteger(event.pid) && event.pid >= 0 && Number.isSafeInteger(event.tid) && event.tid >= 0
    && Number.isFinite(event.ts) && event.ts >= 0 && event.ts <= Number.MAX_SAFE_INTEGER);
  report.controls = {
    markerPairsObserved: typeof report.metadata.markerToken === 'string'
      && Object.values(report.markers).every(values => values.length === 1),
    animationsFinished: report.pages.length === 2 && ['A', 'B'].every(label =>
      report.pages.filter(page => page.label === label && page.status === 'complete' && page.playState === 'finished').length === 1),
    numericIdentityAccepted: report.nativeIntervals.consumedIdentityAccepted && markerIdentityAccepted,
    payloadNumericIdentityAccepted: inventory(events).numericIdentityAccepted,
    payloadFidelity: 'unsupported-parsed-CDP-values',
    producer: report.properties.reporters && report.properties.feedback ? 'records-observed-timing-and-ownership-unresolved' : 'unresolved',
    unrelatedNativeOwner: 'unresolved-no-A-B-owner-discriminator-established',
    missingNativeRecordsProveTypedOmission: false, rawFragments: 'parsed-CDP-values-not-original-wire-bytes',
  };
  report.status = report.transportStatus === 'complete' && report.trace.completion?.dataLossOccurred === false
    && report.errors.length === 0 && report.controls.markerPairsObserved
    && report.controls.animationsFinished && report.controls.numericIdentityAccepted ? 'complete' : 'incomplete';
  return report.status === 'complete' ? 0 : 1;
}

const HTML = '<!doctype html><meta charset="utf-8"><style>body{margin:0}div{width:48px;height:48px;background:#246;will-change:transform}</style><div></div>';
async function animatePage(page, label, token) {
  await bounded(() => page.bringToFront(), `${label} foreground`);
  return bounded(() => page.evaluate(async ({ label, token }) => {
    const animation = document.querySelector('div').animate(
      [{ transform: 'translateX(0px)' }, { transform: 'translateX(80px)' }],
      { duration: 600, easing: 'linear', fill: 'forwards' });
    animation.pause();
    const finished = animation.finished;
    console.timeStamp(`${token}:${label}:start`);
    animation.play();
    await finished;
    console.timeStamp(`${token}:${label}:end`);
    return { label, playState: animation.playState, visibility: document.visibilityState };
  }, { label, token }), `${label} Animation.finished`);
}

export async function runProbe(output) {
  if (!path.isAbsolute(output)) throw new Error('Output directory must be absolute');
  mkdirSync(output, { recursive: true });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const report = { presentationProof: 'unresolved', qualification: false, conformance: false,
    status: 'incomplete', errors: [], pages: [], metadata: { config: CONFIG, launchArgs: FLAGS,
      platform: { type: os.type(), release: os.release(), arch: os.arch(), node: process.version,
        display: process.env.DISPLAY ?? null }, fixtureSha256: sha(HTML),
      source: { chromiumTag: VERSION, perfettoPin: '846203c4b3b25f834a0bebc101fa8e1b8f9d0ca9',
        readTraceAsJsonImplementation: 'unverified', genericPerfettoMappingProvesCDP: false } } };
  const save = () => writeFileSync(path.join(output, 'probe.json'), JSON.stringify(report, null, 2));
  let browser, cdp, observer, started = false, stopAttempted = false, fragmentCount = 0;
  save();
  try {
    report.metadata.checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    report.metadata.files = Object.fromEntries(['bench/compare/s5-cdp-boundary-probe.mjs',
      'bench/compare/s5-cdp-boundary-probe.test.mjs', 'bench/compare/package.json',
      'bench/compare/pnpm-lock.yaml', '.github/workflows/cdp-boundary-probe.yml']
      .map(file => [file, sha(readFileSync(path.join(root, file)))]));
    save();
    const require = createRequire(import.meta.url);
    const packageFile = require.resolve('playwright/package.json');
    const pwVersion = JSON.parse(readFileSync(packageFile)).version;
    if (pwVersion !== '1.61.1') throw new Error(`Playwright mismatch: ${pwVersion}`);
    const { chromium } = require('playwright');
    const corePackage = createRequire(packageFile).resolve('playwright-core/package.json');
    const coreRoot = path.dirname(corePackage);
    const coreVersion = JSON.parse(readFileSync(corePackage)).version;
    if (coreVersion !== '1.61.1') throw new Error(`Playwright core mismatch: ${coreVersion}`);
    const registry = JSON.parse(readFileSync(path.join(coreRoot, 'browsers.json')));
    report.metadata.playwright = pwVersion;
    report.metadata.playwrightCore = coreVersion;
    report.metadata.browserRegistry = registry.browsers.filter(browser => browser.name === 'chromium');
    report.metadata.executable = { path: chromium.executablePath(), sha256: sha(readFileSync(chromium.executablePath())) };
    save();
    browser = await bounded(() => chromium.launch({ headless: false, args: FLAGS }), 'browser launch', 30000);
    report.metadata.browserVersion = browser.version(); save();
    if (browser.version() !== VERSION) throw new Error(`Chromium mismatch: ${browser.version()}`);
    cdp = await bounded(() => browser.newBrowserCDPSession(), 'browser CDP');
    const context = await bounded(() => browser.newContext({ viewport: { width: 240, height: 160 } }), 'context');
    const pages = [];
    for (const label of ['A', 'B']) {
      const page = await bounded(() => context.newPage(), `${label} page`);
      await bounded(() => page.goto(`data:text/html,${encodeURIComponent(HTML + `<title>boundary-${label}</title>`)}`), `${label} navigation`);
      pages.push(page);
    }
    report.metadata.api = {};
    for (const method of ['Browser.getVersion', 'Tracing.getCategories', 'Tracing.getTrackEventDescriptor']) {
      try {
        const value = await bounded(() => cdp.send(method), method);
        report.metadata.api[method] = { status: 'complete', value };
        if (method === 'Tracing.getTrackEventDescriptor' && typeof value.descriptor === 'string') {
          const bytes = Buffer.from(value.descriptor, 'base64');
          writeFileSync(path.join(output, 'track-event-descriptor.bin'), bytes);
          report.metadata.descriptor = { bytes: bytes.length, sha256: sha(bytes),
            extensionFileDescriptorSet: 'not-established', reflectionNaming: 'unproved' };
        }
      } catch (error) {
        report.metadata.api[method] = { status: 'failed', error: errorData(error) };
        report.errors.push({ phase: method, ...errorData(error) });
      }
      save();
    }
    observer = traceObserver(cdp, state => {
      while (fragmentCount < state.fragments.length) {
        appendFileSync(path.join(output, 'parsed-fragments.ndjson'), JSON.stringify(state.fragments[fragmentCount++]) + '\n');
      }
      report.trace = state; save();
    });
    await observer.start(); started = true;
    const token = `boundary-${report.metadata.checkout}`;
    report.metadata.markerToken = token;
    for (const [index, label] of ['A', 'B'].entries()) {
      const attempt = { label, status: 'pending' };
      report.pages.push(attempt); save();
      try { Object.assign(attempt, await animatePage(pages[index], label, token), { status: 'complete' }); }
      catch (error) { Object.assign(attempt, { status: 'failed', error: errorData(error) }); throw error; }
      finally { save(); }
    }
    stopAttempted = true;
    await observer.stop();
  } catch (error) {
    report.errors.push({ phase: 'probe', ...errorData(error) });
  } finally {
    if (started && !stopAttempted) {
      try { await observer.stop(); }
      catch (error) { report.errors.push({ phase: 'cleanup-trace', ...errorData(error) }); }
    }
    observer?.detach();
    const events = observer?.state.fragments.flatMap(fragment => fragment.value ?? []) ?? [];
    report.inventory = inventory(events);
    report.records = events.filter(event => ['PipelineReporter', 'SwapEndToPresentationCompositorFrame'].includes(event.name));
    report.properties = recordProperties(events);
    report.mutations = mutationControls(events);
    report.recordsFile = 'native-records.json';
    writeFileSync(path.join(output, report.recordsFile), JSON.stringify(report.records, null, 2));
    if (browser) {
      try { await bounded(() => browser.close(), 'browser close'); }
      catch (error) { report.errors.push({ phase: 'browser-close', ...errorData(error) }); }
    }
    finalizeBoundary(report);
    save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await runProbe(process.argv[2] ?? '');
    // A successful transport observation is not presentation/conformance qualification.
    process.exit(finalizeBoundary(report));
  } catch (error) { console.error(error); process.exit(1); }
}
