import { EventEmitter } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServerJournal, runServerProfileCalibration } from '../bench/profile/server-profile-runner.mjs';
import { boundedDiagnostic, tracedBrowserMeasure, traceCoverage, tracingCompletion } from '../bench/profile/server-profile-diagnostic.mjs';
import { SERVER_PROFILE } from '../bench/profile/server-profile-registration.mjs';

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
    const measure = async (facade: any) => {
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
      const rejected = expect(operation).rejects.toThrow('diagnostic operation timeout');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally { vi.useRealTimers(); }
  });

  it('reports completion timeout without a timing-luck wait', async () => {
    vi.useFakeTimers();
    try {
      const session = new EventEmitter();
      const completion = tracingCompletion(session, 100);
      const rejected = expect(completion.promise).rejects.toThrow('diagnostic trace completion timeout');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(session.listenerCount('Tracing.tracingComplete')).toBe(0);
      completion.cancel();
    } finally { vi.useRealTimers(); }
  });
});
