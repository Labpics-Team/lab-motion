// Граница приобретения данных для теста настоящего диагностического CLI.
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { OBSERVER_ABLATION, observerSnapshotH1 } from './server-observer-ablation.mjs';
export { parseServerProfileArgs, withServerProfileSignals } from '__REAL_RUNNER_URL__';

const calls = [];
export async function measureServerBrowser(browser, origin, adapter, scene, multiplier, observation, observer) {
  calls.push({ scene: scene.id, multiplier, observation, observer });
  if (browser) {
    const context = await browser.newContext({});
    const page = await context.newPage();
    await page.goto('http://fixture.invalid');
    await context.close();
  }
  return { measurementTimeOriginMs: 7, raw: [{ calls: 32, batchCancelMs: 2 }] };
}

export async function runServerProfile(options, dependencies) {
  const fault = process.env.DIAGNOSTIC_CLI_CASE;
  const raw = '{ "fixture": true, "partial": false }\n';
  writeFileSync(path.join(options.out, 'server-profile.json'), raw);
  const receipt = { options, signal: dependencies.signal instanceof AbortSignal,
    observerAblation: dependencies.observerAblation === true,
    baselineOnlyDiagnostic: dependencies.baselineOnlyDiagnostic === true,
    expectedSnapshotSource: observerSnapshotH1.toString(), calls };
  const publishReceipt = () => writeFileSync(path.join(options.out, 'acquisition.json'), JSON.stringify(receipt));
  if (fault === 'acquisition-error') {
    publishReceipt();
    const error = new Error('EACQUISITION');
    error.code = 'EACQUISITION';
    throw error;
  }
  const adapter = { sha256: 'b'.repeat(64) }, scene = { id: 's2' };
  let sample;
  try {
    if (dependencies.observerAblation) {
      for (const participant of ['left', 'right']) {
        sample = await dependencies.browserMeasure(null, {}, adapter, scene, 1,
          { stage: 'observer-ablation', run: 0, participant });
      }
    } else {
      const session = new EventEmitter();
      session.send = async (method) => {
        if (method === 'Tracing.getCategories') return { categories: ['devtools.timeline', 'v8', 'v8.execute', 'blink.user_timing', 'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile'] };
        if (method === 'Tracing.end') session.emit('Tracing.tracingComplete', { dataLossOccurred: false });
        return {};
      };
      session.detach = async () => {};
      let marks = 0;
      const page = { goto: async () => ({}), evaluate: async (_callback, name) => {
        if (fault !== 'incomplete') session.emit('Tracing.dataCollected', { value: [{ name, ts: ++marks }] });
        return { name, timeOrigin: 7, startTime: marks };
      } };
      const context = { newPage: async () => page, pages: () => [page], close: async () => {} };
      const browser = { newBrowserCDPSession: async () => session, newContext: async () => context };
      sample = await dependencies.browserMeasure(browser, {}, adapter, scene, 1,
        { stage: 'warmup', run: 0, participant: 'left' });
    }
  } finally { publishReceipt(); }
  const row = (sceneId = 's2', run = 0, participant = 'left', timeOrigin = 7) =>
    ({ kind: 'browser', scene: sceneId, run, order: [participant], samples: { [participant]: { ...sample, measurementTimeOriginMs: timeOrigin } } });
  const warmup = [], pilot = [];
  if (fault !== 'zero') warmup.push(row());
  if (fault === 'duplicate') warmup.push(row());
  // Одна и та же эпоха часов недостаточна: каждая часть кортежа проверяется отдельно.
  warmup.push(row('s3'), row('s2', 1), row('s2', 0, 'right'), row('s2', 0, 'left', 8));
  pilot.push(row());
  return { verdict: 'UNPROVEN', failures: [{ code: 'DIAGNOSTIC_ONLY' }], registrationDigest: 'a'.repeat(64),
    ...(dependencies.observerAblation ? { diagnostic: OBSERVER_ABLATION } : {}),
    warmup: { rows: warmup }, pilot: { rows: pilot } };
}
