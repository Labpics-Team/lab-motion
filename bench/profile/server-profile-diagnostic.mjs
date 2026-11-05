// Intrusive, bounded baseline-only observation. Never qualification evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { measureServerBrowser, parseServerProfileArgs, runServerProfile, withServerProfileSignals } from './server-profile-runner.mjs';
import { observerSnapshotH1 } from './server-observer-ablation.mjs';

export function observerAblationMeasure(measure = measureServerBrowser) {
  return (browser, origin, adapter, scene, multiplier, observation) => measure(browser, origin, adapter, scene, multiplier, observation,
    { arm: observation.participant === 'right' ? 'H1' : 'H0',
      ...(observation.participant === 'right' ? { snapshotSource: observerSnapshotH1.toString() } : {}) });
}

export async function boundedDiagnostic(promise, timeoutMs = 30_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('diagnostic operation timeout')), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}

export function tracingCompletion(session, timeoutMs = 30_000) {
  let timer, listener;
  const promise = new Promise((resolve, reject) => {
    listener = (event) => { clearTimeout(timer); resolve(event); };
    session.once('Tracing.tracingComplete', listener);
    timer = setTimeout(() => { session.off('Tracing.tracingComplete', listener); reject(new Error('diagnostic trace completion timeout')); }, timeoutMs);
  });
  return { promise, cancel() { clearTimeout(timer); session.off('Tracing.tracingComplete', listener); } };
}

const errorRecord = error => ({ name: error?.name, message: error?.message, stack: error?.stack });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function traceCoverage(events, anchors, id) {
  return anchors.length === 2 && anchors[0].timeOrigin === anchors[1].timeOrigin &&
    anchors[1].startTime > anchors[0].startTime && [id, `${id}-end`].every(name => events.some(event => event.name === name && Number.isFinite(event.ts)));
}

export function tracedBrowserMeasure(out, index, measure = measureServerBrowser) {
  let sequence = 0;
  return async (browser, origin, adapter, scene, workMultiplier = 1, observation = {}) => {
    const id = `diagnostic-${sequence++}-${scene.id}`;
    let session;
    const events = [], anchors = [], errors = [];
    let bytes = 0, overflow = false, startAttempted = false, startAcknowledged = false, terminal = null, sample, failure;
    let completion;
    const collected = ({ value }) => {
      if (overflow) return;
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > 64 * 1024 * 1024) { overflow = true; return; }
      for (const event of value) events.push(event);
    };
    const anchor = async (page, name) => {
      try { anchors.push(await boundedDiagnostic(page.evaluate((name) => {
        const mark = performance.mark(name);
        return { name, startTime: mark.startTime, timeOrigin: performance.timeOrigin };
      }, name))); } catch (error) { errors.push({ phase: 'anchor', error: errorRecord(error) }); }
    };
    try {
      const acquisition = browser.newBrowserCDPSession();
      try { session = await boundedDiagnostic(acquisition); }
      catch (error) {
        acquisition.then(async lateSession => {
          try { await boundedDiagnostic(lateSession.detach()); }
          catch (cleanupError) { writeFileSync(path.join(out, `${id}.late-cleanup.json`), JSON.stringify(errorRecord(cleanupError)), { flag: 'wx' }); }
        }, () => {});
        throw error;
      }
      session.on('Tracing.dataCollected', collected);
      const categories = (await boundedDiagnostic(session.send('Tracing.getCategories'))).categories;
      const requested = ['devtools.timeline', 'v8', 'v8.execute', 'blink.user_timing', 'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile'];
      if (requested.some(category => !categories.includes(category))) throw new Error('diagnostic trace categories unavailable');
      // Subscribe before start; the whole diagnostic sample has a separate hosted deadline.
      completion = tracingCompletion(session, 120_000);
      const settled = completion.promise.then(value => ({ value }), error => ({ error }));
      completion.settled = settled;
      startAttempted = true;
      await boundedDiagnostic(session.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 65536,
        enableSampling: false, includedCategories: requested, excludedCategories: ['*'] } }));
      startAcknowledged = true;
      const observingBrowser = { newContext: async (options) => {
        const context = await browser.newContext(options);
        return { close: async () => {
          try { for (const page of context.pages()) await anchor(page, `${id}-end`); }
          finally { await context.close(); }
        }, newPage: async () => {
          const page = await context.newPage();
          const goto = page.goto.bind(page);
          page.goto = async (...args) => {
            const response = await goto(...args);
            await anchor(page, id);
            return response;
          };
          return page;
        } };
      } };
      sample = await measure(observingBrowser, origin, adapter, scene, workMultiplier);
    } catch (error) { failure = error; errors.push({ phase: 'measurement', error: errorRecord(error) }); }
    finally {
      if (startAttempted) {
        try {
          const [, result] = await boundedDiagnostic(Promise.all([session.send('Tracing.end'), completion.settled]));
          if (result.error) throw result.error;
          terminal = result.value;
        } catch (error) { errors.push({ phase: 'shutdown', error: errorRecord(error) }); failure ??= error; }
      }
      completion?.cancel();
      session?.off('Tracing.dataCollected', collected);
      if (session) try { await boundedDiagnostic(session.detach()); } catch (error) { errors.push({ phase: 'detach', error: errorRecord(error) }); failure ??= error; }
      const complete = startAcknowledged && terminal?.dataLossOccurred === false && !overflow && errors.length === 0 &&
        anchors[0]?.timeOrigin === sample?.measurementTimeOriginMs && traceCoverage(events, anchors, id);
      const trace = { diagnostic: true, qualification: false, id, scene: scene.id, observation, adapterSha256: adapter.sha256,
        workMultiplier, anchors, startAttempted, startAcknowledged, terminal, overflow, complete, errors, traceEvents: events };
      const bytes = JSON.stringify(trace), traceDigest = digest(bytes), file = `${id}.trace.json`;
      writeFileSync(path.join(out, file), bytes, { flag: 'wx' });
      writeFileSync(path.join(out, `${id}.trace.sha256`), traceDigest + '\n', { flag: 'wx' });
      index.push({ id, file, sha256: traceDigest, scene: scene.id, observation, workMultiplier, complete, measurementTimeOriginMs: sample?.measurementTimeOriginMs ?? null });
      if (!complete) failure ??= new Error('diagnostic trace incomplete; partial evidence preserved');
    }
    if (failure) {
      if (sample !== undefined) throw Object.assign(new AggregateError([failure], 'diagnostic failed after completed browser measurement'), { raw: sample, timerEvidence: sample.timerEvidence });
      throw failure;
    }
    return sample;
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseServerProfileArgs(process.argv.slice(2)), index = [];
    const ablation = process.env.PROFILE_OBSERVER_ABLATION === 'true';
    const artifact = await withServerProfileSignals(signal => runServerProfile(options, ablation
      ? { signal, observerAblation: true, browserMeasure: observerAblationMeasure() }
      : { signal, baselineOnlyDiagnostic: true, browserMeasure: tracedBrowserMeasure(options.out, index) }));
    const rows = ['warmup', 'pilot'].flatMap(stage => (artifact[stage]?.rows ?? []).filter(row => row.kind === 'browser').flatMap(row =>
      row.order.map(participant => ({ stage, run: row.run, scene: row.scene, participant, sample: row.samples[participant] }))));
    const manifest = { diagnostic: true, qualification: false, ...(ablation ? { plan: artifact.diagnostic, tracesDisabled: true } : {}), registrationDigest: artifact.registrationDigest,
      rawSha256: digest(readFileSync(path.join(options.out, 'server-profile.json'))),
      traces: index.map(trace => {
        const matching = rows.filter(row => trace.measurementTimeOriginMs !== null && row.scene === trace.scene &&
          row.stage === trace.observation.stage && row.run === trace.observation.run && row.participant === trace.observation.participant &&
          row.sample?.measurementTimeOriginMs === trace.measurementTimeOriginMs);
        return { ...trace, complete: trace.complete && matching.length === 1, matchingRawObservations: matching.length };
      }) };
    writeFileSync(path.join(options.out, 'diagnostic-index.json'), JSON.stringify(manifest), { flag: 'wx' });
    process.stdout.write(JSON.stringify({ diagnostic: true, qualification: false, verdict: artifact.verdict, failures: artifact.failures }) + '\n');
    process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
}
