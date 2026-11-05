import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildAdapter, measureServerBrowser, packConsumer, serverParticipantPreparation } from '../bench/profile/server-profile-runner.mjs';
import { prepareBenchmarkCheckout } from '../bench/compare/provenance.mjs';
import { loadServerParticipant } from '../bench/profile/server-profile-consumer.mjs';
import { SERVER_PROFILE, serverProfileStringify } from '../bench/profile/server-profile-registration.mjs';
import { serverBrowserClockBounds } from '../bench/profile/server-profile-contract.mjs';
import { startBenchmarkOrigin } from '../bench/compare/bench.mjs';
import { createMotionValueDefaultBenchmark } from '../scripts/bench-support.mjs';

let work = '', baseline = '', candidate = '';
const registeredWorktrees = new Set<string>();
const root = resolve('.');
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'server-packed-consumers-'));
  baseline = join(work, 'baseline'); candidate = join(work, 'candidate');
  execFileSync('pnpm', ['--dir', join(root, 'bench/compare'), 'install', '--frozen-lockfile'], { cwd: root, stdio: 'pipe', timeout: 180_000 });
  for (const [id, directory, sha] of [['baseline', baseline, SERVER_PROFILE.baselineRevision], ['candidate', candidate, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()]] as const) {
    execFileSync('git', ['worktree', 'add', '--detach', directory, sha!], { cwd: root, stdio: 'pipe' });
    registeredWorktrees.add(directory!);
    execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: directory, stdio: 'pipe', timeout: 180_000 });
    rmSync(join(directory!, 'dist'), { recursive: true, force: true });
    const options = serverParticipantPreparation(directory, id);
    expect(options.requiredDist).toEqual(id === 'baseline'
      ? ['dist/animate/index.js', 'dist/index.js']
      : ['dist/animate/index.js', 'dist/motion/index.js', 'dist/driver/index.js']);
    const prepared = prepareBenchmarkCheckout(options);
    expect(prepared.revision).toBe(sha);
    expect(prepared.distRuntime.files).toBeGreaterThan(0);
  }
}, 800_000);
afterAll(() => {
  const failures: unknown[] = [];
  for (const directory of registeredWorktrees) {
    try { execFileSync('git', ['worktree', 'remove', '--force', directory], { cwd: root, stdio: 'pipe' }); }
    catch (error) { failures.push(error); }
  }
  try { if (work) rmSync(work, { recursive: true, force: true }); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'owned packed-consumer cleanup failed');
});

type EndpointReceipt = {
  status: 'endpoint' | 'deadline' | 'cancelled' | 'observer-error'; count: number; positions: number[];
  frameMs: number | null; readClock: { beginMs: number; endMs: number }; timeOriginMs: number;
  error?: { name: string; message: string };
};
type Coordinates = number[] | { encoding: 'repeat'; count: number; value: number } |
  { encoding: 'rle'; count: number; runs: [number, number][] };
type BrowserSample = Awaited<ReturnType<typeof measureServerBrowser>>;
type RecordedError = { name: string; message: string; errors?: RecordedError[]; raw?: unknown; timerEvidence?: unknown };
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
    setupError: undefined as RecordedError | undefined, reasons: [] as string[], falseAdmission: false, verdict: 'INCOMPLETE' };
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
  const expand = (values: Coordinates): number[] => Array.isArray(values) ? values : values.encoding === 'repeat'
    ? Array(values.count).fill(values.value) : values.runs.flatMap(([n, x]) => Array(n).fill(x));
  const allEndpoints = (values: Coordinates) => expand(values).length === count && expand(values).every(x => Number.isFinite(x) && x === SERVER_PROFILE.toPx);
  const reasons: string[] = [];
  const normal = evidence.outcomes.normal, held = evidence.outcomes.held;
  const complete = (outcome: ControlOutcome | undefined): outcome is ControlOutcome & { sample: BrowserSample } => outcome?.status === 'resolved' && outcome.sample !== undefined && outcome.sample.raw.length === SERVER_PROFILE.repetitions &&
    outcome.sample.warmup.length === 1 && [...outcome.sample.warmup, ...outcome.sample.raw].every(row =>
      row.calls === SERVER_PROFILE.browserBatchCalls && row.ownersStarted === row.calls && row.ownersCancelled === row.calls);
  if (!complete(normal)) reasons.push('normal sample не завершён');
  else if (allEndpoints(normal.sample.raw[0].cancelWitness.transformsBefore)) reasons.push('normal cancellation уже на endpoint');
  if (!held || held.armCount !== 1 || held.heldCount !== 1 || held.endpoint?.status !== 'endpoint' ||
    held.endpoint.count !== count || !allEndpoints(held.endpoint.positions) || !held.release?.endpointResolvedBeforeCallbackReturn)
    reasons.push('endpoint antecedent не завершён');
  if (!complete(held)) reasons.push('held rejected/incomplete: отказ не идентифицирован как endpoint guard');
  else {
    const row = held.sample.raw[0];
    if (!held.arm || held.arm.count !== count || held.arm.timeOriginMs !== held.sample.measurementTimeOriginMs ||
      held.arm.armedMs > row.startClock.beginMs) reasons.push('подписка не доказана до trigger');
    if (expand(row.startWitness.leadingPositions).some(x => !Number.isFinite(x) || x >= SERVER_PROFILE.toPx - SERVER_PROFILE.browserSemantics.finalTolerancePx))
      reasons.push('ранний startWitness не до endpoint');
    if (!allEndpoints(row.cancelWitness.transformsBefore) || row.cancelWitness.frames.some(frame => !allEndpoints(frame.transforms)))
      reasons.push('cancel witness не сохранил endpoint');
    if (held.endpoint?.status === 'endpoint' && held.release) {
      if (held.endpoint.timeOriginMs !== held.sample.measurementTimeOriginMs ||
        held.release.realm.timeOriginMs !== held.endpoint.timeOriginMs || held.endpoint.readClock.endMs > row.cancelClock.beginMs)
        reasons.push('realm/order не совпали');
      else {
        try {
          const ordering = serverBrowserClockBounds({ beginMs: held.endpoint.readClock.endMs, endMs: row.cancelClock.beginMs }, held.sample.monotonicHostUpperNs);
          held.ordering = { ...ordering, resolved: ordering.low > 0, causalReceipt: held.release };
        } catch (error) { held.orderingError = records.errorRecord(error); reasons.push('clock order не разрешён'); }
      }
    }
  }
  if (evidence.setupError || evidence.cleanupErrors.length) reasons.push('setup/cleanup не завершён');
  evidence.reasons = reasons;
  evidence.falseAdmission = reasons.length === 0;
  evidence.verdict = evidence.falseAdmission ? 'RED_FALSE_ADMISSION' : 'INCOMPLETE';
  const directory = resolve('scratchpad', 'resource-evidence'); mkdirSync(directory, { recursive: true });
  const file = join(directory, 'checkpoint-endpoint-control.json');
  writeFileSync(file, serverProfileStringify(records.preserveRawNumbers(evidence)) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ resourceEvidence: 1, file: 'checkpoint-endpoint-control.json', content: readFileSync(file, 'utf8') }));
  // Обе руки и ошибки экспортированы до последующих проверок baseline.
  return evidence;
}

it.each(['baseline', 'candidate'] as const)('real clean packed %s binds source, lifecycle and legacy stock C', async (id) => {
  const consumer = join(work, id + '-consumer'); mkdirSync(consumer);
  const source = id === 'baseline' ? baseline : candidate;
  const packed = packConsumer(source, join(work, id + '-package'), join(consumer, 'node_modules'));
  expect(packed.tarballSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(packed.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  const participant = await loadServerParticipant(packed.directory, id);
  expect(participant.lineage.stock.export).toBe(id === 'baseline' ? '.' : './driver');
  for (const entry of [participant.lineage.engine, participant.lineage.stock, participant.lineage.browser]) {
    const path = relative(packed.directory, entry.path);
    expect(path.startsWith('..') || isAbsolute(path)).toBe(false);
  }
  const adapter = await buildAdapter(id, consumer, esbuild, work);
  expect(adapter.participantImports).toEqual(participant.lineage);
  expect(adapter.inputs.length).toBeGreaterThan(0);
  for (const input of adapter.inputs) {
    const path = relative(packed.directory, input);
    expect(path.startsWith('..') || isAbsolute(path)).toBe(false);
  }
  const browser = await chromium.launch({ headless: true });
  let checkpointDiagnostic: Awaited<ReturnType<typeof checkpointEndpointControl>> | undefined;
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: readFileSync(adapter.path, 'utf8') });
    const evidence = await page.evaluate(async () => {
      const A = (window as any).__adapterModule;
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const x = (el: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(el).transform).e;
      const rows = [];
      for (const stagger of [false, true]) {
        let els = Array.from({ length: 3 }, () => document.body.appendChild(document.createElement('div')));
        const start = () => stagger ? A.startStagger(els, 300, 128, 8) : A.start(els, 300, 128);
        // Подписка до действия; rAF наблюдает реальный endpoint, deadline лишь ограничивает отказ.
        const endpoint = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('packed endpoint deadline')), 5000);
          const observe = () => { if (els.every(el => Math.abs(x(el) - 300) < .1)) { clearTimeout(timer); resolve(); } else requestAnimationFrame(observe); };
          requestAnimationFrame(observe);
        });
        const owner = start();
        await endpoint; owner.cancel();
        els.forEach(el => el.remove());
        // Новый lifecycle не подменяет settled registry внешней записью CSS.
        els = Array.from({ length: 3 }, () => document.body.appendChild(document.createElement('div')));
        const onsetSignal = new Promise<number[]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('packed onset deadline')), 5000);
          const observe = () => { const values = els.map(x); if (values.some(value => value > 0 && value < 300)) { clearTimeout(timer); resolve(values); } else requestAnimationFrame(observe); };
          requestAnimationFrame(observe);
        });
        const active = start();
        if (typeof active.finished === 'function') active.finished().catch(() => {});
        const onset = await onsetSignal;
        active.cancel();
        const before = els.map(x); await frame(); await frame();
        rows.push({ onset, before, after: els.map(x), animations: els.map(el => el.getAnimations().length) });
        els.forEach(el => el.remove());
      }
      return rows;
    });
    for (const row of evidence) {
      expect(row.onset.some(value => value > 0 && value < 300)).toBe(true);
      expect(row.after).toEqual(row.before);
      expect(row.animations).toEqual([0, 0, 0]);
    }
    if (id === 'baseline') checkpointDiagnostic = await checkpointEndpointControl(browser, adapter, packed);
  } finally { await browser.close(); }
  const scene = SERVER_PROFILE.engineScenes[2]!;
  const macro = createMotionValueDefaultBenchmark(participant.MotionValue, scene.spring);
  for (const multiplier of [1, 2]) for (let call = 0; call < scene.callsPerRepetition * multiplier; call++) {
    expect(macro.run()).toBe(scene.target); expect(macro.getFrameCount()).toBe(scene.expectedFrames);
  }
  const retention = JSON.parse(execFileSync(process.execPath, ['--expose-gc', resolve('bench/profile/server-profile-retention.mjs'), packed.directory, id], { timeout: 60_000, encoding: 'utf8' }));
  expect(retention.verdict).toBe('COMPLETE');
  expect(retention.lineage).toEqual(participant.lineage);
  expect(retention.rows.map((row: { scene: string }) => row.scene)).toEqual(SERVER_PROFILE.engineScenes.map(scene => scene.id));
  if (checkpointDiagnostic) {
    // Отказы cleanup/macro/retention не маскируются ожидаемым диагностическим RED.
    expect(checkpointDiagnostic.reasons, 'checkpoint control INCOMPLETE').toEqual([]);
    expect(checkpointDiagnostic.falseAdmission, 'accepted endpoint-before-cancel history').toBe(false);
  }
}, 120_000);
