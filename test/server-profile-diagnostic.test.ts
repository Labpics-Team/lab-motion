import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runServerProfileCalibration } from '../bench/profile/server-profile-runner.mjs';
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
        .rejects.toThrow('diagnostic trace incomplete');
      expect(context.close).toHaveBeenCalledOnce();
      expect(session.detach).toHaveBeenCalledOnce();
      expect(index[0]).toMatchObject({ complete: false, scene: 's2' });
      const trace = JSON.parse(readFileSync(path.join(out, index[0].file), 'utf8'));
      expect(trace.errors).toHaveLength(2);
      expect(trace.qualification).toBe(false);
      expect(session.listenerCount('Tracing.tracingComplete')).toBe(0);
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
