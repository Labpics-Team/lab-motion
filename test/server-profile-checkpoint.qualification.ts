import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildAdapter, measureServerBrowser, packConsumer, serverParticipantPreparation } from '../bench/profile/server-profile-runner.mjs';
import { prepareBenchmarkCheckout } from '../bench/compare/provenance.mjs';
import { SERVER_PROFILE, serverProfileStringify } from '../bench/profile/server-profile-registration.mjs';
import { serverBrowserClockBounds } from '../bench/profile/server-profile-contract.mjs';
import { startBenchmarkOrigin } from '../bench/compare/bench.mjs';

// Физическая квалификация, а не детерминированная проверка корректности или полный допуск PROFILE.
// INCOMPLETE и ложный допуск означают отказ; доказательные данные экспортируются до проверок.
type EndpointReceipt = {
  status: 'endpoint' | 'deadline' | 'cancelled' | 'observer-error'; count: number; positions: number[];
  frameMs: number | null; readClock: { beginMs: number; endMs: number }; timeOriginMs: number;
  error?: { name: string; message: string };
};
type Coordinates = number[] | { encoding: 'repeat'; count: number; value: number } |
  { encoding: 'rle'; count: number; runs: [number, number][] };
type BrowserSample = Awaited<ReturnType<typeof measureServerBrowser>>;
type RecordedError = { name: string; message: string; code?: string; errors?: RecordedError[]; raw?: unknown; timerEvidence?: unknown };
type ControlOutcome = {
  status: 'pending' | 'resolved' | 'rejected'; payloads: unknown[]; armCount: number; heldCount: number;
  sample?: BrowserSample; error?: RecordedError; endpoint?: EndpointReceipt;
  arm?: { count: number; timeOriginMs: number; armedMs: number };
  release?: { endpointResolvedBeforeCallbackReturn: boolean; hostNs: string; realm: { nowMs: number; timeOriginMs: number } };
  ordering?: ReturnType<typeof serverBrowserClockBounds> & { resolved: boolean; causalReceipt: ControlOutcome['release'] };
  orderingError?: RecordedError;
};
type EndpointWindow = Window & { __checkpointControl: {
  arm(): { count: number; timeOriginMs: number; armedMs: number };
  endpoint(): Promise<EndpointReceipt>; dispose(): void;
} };

// Пассивен до arm: подписка в warmup предшествует созданию repetition0.
function installCheckpointEndpoint(config: { count: number; toPx: number }) {
  let frame = 0, timer = 0, nodes: Element[] | undefined, previous: Set<Element>;
  let settled = false, finish: (value: EndpointReceipt) => void;
  let signal: Promise<EndpointReceipt>;
  const stop = () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  const end = (value: EndpointReceipt) => { if (!settled) { settled = true; stop(); finish(value); } };
  const interrupted = (status: 'deadline' | 'cancelled'): EndpointReceipt => ({ status,
    count: nodes?.length ?? 0, positions: [], frameMs: null,
    readClock: { beginMs: performance.now(), endMs: performance.now() }, timeOriginMs: performance.timeOrigin });
  (window as EndpointWindow).__checkpointControl = {
    arm() {
      if (signal) throw new Error('checkpoint endpoint already armed');
      previous = new Set(document.querySelectorAll('.box'));
      signal = new Promise(resolve => { finish = resolve; });
      timer = window.setTimeout(() => end(interrupted('deadline')), 5000);
      const observe = (frameMs: number) => {
        if (settled) return;
        try {
          if (!nodes) {
            const fresh = Array.from(document.querySelectorAll('.box')).filter(el => !previous.has(el) && el.isConnected);
            if (fresh.length === config.count) nodes = fresh;
          }
          if (nodes) {
            const beginMs = performance.now();
            const positions = nodes.map(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).e);
            const endMs = performance.now();
            if (nodes.every(el => el.isConnected) && positions.every(x => Number.isFinite(x) && x === config.toPx)) {
              end({ status: 'endpoint', count: nodes.length, positions, frameMs,
                readClock: { beginMs, endMs }, timeOriginMs: performance.timeOrigin });
              return;
            }
          }
          frame = requestAnimationFrame(observe);
        } catch (error) {
          const value = interrupted('cancelled');
          end({ ...value, status: 'observer-error', error: { name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error) } });
        }
      };
      frame = requestAnimationFrame(observe);
      return { count: previous.size, timeOriginMs: performance.timeOrigin, armedMs: performance.now() };
    },
    endpoint: () => signal,
    dispose: () => { if (signal) end(interrupted('cancelled')); else stop(); },
  };
}

function delegated<T extends object>(target: T, intercept: (key: PropertyKey) => unknown): T {
  return new Proxy(target, { get(real, key) {
    const special = intercept(key);
    if (special !== undefined) return special;
    const value = Reflect.get(real, key, real);
    return typeof value === 'function' ? value.bind(real) : value;
  } });
}

async function checkpointEndpointControl(browser: Browser, adapter: Awaited<ReturnType<typeof buildAdapter>>,
  packed: ReturnType<typeof packConsumer>) {
  const scene = SERVER_PROFILE.browserScenes.find(scene => scene.id === 's2')!;
  const count = scene.targetsPerCall * SERVER_PROFILE.browserBatchCalls;
  // Тот же errorRecord и nonfinite carrier, без нового журнала.
  const ownerSource = readFileSync(resolve('bench/profile/server-profile-runner.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const recordBegin = ownerSource.indexOf('function preserveRawNumbers('), recordEnd = ownerSource.indexOf('function readOptional(', recordBegin);
  if (recordBegin < 0 || recordEnd <= recordBegin) throw new Error('нет существующего errorRecord owner');
  const records = runInNewContext(`(() => { ${ownerSource.slice(recordBegin, recordEnd)} return { errorRecord, preserveRawNumbers }; })()`);
  const evidence = { kind: 'checkpoint-endpoint-control', qualification: false,
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    baselineRevision: SERVER_PROFILE.baselineRevision, tarballSha256: packed.tarballSha256,
    treeSha256: packed.treeSha256, adapterSha256: adapter.sha256, lineage: adapter.participantImports,
    ownerSha256: createHash('sha256').update(ownerSource).digest('hex'), scene, workMultiplier: 1,
    outcomes: {} as Partial<Record<'normal' | 'held', ControlOutcome>>, cleanupErrors: [] as RecordedError[],
    setupError: undefined as RecordedError | undefined, classificationError: undefined as RecordedError | undefined,
    reasons: [] as string[], falseAdmission: false, verdict: 'INCOMPLETE' };
  const contexts: BrowserContext[] = [], pages: Page[] = [];
  let origin: Awaited<ReturnType<typeof startBenchmarkOrigin>> | undefined;
  try {
    origin = await startBenchmarkOrigin();
    for (const mode of ['normal', 'held'] as const) {
      const outcome: ControlOutcome = { status: 'pending', payloads: [], armCount: 0, heldCount: 0 };
      evidence.outcomes[mode] = outcome;
      const facade = delegated(browser, key => key === 'newContext' ? async (options: Parameters<Browser['newContext']>[0]) => {
        const context = await browser.newContext(options); contexts.push(context);
        if (mode === 'held') await context.addInitScript(installCheckpointEndpoint, { count, toPx: SERVER_PROFILE.toPx });
        return delegated(context, key => key === 'newPage' ? async () => {
          const page = await context.newPage(); pages.push(page);
          return delegated(page, key => key === 'exposeFunction' ? async (name: string, originalCallback: (value: Record<string, unknown>) => unknown) => {
            if (name !== '__serverSavePartial') return page.exposeFunction(name, originalCallback);
            return page.exposeFunction(name, async value => {
              await originalCallback(value);
              outcome.payloads.push(records.preserveRawNumbers(value));
              if (mode === 'held' && value.phase === 'warmup' && value.repetition === -1) {
                outcome.armCount++;
                outcome.arm = await page.evaluate(() => (window as EndpointWindow).__checkpointControl.arm());
              }
              if (mode === 'held' && value.phase === 'batch-started-before-cancel' && value.repetition === 0) {
                outcome.heldCount++;
                outcome.endpoint = await page.evaluate(() => (window as EndpointWindow).__checkpointControl.endpoint());
                if (outcome.endpoint.status !== 'endpoint') throw new Error('checkpoint endpoint ' + outcome.endpoint.status);
                outcome.release = { endpointResolvedBeforeCallbackReturn: true,
                  hostNs: process.hrtime.bigint().toString(),
                  realm: await page.evaluate(() => ({ nowMs: performance.now(), timeOriginMs: performance.timeOrigin })) };
              }
            });
          } : undefined);
        } : undefined);
      } : undefined);
      try {
        outcome.sample = await measureServerBrowser(facade, origin, adapter, scene, 1);
        outcome.status = 'resolved';
      } catch (error) { outcome.status = 'rejected'; outcome.error = records.errorRecord(error); }
    }
  } catch (error) { evidence.setupError = records.errorRecord(error); }
  finally {
    for (const page of pages) if (!page.isClosed()) {
      try { await page.evaluate(() => (window as EndpointWindow).__checkpointControl?.dispose()); }
      catch (error) { evidence.cleanupErrors.push(records.errorRecord(error)); }
    }
    for (const context of contexts) if (browser.contexts().includes(context)) {
      try { await context.close(); } catch (error) { evidence.cleanupErrors.push(records.errorRecord(error)); }
    }
    if (origin) try { await origin.close(); } catch (error) { evidence.cleanupErrors.push(records.errorRecord(error)); }
  }
  const reasons: string[] = [];
  try {
    const expand = (values: Coordinates): number[] => Array.isArray(values) ? values : values.encoding === 'repeat'
      ? Array(values.count).fill(values.value) : values.runs.flatMap(([n, x]) => Array(n).fill(x));
    const allEndpoints = (values: Coordinates) => expand(values).length === count && expand(values).every(x => Number.isFinite(x) && x === SERVER_PROFILE.toPx);
    const normal = evidence.outcomes.normal, held = evidence.outcomes.held;
    const completeSample = (sample: BrowserSample | undefined): sample is BrowserSample => sample !== undefined && sample.raw.length === SERVER_PROFILE.repetitions &&
      sample.warmup.length === 1 && [...sample.warmup, ...sample.raw].every(row =>
        row.calls === SERVER_PROFILE.browserBatchCalls && row.ownersStarted === row.calls && row.ownersCancelled === row.calls);
    const complete = (outcome: ControlOutcome | undefined): outcome is ControlOutcome & { sample: BrowserSample } => outcome?.status === 'resolved' && completeSample(outcome.sample);
    const guardCode = 'SERVER_PROFILE_CANCEL_WINDOW_UNPROVEN';
    const guardLeaf = (error: RecordedError | undefined): RecordedError | undefined => error?.name === 'AggregateError' && error.errors?.length === 1 &&
      error.errors[0].name === 'Error' && error.errors[0].code === guardCode && !error.errors[0].errors?.length ? error.errors[0] : undefined;
    const heldGuard = held?.status === 'rejected' ? guardLeaf(held.error) : undefined;
    const heldSample = held?.sample ?? (heldGuard ? held?.error?.raw as BrowserSample | undefined : undefined);
    if (!complete(normal)) reasons.push(guardLeaf(normal?.error) ? 'normal conservative cancellation refusal' : 'normal sample не завершён');
    else if (allEndpoints(normal.sample.raw[0].cancelWitness.transformsBefore)) reasons.push('normal cancellation уже на endpoint');
    if (!held || held.armCount !== 1 || held.heldCount !== 1 || held.endpoint?.status !== 'endpoint' ||
      held.endpoint.count !== count || !allEndpoints(held.endpoint.positions) || !held.release?.endpointResolvedBeforeCallbackReturn)
      reasons.push('endpoint antecedent не завершён');
    if (!held || !completeSample(heldSample) || (held.status !== 'resolved' && !heldGuard)) reasons.push('held rejected/incomplete: отказ не идентифицирован как endpoint guard');
    else {
      const row = heldSample.raw[0];
      if (heldGuard) {
        const raw = heldGuard.raw as { startClock?: typeof row.startClock; cancelClock?: typeof row.cancelClock; cancellationWindow?: ReturnType<typeof serverBrowserClockBounds>; cutoffMs?: number } | undefined;
        const cutoffMs = SERVER_PROFILE.durationMs * (1 - SERVER_PROFILE.browserSemantics.finalTolerancePx / SERVER_PROFILE.toPx);
        const window = serverBrowserClockBounds({ beginMs: row.startClock.beginMs, endMs: row.cancelClock.endMs }, heldSample.monotonicHostUpperNs);
        if (!raw || raw.startClock?.beginMs !== row.startClock.beginMs || raw.startClock.endMs !== row.startClock.endMs ||
          raw.cancelClock?.beginMs !== row.cancelClock.beginMs || raw.cancelClock.endMs !== row.cancelClock.endMs ||
          raw.cutoffMs !== cutoffMs || raw.cancellationWindow?.high !== window.high || window.high < cutoffMs)
          reasons.push('guard leaf не соответствует held repetition0');
      }
      if (!held.arm || held.arm.count !== count || held.arm.timeOriginMs !== heldSample.measurementTimeOriginMs ||
        held.arm.armedMs > row.startClock.beginMs) reasons.push('подписка не доказана до trigger');
      if (expand(row.startWitness.leadingPositions).some(x => !Number.isFinite(x) || x >= SERVER_PROFILE.toPx - SERVER_PROFILE.browserSemantics.finalTolerancePx))
        reasons.push('ранний startWitness не до endpoint');
      if (!allEndpoints(row.cancelWitness.transformsBefore) || row.cancelWitness.frames.some(frame => !allEndpoints(frame.transforms)))
        reasons.push('cancel witness не сохранил endpoint');
      if (held.endpoint?.status === 'endpoint' && held.release) {
        if (held.endpoint.timeOriginMs !== heldSample.measurementTimeOriginMs ||
          held.release.realm.timeOriginMs !== held.endpoint.timeOriginMs || held.endpoint.readClock.endMs > row.cancelClock.beginMs)
          reasons.push('realm/order не совпали');
        else {
          try {
            const ordering = serverBrowserClockBounds({ beginMs: held.endpoint.readClock.endMs, endMs: row.cancelClock.beginMs }, heldSample.monotonicHostUpperNs);
            held.ordering = { ...ordering, resolved: ordering.low > 0, causalReceipt: held.release };
          } catch (error) { held.orderingError = records.errorRecord(error); reasons.push('clock order не разрешён'); }
        }
      }
    }
    if (evidence.setupError || evidence.cleanupErrors.length) reasons.push('setup/cleanup не завершён');
    evidence.reasons = reasons;
    evidence.falseAdmission = reasons.length === 0 && held?.status === 'resolved';
    evidence.verdict = reasons.length ? 'INCOMPLETE' : evidence.falseAdmission ? 'RED_FALSE_ADMISSION' : 'PASS';
  } catch (error) {
    evidence.classificationError = records.errorRecord(error);
    reasons.push('classification не завершена');
    evidence.reasons = reasons;
    evidence.falseAdmission = false;
    evidence.verdict = 'INCOMPLETE';
  }
  const directory = resolve('scratchpad', 'resource-evidence'); mkdirSync(directory, { recursive: true });
  const file = join(directory, 'checkpoint-endpoint-control.json');
  writeFileSync(file, serverProfileStringify(records.preserveRawNumbers(evidence)) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ resourceEvidence: 1, file: 'checkpoint-endpoint-control.json', content: readFileSync(file, 'utf8') }));
  // Обе руки и ошибки экспортированы до последующих проверок baseline.
  return evidence;
}

it('strict physical baseline checkpoint qualification', async () => {
  const root = resolve('.'), work = mkdtempSync(join(tmpdir(), 'server-checkpoint-qualification-'));
  const baseline = join(work, 'baseline');
  let registered = false;
  let browser: Browser | undefined;
  let checkpointDiagnostic: Awaited<ReturnType<typeof checkpointEndpointControl>> | undefined;
  const failures: unknown[] = [];
  try {
    execFileSync('pnpm', ['--dir', join(root, 'bench/compare'), 'install', '--frozen-lockfile'], { cwd: root, stdio: 'pipe', timeout: 180_000 });
    execFileSync('git', ['worktree', 'add', '--detach', baseline, SERVER_PROFILE.baselineRevision], { cwd: root, stdio: 'pipe' });
    registered = true;
    execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: baseline, stdio: 'pipe', timeout: 180_000 });
    rmSync(join(baseline, 'dist'), { recursive: true, force: true });
    const prepared = prepareBenchmarkCheckout(serverParticipantPreparation(baseline, 'baseline'));
    expect(prepared.revision).toBe(SERVER_PROFILE.baselineRevision);
    expect(prepared.distRuntime.files).toBeGreaterThan(0);
    const consumer = join(work, 'baseline-consumer'); mkdirSync(consumer);
    const packed = packConsumer(baseline, join(work, 'baseline-package'), join(consumer, 'node_modules'));
    const adapter = await buildAdapter('baseline', consumer, esbuild, work);
    browser = await chromium.launch({ headless: true });
    checkpointDiagnostic = await checkpointEndpointControl(browser, adapter, packed);
  } catch (error) { failures.push(error); }
  finally {
    try { await browser?.close(); } catch (error) { failures.push(error); }
    if (registered) try { execFileSync('git', ['worktree', 'remove', '--force', baseline], { cwd: root, stdio: 'pipe' }); }
    catch (error) { failures.push(error); }
    try { rmSync(work, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'physical checkpoint qualification failed');
  expect(checkpointDiagnostic).toBeDefined();
  if (checkpointDiagnostic) {
    // Ожидаемый отказ защитной проверки не должен скрывать ошибки очистки.
    expect(checkpointDiagnostic.reasons, 'checkpoint control INCOMPLETE').toEqual([]);
    expect(checkpointDiagnostic.falseAdmission, 'accepted endpoint-before-cancel history').toBe(false);
  }
}, 800_000);
