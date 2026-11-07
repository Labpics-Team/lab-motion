import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServerJournal, runServerProfileCalibration } from '../bench/profile/server-profile-runner.mjs';
import { boundedDiagnostic, tracedBrowserMeasure, traceCoverage, tracingCompletion } from '../bench/profile/server-profile-diagnostic.mjs';
import { SERVER_PROFILE } from '../bench/profile/server-profile-registration.mjs';
import { OBSERVER_ABLATION } from '../bench/profile/server-observer-ablation.mjs';

const cliCases = [
  { mode: undefined, fault: 'one', matches: 1 },
  { mode: 'false', fault: 'zero', matches: 0 },
  { mode: 'TRUE', fault: 'duplicate', matches: 2 },
  { mode: 'false', fault: 'incomplete', matches: 1 },
  { mode: 'true', fault: 'one', matches: 0 },
  { mode: 'false', fault: 'index-exists', matches: 1 },
  { mode: 'true', fault: 'acquisition-error', matches: 0 },
  { mode: 'false', fault: 'bad-args', matches: 0 },
] as const;

describe('actual runner raw-number preservation', () => {
  const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const recordBegin = source.indexOf('function preserveRawNumbers(');
  const recordEnd = source.indexOf('function readOptional(', recordBegin);
  const owner: { preserveRawNumbers: (value: unknown) => unknown; errorRecord: (error: unknown) => unknown } =
    runInContext(`(() => { ${source.slice(recordBegin, recordEnd)} return { preserveRawNumbers, errorRecord }; })()`, createContext({}));

  it.each(['repeat', 'rle'] as const)('preserves %s checkpoints, nested carriers and source containers', (encoding) => {
    const positions = encoding === 'repeat' ? { encoding, count: 3, value: -0 }
      : { encoding, count: 3, runs: Object.freeze([Object.freeze([1, -0]), Object.freeze([2, Infinity])]) };
    const leaves = Object.freeze([NaN, Infinity, -Infinity, -0, undefined, , Object.freeze({ finite: 7 })]);
    const input = Object.freeze({ phase: 'batch-started-before-cancel', repetition: 0, calls: 3,
      startClock: Object.freeze({ beginMs: 1, endMs: 2 }),
      startWitness: Object.freeze({ connectedTargets: 3, leadingAnimations: Object.freeze([0, 1, 2]),
        leadingPositions: Object.freeze(positions), readClock: Object.freeze({ beginMs: 2, endMs: 3 }) }),
      acquiredBatchStartMs: 1, ownersStarted: 3, leaves });
    const descriptors = Object.getOwnPropertyDescriptors(leaves);
    const expected = { ...input, startWitness: { ...input.startWitness, leadingPositions: encoding === 'repeat'
      ? { encoding, count: 3, value: -0 } : { encoding, count: 3, runs: [[1, -0], [2, { nonfinite: 'Infinity' }]] } },
      leaves: [{ nonfinite: 'NaN' }, { nonfinite: 'Infinity' }, { nonfinite: '-Infinity' }, -0, undefined, , { finite: 7 }] };

    const output = owner.preserveRawNumbers(input);

    expect(output).toEqual(expected);
    expect(JSON.stringify(output)).toBe(JSON.stringify(expected));
    expect(output).not.toBe(input);
    const convertedLeaves: unknown = Object.getOwnPropertyDescriptor(output, 'leaves')?.value;
    expect(Array.isArray(convertedLeaves)).toBe(true);
    if (!Array.isArray(convertedLeaves)) throw new Error('missing converted leaves');
    expect(convertedLeaves).not.toBe(leaves);
    expect(Object.is(convertedLeaves[3], -0)).toBe(true);
    expect(Object.hasOwn(convertedLeaves, 4)).toBe(true); expect(Object.hasOwn(convertedLeaves, 5)).toBe(false);
    expect(Object.getOwnPropertyDescriptors(leaves)).toEqual(descriptors);
    expect(input.leaves[0]).toBeNaN(); expect(input.leaves[1]).toBe(Infinity);
    expect(Object.is(input.leaves[3], -0)).toBe(true); expect(Object.hasOwn(input.leaves, 5)).toBe(false);
    expect(input.startWitness.leadingPositions).toBe(positions);
  });

  it('retains own __proto__, entry key order and ignored properties', () => {
    const input = Object.create({ inherited: Infinity });
    Object.defineProperties(input, {
      tail: { enumerable: true, value: NaN },
      ['__proto__']: { enumerable: true, value: Object.freeze({ value: -Infinity }) },
      '10': { enumerable: true, value: Infinity }, '2': { enumerable: true, value: -0 },
      hidden: { get() { throw new Error('non-enumerable read'); } },
      [Symbol('ignored')]: { enumerable: true, get() { throw new Error('symbol read'); } },
    });
    Object.freeze(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);

    const output = owner.preserveRawNumbers(input);

    expect(Object.getPrototypeOf(output)).toBe(Object.getPrototypeOf(owner.preserveRawNumbers({})));
    expect(Object.keys(output ?? {})).toEqual(['2', '10', 'tail', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(output, '__proto__')).toEqual({
      value: { value: { nonfinite: '-Infinity' } }, enumerable: true, writable: true, configurable: true,
    });
    expect(output).toEqual(Object.fromEntries([
      ['2', -0], ['10', { nonfinite: 'Infinity' }], ['tail', { nonfinite: 'NaN' }], ['__proto__', { value: { nonfinite: '-Infinity' } }],
    ]));
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(descriptors);
  });

  it('snapshots sibling getter values before descending into children', () => {
    const reads: string[] = [];
    let sibling = Infinity;
    const child = Object.freeze({ get nested() { reads.push('nested'); sibling = -Infinity; return NaN; } });
    const input = Object.freeze({ get first() { reads.push('first'); return child; },
      get second() { reads.push('second'); return sibling; }, get last() { reads.push('last'); return undefined; } });
    const descriptors = Object.getOwnPropertyDescriptors(input);

    const output = owner.preserveRawNumbers(input);

    expect(reads).toEqual(['first', 'second', 'last', 'nested']);
    expect(output).toEqual({ first: { nested: { nonfinite: 'NaN' } }, second: { nonfinite: 'Infinity' }, last: undefined });
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(descriptors);
  });

  it('retains nonfinite error raw and timer evidence through the actual error recorder', () => {
    const raw = Object.freeze({ partial: Object.freeze([Object.freeze({ acquired: Infinity, cause: undefined })]) });
    const timerEvidence = Object.freeze({ probes: Object.freeze([NaN, -Infinity]) });
    const error = Object.assign(new Error('acquisition failed'), { code: 'EIO', raw, timerEvidence });
    const expected = { name: 'Error', message: 'acquisition failed', code: 'EIO',
      raw: { partial: [{ acquired: { nonfinite: 'Infinity' }, cause: undefined }] },
      timerEvidence: { probes: [{ nonfinite: 'NaN' }, { nonfinite: '-Infinity' }] } };

    const output = owner.errorRecord(error);

    expect(output).toEqual(expected);
    expect(JSON.stringify(output)).toBe(JSON.stringify(expected));
    expect(error.raw).toBe(raw); expect(error.timerEvidence).toBe(timerEvidence);
  });

  it.each([false, true].flatMap(diagnostic => ['success', 'snapshot-throw', 'recursive-throw'].map(phase => ({ diagnostic, phase }))))('converts before actual checkpoint push and receipt: $phase diagnostic=$diagnostic', async ({ diagnostic, phase }) => {
    const reads: string[] = [], partial: unknown[] = [];
    const failure = new Error('getter failure');
    const child = Object.freeze({ get nested() { reads.push('nested'); if (phase === 'recursive-throw') throw failure; return Infinity; } });
    const input = Object.freeze({ get first() { reads.push('first'); return child; },
      get second() { reads.push('second'); if (phase === 'snapshot-throw') throw failure; return NaN; },
      get last() { reads.push('last'); return undefined; } });
    let save: (value: unknown) => unknown = () => { throw new Error('callback not registered'); };
    const callbackBegin = source.indexOf("    await page.exposeFunction('__serverSavePartial',");
    const callbackEnd = source.indexOf('\n    if (!(await page.evaluate', callbackBegin);
    const hostRetention: unknown[] = [];
    let hostNs = 10_000n;
    const realm = createContext({ partial, observationTiming: diagnostic ? { hostRetention } : null,
      process: { hrtime: { bigint: () => { hostNs += 100n; return hostNs; } } },
      page: { exposeFunction: async (_name: string, callback: typeof save) => { save = callback; } } });
    await runInContext(`(async () => { ${source.slice(recordBegin, recordEnd)} ${source.slice(callbackBegin, callbackEnd)} })()`, realm);
    const descriptors = Object.getOwnPropertyDescriptors(input);

    const receipt = Promise.resolve().then(() => save(input));

    if (phase === 'success') {
      await expect(receipt).resolves.toBeUndefined();
      expect(partial).toEqual([{ first: { nested: { nonfinite: 'Infinity' } }, second: { nonfinite: 'NaN' }, last: undefined }]);
      expect(reads).toEqual(['first', 'second', 'last', 'nested']);
    } else {
      await expect(receipt).rejects.toBe(failure);
      expect(partial).toEqual([]);
      expect(reads).toEqual(phase === 'snapshot-throw' ? ['first', 'second'] : ['first', 'second', 'last', 'nested']);
    }
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(descriptors);
    expect(hostRetention).toEqual(!diagnostic ? [] : [phase === 'success'
      ? { phase: undefined, repetition: undefined, beginNs: '10100', convertedNs: '10200', endNs: '10300', outcome: 'retained' }
      : { phase: undefined, repetition: undefined, beginNs: '10100', endNs: '10200', outcome: 'rejected' }]);
    if (!diagnostic) expect(hostNs).toBe(10_000n);
  });
});

describe('настоящий диагностический CLI', () => {
  it.each(cliCases)('mode=$mode acquisition=$fault', ({ mode, fault, matches }) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'diagnostic-cli-'));
    try {
      const cli = path.join(directory, 'server-profile-diagnostic.mjs');
      const shipped = readFileSync(new URL('../bench/profile/server-profile-diagnostic.mjs', import.meta.url));
      writeFileSync(cli, shipped);
      expect(readFileSync(cli)).toEqual(shipped);
      writeFileSync(path.join(directory, 'server-observer-ablation.mjs'),
        readFileSync(new URL('../bench/profile/server-observer-ablation.mjs', import.meta.url)));
      const runnerUrl = new URL('../bench/profile/server-profile-runner.mjs', import.meta.url).href;
      const fixture = readFileSync(new URL('./fixtures/diagnostic-cli-runner.mjs', import.meta.url), 'utf8');
      writeFileSync(path.join(directory, 'server-profile-runner.mjs'), fixture.replace('__REAL_RUNNER_URL__', runnerUrl));
      const indexFile = path.join(directory, 'diagnostic-index.json');
      if (fault === 'index-exists') writeFileSync(indexFile, 'sentinel');
      const env: NodeJS.ProcessEnv = { ...process.env, DIAGNOSTIC_CLI_CASE: fault };
      delete env.PROFILE_OBSERVER_ABLATION;
      if (mode !== undefined) env.PROFILE_OBSERVER_ABLATION = mode;
      const args = ['--baseline', '/fixture/baseline', '--candidate', '/fixture/candidate', '--browser', 'chromium', '--out', directory];
      const result = spawnSync(process.execPath, [cli, ...(fault === 'bad-args' ? [] : args)],
        { env, encoding: 'utf8', timeout: 20_000 });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      if (fault === 'bad-args') {
        expect(result.stdout).toBe('');
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(() => readFileSync(path.join(directory, 'acquisition.json'))).toThrow();
        return;
      }
      const acquisition = JSON.parse(readFileSync(path.join(directory, 'acquisition.json'), 'utf8'));
      expect(acquisition.options).toEqual({ baseline: args[1], candidate: args[3], browser: 'chromium', out: directory });
      expect(acquisition.signal).toBe(true);
      expect(acquisition.observerAblation).toBe(mode === 'true');
      expect(acquisition.baselineOnlyDiagnostic).toBe(mode !== 'true');
      const raw = readFileSync(path.join(directory, 'server-profile.json'));
      expect(raw.toString()).toBe('{ "fixture": true, "partial": false }\n');
      if (fault === 'index-exists' || fault === 'acquisition-error' || fault === 'incomplete') {
        expect(result.stdout).toBe('');
        expect(result.stderr.length).toBeGreaterThan(0);
        if (fault === 'index-exists') {
          expect(result.stderr).toContain('EEXIST');
          expect(readFileSync(indexFile, 'utf8')).toBe('sentinel');
        } else {
          expect(() => readFileSync(indexFile)).toThrow();
          if (fault === 'acquisition-error') expect(result.stderr).toContain('EACQUISITION');
          else {
            const partial = JSON.parse(readFileSync(path.join(directory, 'diagnostic-0-s2.trace.json'), 'utf8'));
            expect(partial.complete).toBe(false);
            expect(partial.qualification).toBe(false);
          }
        }
        return;
      }
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ diagnostic: true, qualification: false,
        verdict: 'UNPROVEN', failures: [{ code: 'DIAGNOSTIC_ONLY' }] });
      const index = JSON.parse(readFileSync(indexFile, 'utf8'));
      expect(index).toMatchObject({ diagnostic: true, qualification: false, registrationDigest: 'a'.repeat(64),
        rawSha256: createHash('sha256').update(raw).digest('hex') });
      if (mode === 'true') {
        expect(index.plan).toEqual(OBSERVER_ABLATION);
        expect(index.tracesDisabled).toBe(true);
        expect(index.traces).toEqual([]);
        expect(acquisition.calls.map((call: any) => call.observation)).toEqual([
          { stage: 'observer-ablation', run: 0, participant: 'left' },
          { stage: 'observer-ablation', run: 0, participant: 'right' },
        ]);
        expect(acquisition.calls[0].observer).toEqual({ arm: 'H0' });
        expect(acquisition.calls[1].observer).toEqual({ arm: 'H1' });
      } else {
        expect(index.plan).toBeUndefined();
        expect(index.tracesDisabled).toBeUndefined();
        expect(index.traces).toHaveLength(1);
        const trace = index.traces[0];
        expect(trace).toMatchObject({ id: 'diagnostic-0-s2', scene: 's2', workMultiplier: 1,
          observation: { stage: 'warmup', run: 0, participant: 'left' },
          matchingRawObservations: matches, complete: matches === 1 });
        const bytes = readFileSync(path.join(directory, trace.file));
        expect(trace.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(readFileSync(path.join(directory, trace.id + '.trace.sha256'), 'utf8').trim()).toBe(trace.sha256);
        expect(JSON.parse(bytes.toString()).complete).toBe(true);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('bounded intrusive baseline diagnostic', () => {
  it('stops after the registered warmup and pilot before power planning or candidate stages', async () => {
    const artifact: any = {};
    const calls: any[] = [];
    const journal = vi.fn();
    const runStage = async (name: string, runs: number) => {
      calls.push([name, runs]);
      return { rows: [], blocks: [] };
    };
    await expect(runServerProfileCalibration(artifact, runStage, journal, { baselineOnlyDiagnostic: true }))
      .rejects.toMatchObject({ code: 'DIAGNOSTIC_ONLY' });
    expect(calls).toEqual([['warmup', SERVER_PROFILE.warmupRuns], ['pilot', SERVER_PROFILE.pilotRuns]]);
    expect(artifact.diagnostic).toMatchObject({ qualification: false });
    expect(artifact.samplePlan).toBeUndefined();
    expect(artifact.aa).toBeUndefined();
    expect(artifact.positive).toBeUndefined();
    expect(artifact.ab).toBeUndefined();
  });

  it('subscribes before triggering completion and releases the listener', async () => {
    const session = new EventEmitter();
    const completion = tracingCompletion(session);
    expect(session.listenerCount('Tracing.tracingComplete')).toBe(1);
    session.emit('Tracing.tracingComplete', { dataLossOccurred: false });
    await expect(completion.promise).resolves.toEqual({ dataLossOccurred: false });
    completion.cancel();
    expect(session.listenerCount('Tracing.tracingComplete')).toBe(0);
  });

  it('preserves partial trace and closes the real context when the observer fails', async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'profile-diagnostic-'));
    const session: any = new EventEmitter();
    session.detach = vi.fn(async () => {});
    session.send = vi.fn(async (method: string) => {
      if (method === 'Tracing.getCategories') return { categories: ['devtools.timeline', 'v8', 'v8.execute', 'blink.user_timing', 'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile'] };
      if (method === 'Tracing.end') session.emit('Tracing.tracingComplete', { dataLossOccurred: false });
      return {};
    });
    const page: any = { goto: vi.fn(async () => ({})), evaluate: vi.fn(async () => { throw new Error('anchor rejected'); }) };
    const context = { newPage: async () => page, pages: () => [page], close: vi.fn(async () => {}) };
    const browser = { newBrowserCDPSession: async () => session, newContext: async () => context };
    const measure = async (facade: any) => {
      const actual = await facade.newContext({});
      const observed = await actual.newPage();
      await observed.goto('http://test.invalid');
      await actual.close();
      return { measurementTimeOriginMs: 1 };
    };
    const index: any[] = [];
    try {
      await expect(tracedBrowserMeasure(out, index, measure)(browser, {}, { sha256: 'a'.repeat(64) }, { id: 's2' }))
        .rejects.toMatchObject({ raw: { measurementTimeOriginMs: 1 } });
      expect(context.close).toHaveBeenCalledOnce();
      expect(session.detach).toHaveBeenCalledOnce();
      expect(index[0]).toMatchObject({ complete: false, scene: 's2' });
      const trace = JSON.parse(readFileSync(path.join(out, index[0].file), 'utf8'));
      expect(trace.errors).toHaveLength(2);
      expect(trace.qualification).toBe(false);
      expect(session.listenerCount('Tracing.tracingComplete')).toBe(0);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it.each(['shutdown', 'detach', 'measurement', 'success', 'trace-write', 'hash-write', 'measurement-trace-write', 'measurement-hash-write'])('journals acquired raw through the actual timing stage for %s', async (phase) => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'profile-diagnostic-'));
    const journalDirectory = path.join(out, 'journal');
    const journal = createServerJournal(journalDirectory);
    const session: any = new EventEmitter();
    session.detach = vi.fn(async () => { if (phase === 'detach') throw new Error('detach rejected'); });
    session.send = vi.fn(async (method: string) => {
      if (method === 'Tracing.getCategories') return { categories: ['devtools.timeline', 'v8', 'v8.execute', 'blink.user_timing', 'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile'] };
      if (method === 'Tracing.end') {
        session.emit('Tracing.tracingComplete', { dataLossOccurred: false });
        if (phase === 'shutdown') throw new Error('stop rejected');
      }
      return {};
    });
    let marks = 0;
    const page: any = { goto: async () => ({}), evaluate: async (_fn: any, name: string) => {
      session.emit('Tracing.dataCollected', { value: [{ name, ts: ++marks }] });
      return { name, timeOrigin: 1, startTime: marks };
    } };
    const context = { newPage: async () => page, pages: () => [page], close: vi.fn(async () => {}) };
    const browser = { newBrowserCDPSession: async () => session, newContext: async () => context };
    const timerEvidence = { probes: [{ phase: 'before', performanceNowDeltasMs: [0.005] }] };
    const sample = { measurementTimeOriginMs: 1, raw: [{ calls: 32, batchCancelMs: 2 }], warmup: [{ calls: 32 }], timerEvidence };
    const acquisitionFailure = Object.assign(new Error('measurement rejected'), { raw: sample, timerEvidence });
    const measure = async (facade: any, _origin: unknown, _adapter: unknown, _scene: unknown, _multiplier: number,
      observation: { stage: string; run: number; participant: string }, diagnosticObserver: unknown) => {
      expect(observation).toMatchObject({ stage: 'warmup', run: 0, participant: 'left' });
      expect(diagnosticObserver).toEqual({ observationTiming: true });
      const actual = await facade.newContext({});
      const observed = await actual.newPage();
      await observed.goto('http://test.invalid');
      await actual.close();
      if (phase.startsWith('measurement')) throw acquisitionFailure;
      return sample;
    };
    const index: any[] = [];
    const publicationFailure = Object.assign(new Error('trace publication rejected'), { code: 'EIO' });
    const publicationPhase = phase.endsWith('write');
    const publish = (file: string, bytes: string, options: { flag: string }) => {
      if (publicationPhase && file.endsWith(phase.endsWith('hash-write') ? '.trace.sha256' : '.trace.json')) throw publicationFailure;
      writeFileSync(file, bytes, options);
    };
    try {
      const source = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      const begin = source.indexOf('    const runStage = async (name, runs) => {');
      const end = source.indexOf('    if (!await runServerProfileCalibration(', begin);
      const recordBegin = source.indexOf('function preserveRawNumbers(');
      const recordEnd = source.indexOf('function readOptional(', recordBegin);
      expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
      expect(recordBegin).toBeGreaterThan(0); expect(recordEnd).toBeGreaterThan(recordBegin);
      const artifact: any = { stages: [] };
      const stageContext = createContext({ artifact, SERVER_PROFILE: { ...SERVER_PROFILE, engineScenes: [], browserScenes: [{ id: 's2' }] },
        verify: () => {}, checkpoint: () => {}, captureServerLoad: () => ({}), serverOrders: () => [['left']],
        engineMeasure: vi.fn(), compactSampleCpuEvidence: vi.fn(), implementations: {}, registrationDigest: 'a'.repeat(64),
        browser, origin: {}, adapters: { baseline: { sha256: 'a'.repeat(64) } },
        browserMeasure: tracedBrowserMeasure(out, index, measure, publish), journal, process: { stderr: { write: () => {} } } });
      const stage = runInContext(`(() => { ${source.slice(recordBegin, recordEnd)} ${source.slice(begin, end)} return runStage; })()`, stageContext);
      const result = stage('warmup', 1);
      if (phase === 'success') {
        const completed = await result;
        expect(completed.rows[0].samples.left).toBe(sample);
      } else {
        await expect(result).rejects.toMatchObject({ raw: sample, timerEvidence });
        if (phase.startsWith('measurement')) {
          await expect(result).rejects.toBe(acquisitionFailure);
          if (publicationPhase) expect((acquisitionFailure as Error & { errors?: Error[] }).errors).toEqual([publicationFailure]);
        }
        expect(artifact.warmup.rows[0].samples.left).toBeUndefined();
      }
      const events = readFileSync(path.join(journalDirectory, 'journal.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(phase === 'success' ? 'sample' : 'failed-sample');
      if (phase === 'success') expect(events[0].value.value).toEqual(sample);
      else {
        expect(events[0].value.partial).toEqual(sample);
        expect(events[0].value.timerEvidence).toEqual(timerEvidence);
        expect(events[0].value.error.raw).toEqual(sample);
        if (publicationPhase) expect(events[0].value.error.errors).toEqual([
          expect.objectContaining({ code: 'EIO' }),
        ]);
      }
      expect(context.close).toHaveBeenCalledOnce();
      expect(session.detach).toHaveBeenCalledOnce();
      expect(session.listenerCount('Tracing.tracingComplete')).toBe(0);
      if (publicationPhase) {
        expect(index).toEqual([]);
        if (!phase.startsWith('measurement')) await expect(result).rejects.toMatchObject({ errors: [publicationFailure] });
      } else {
        expect(index[0].complete).toBe(phase === 'success');
        const trace = JSON.parse(readFileSync(path.join(out, index[0].file), 'utf8'));
        expect(trace.qualification).toBe(false);
        if (phase === 'success') expect(trace.errors).toEqual([]);
        else expect(trace.errors.some((error: any) => error.phase === phase)).toBe(true);
      }
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('requires two actual trace anchors in the same realm', () => {
    const anchors = [{ name: 'x', timeOrigin: 1, startTime: 2 }, { name: 'x-end', timeOrigin: 1, startTime: 3 }];
    expect(traceCoverage([{ name: 'x', ts: 4 }, { name: 'x-end', ts: 5 }], anchors, 'x')).toBe(true);
    expect(traceCoverage([{ name: 'x', ts: 4 }], anchors, 'x')).toBe(false);
  });

  it('bounds a pending stop even if completion already arrived', async () => {
    vi.useFakeTimers();
    try {
      const operation = boundedDiagnostic(Promise.all([new Promise(() => {}), Promise.resolve({})]), 100);
      const rejected = expect(operation).rejects.toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally { vi.useRealTimers(); }
  });

  it('reports completion timeout without a timing-luck wait', async () => {
    vi.useFakeTimers();
    try {
      const session = new EventEmitter();
      const completion = tracingCompletion(session, 100);
      const rejected = expect(completion.promise).rejects.toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(session.listenerCount('Tracing.tracingComplete')).toBe(0);
      completion.cancel();
    } finally { vi.useRealTimers(); }
  });
});
