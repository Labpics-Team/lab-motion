import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OBSERVER_ABLATION } from '../bench/profile/server-observer-ablation.mjs';
import { observerAblationMeasure } from '../bench/profile/server-profile-diagnostic.mjs';
import { createServerJournal, runServerProfileCalibration, serverBrowserSnapshot as observerSnapshotH1 } from '../bench/profile/server-profile-runner.mjs';
import { SERVER_PROFILE, serverProfileDigest, serverProfileStringify } from '../bench/profile/server-profile-registration.mjs';
import { parseServerJsonBytes, parseServerJournalBytes, serverArtifactDigest, validateServerJournal, serverStagePlan } from '../bench/profile/server-profile-contract.mjs';

import { writeServerArtifact } from '../bench/profile/server-profile-artifact.mjs';

// Execute the actual H0 source, not a second maintained observer implementation.
const runner = readFileSync(new URL('../bench/profile/server-profile-runner.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compactBegin = runner.indexOf('      const compact = (values) => {');
const compactEnd = runner.indexOf('      const expand =', compactBegin);
const h0Begin = runner.indexOf(': (els) => ({ connectedTargets: els.filter(');
const h0End = runner.indexOf('\n      const cancellationWitness', h0Begin);
const h0 = runner.slice(h0Begin + 2, h0End).trim().replace(/;$/, '');

function observe(source: string, values: number[], fault?: string) {
  const reads: string[] = [];
  const error = new Error('observer boundary');
  const step = (name: string) => { reads.push(name); if (name === fault) throw error; };
  const els = values.map((value, index) => ({
    get isConnected() { step(`connected:${index}`); return index % 2 === 0; },
    getAnimations() { step(`animations:${index}`); return new Array(index); },
    index, value,
  }));
  const context = createContext({ els,
    getComputedStyle(element: any) { step(`style:${element.index}`); return { transform: element }; },
    DOMMatrixReadOnly: class { e: number; constructor(element: any) { step(`matrix:${element.index}`); this.e = element.value; } },
  });
  try { return { value: runInContext(`(() => { ${runner.slice(compactBegin, compactEnd)} return (${source})(els); })()`, context), reads }; }
  catch (thrown) { return { thrown, error, reads }; }
}

function expectPositiveObservation(observation: ReturnType<typeof observe>, values: number[]) {
  expect(observation.thrown).toBeUndefined();
  expect(observation.value).toBeDefined();
  const { connectedTargets, activeWaapi, transforms } = observation.value;
  expect(connectedTargets).toBe(Math.ceil(values.length / 2));
  expect(activeWaapi).toBe(values.reduce((sum, _, index) => sum + index, 0));
  expect(transforms.count).toBe(values.length);
  const coordinates = transforms.encoding === 'repeat'
    ? Array(transforms.count).fill(transforms.value)
    : transforms.runs.flatMap(([count, value]: [number, number]) => Array(count).fill(value));
  expect(coordinates).toHaveLength(values.length);
  expect(coordinates.map((value: number, index: number) => Object.is(value, values[index])))
    .toEqual(values.map(() => true));
  expect(observation.reads).toEqual([
    ...values.map((_, index) => `connected:${index}`),
    ...values.map((_, index) => `animations:${index}`),
    ...values.flatMap((_, index) => [`style:${index}`, `matrix:${index}`]),
  ]);
}

function expectPositiveEquivalence(original: ReturnType<typeof observe>, reduced: ReturnType<typeof observe>, values: number[]) {
  expectPositiveObservation(original, values);
  expectPositiveObservation(reduced, values);
  expect(reduced.value).toEqual(original.value);
}

describe('diagnostic-only three-pass observer', () => {
  it('assigns exactly eight balanced baseline pairs per scene, retains all arms and stops before qualification', async () => {
    const artifact: any = { diagnostic: OBSERVER_ABLATION, stages: [] };
    const load = () => ({ cpuStat: Object.fromEntries(['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'].map(key => [key, 0])), scopes: [] });
    const calls: any[] = [], records: any[] = [];
    const sample = { raw: Array.from({ length: 8 }, (_, repetition) => ({ repetition })), warmup: [{}] };
    const begin = runner.indexOf('    const runStage = async (name, runs) => {');
    const end = runner.indexOf('    if (!await runServerProfileCalibration(', begin);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    const context = createContext({ artifact, SERVER_PROFILE, OBSERVER_ABLATION, verify: () => {}, checkpoint: () => {},
      captureServerLoad: load, serverOrders: () => { throw new Error('qualification order used'); },
      engineMeasure: () => { throw new Error('engine measured'); }, compactSampleCpuEvidence: () => {},
      implementations: {}, registrationDigest: 'a'.repeat(64), browser: {}, origin: {}, adapters: { baseline: { sha256: 'b'.repeat(64) } },
      browserMeasure: observerAblationMeasure(async (...args: any[]) => { calls.push(args); return sample; }),
      journal: (type: string, value: any) => records.push({ type, value }), process: { stderr: { write: () => {} } } });
    const stage = runInContext(`(() => { ${runner.slice(begin, end)} return runStage; })()`, context);
    await expect(runServerProfileCalibration(artifact, stage, () => {}, { observerAblation: true })).rejects.toMatchObject({ code: 'DIAGNOSTIC_ONLY' });
    expect(OBSERVER_ABLATION.orders.filter(order => order[0] === 'left')).toHaveLength(4);
    expect(OBSERVER_ABLATION.orders.filter(order => order[0] === 'right')).toHaveLength(4);
    expect(records.filter(record => record.type === 'sample').map(record => {
      const { value, ...tuple } = record.value; expect(value).toBe(sample); return tuple;
    })).toEqual(serverStagePlan('observer-ablation', 8));
    expect(calls).toHaveLength(32);
    for (const call of calls) {
      expect(call[2]).toBe(context.adapters.baseline);
      expect(call[4]).toBe(1);
      expect(call[6].arm).toBe(call[5].participant === 'left' ? 'H0' : 'H1');
      expect(call[6]).toEqual({ arm: call[5].participant === 'left' ? 'H0' : 'H1' });
    }
    expect(artifact.stages).toEqual(['observer-ablation']);
    for (const name of ['pilot', 'samplePlan', 'aa', 'positive', 'ab']) expect(artifact[name]).toBeUndefined();
    expect(() => serverStagePlan('observer-ablation', 10)).toThrow();
    artifact.registration = { diagnostic: OBSERVER_ABLATION };
    artifact.registrationDigest = serverProfileDigest(artifact.registration);
    artifact.verdict = 'UNPROVEN';
    artifact.failures = [{ stage: 'observer-ablation', error: { code: 'DIAGNOSTIC_ONLY' } }];
    artifact.rawControls = { baseline: { noMotion: true } };
    const events = [
      { type: 'registration-before-any-sample', value: { registration: artifact.registration, digest: artifact.registrationDigest } },
      { type: 'raw-controls-baseline', value: artifact.rawControls.baseline }, ...records,
      { type: 'failure', value: artifact.failures[0] },
      { type: 'finished', value: { verdict: artifact.verdict, digest: serverArtifactDigest(artifact) } },
    ];
    const chain = (items: any[]) => {
      let previous = '0'.repeat(64);
      return items.map(event => { const payload = { sequenceDigest: previous, ...event };
        previous = serverProfileDigest(payload); return { ...payload, digest: previous }; });
    };
    // Replay consumes serialized artifact/journal, not VM prototype identities.
    const storedArtifact = JSON.parse(serverProfileStringify(artifact));
    const storedChain = (items: any[]) => JSON.parse(serverProfileStringify(chain(items)));
    expect(validateServerJournal(storedArtifact, storedChain(events))).toHaveProperty('journalFinalDigest');
    const wrongArm = structuredClone(events);
    wrongArm[2].value.participant = wrongArm[2].value.participant === 'left' ? 'right' : 'left';
    expect(() => validateServerJournal(storedArtifact, storedChain(wrongArm))).toThrow();
    expect(() => validateServerJournal(storedArtifact, storedChain(events.filter((event, index) => index !== 2)))).toThrow();
    const lateResource = [...events];
    const blockIndex = lateResource.findLastIndex(event => event.type === 'resources-block');
    const [block] = lateResource.splice(blockIndex, 1);
    lateResource.splice(lateResource.length - 1, 0, block);
    expect(() => validateServerJournal(storedArtifact, storedChain(lateResource))).toThrow();
  });
  it.each([[], [0], [2, 2, 2], [1, 2, 2, 1], [0, -0, -0, 0], [NaN, NaN, Infinity, -Infinity]].map(values => [values] as const))
  ('preserves every coordinate and DOM read order for %j', values => {
    expect(compactBegin).toBeGreaterThan(0); expect(compactEnd).toBeGreaterThan(compactBegin);
    expect(h0Begin).toBeGreaterThan(0); expect(h0End).toBeGreaterThan(h0Begin);
    const original = observe(h0, values), reduced = observe(observerSnapshotH1.toString(), values);
    expectPositiveEquivalence(original, reduced, values);
  });

  it.each([Array(32).fill(-0), Array(32).fill(NaN), Array.from({ length: 32 }, (_, index) => [0, -0, NaN, Infinity][index % 4])].map(values => [values] as const))(
    'leading collector preserves all32 positions and exact read order for %j', values => {
      const reads: string[] = [], failure = new Error('leading matrix failure');
      const groups = values.map((value, index) => [{ index, value }, { index: -1, value: 999 }]);
      const collect = (fault = -1) => runInContext(`(${observerSnapshotH1.toString()})(groups, true)`, createContext({ groups,
        getComputedStyle(element: { index: number; value: number }) { reads.push(`style:${element.index}`); return { transform: element }; },
        DOMMatrixReadOnly: class { e: number; constructor(element: { index: number; value: number }) {
          reads.push(`matrix:${element.index}`); if (element.index === fault) throw failure; this.e = element.value;
        } },
      }));
      const encoded = collect();
      const expected = observe(h0, values).value.transforms;
      expect(encoded).toEqual(expected);
      expect(encoded.count).toBe(32);
      expect(reads).toEqual(values.flatMap((_, index) => [`style:${index}`, `matrix:${index}`]));
      reads.length = 0;
      expect(() => collect(7)).toThrow(failure);
      expect(reads).toEqual(values.slice(0, 8).flatMap((_, index) => [`style:${index}`, `matrix:${index}`]));
    });

  it('normal runner and both ablation arms acquire leading positions from the same owner', () => {
    const snapshotBegin = runner.indexOf('      const streamingSnapshot ='), snapshotEnd = runner.indexOf('      const cancellationWitness', snapshotBegin);
    const leadingBegin = runner.indexOf('          const leadingPositions ='), leadingEnd = runner.indexOf('\n', leadingBegin);
    expect(snapshotBegin).toBeGreaterThan(0); expect(snapshotEnd).toBeGreaterThan(snapshotBegin);
    expect(leadingBegin).toBeGreaterThan(0);
    const values = Array.from({ length: 32 }, (_, index) => index % 3);
    for (const arm of [undefined, 'H0', 'H1']) {
      const reads: string[] = [], groups = values.map((value, index) => [{ value, index,
        get isConnected() { reads.push(`connected:${index}`); return true; },
        getAnimations() { reads.push(`animations:${index}`); return []; },
      }]);
      const context = createContext({ groups, config: { snapshotSource: observerSnapshotH1.toString(), ...(arm ? { diagnosticObserver: { arm } } : {}) },
        getComputedStyle(element: { value: number; index: number }) { reads.push(`style:${element.index}`); return { transform: element }; },
        DOMMatrixReadOnly: class { e: number; constructor(element: { value: number; index: number }) { reads.push(`matrix:${element.index}`); this.e = element.value; } },
      });
      const observed = runInContext(`(() => { ${runner.slice(compactBegin, compactEnd)} ${runner.slice(snapshotBegin, snapshotEnd)}
        return snapshot(groups.flat()); })()`, context);
      expect(observed).toEqual({ connectedTargets: 32, activeWaapi: 0, transforms: observe(h0, values).value.transforms });
      expect(reads).toEqual([...values.map((_, index) => `connected:${index}`), ...values.map((_, index) => `animations:${index}`),
        ...values.flatMap((_, index) => [`style:${index}`, `matrix:${index}`])]);
      reads.length = 0;
      const positions = runInContext(`(() => { ${runner.slice(compactBegin, compactEnd)} ${runner.slice(snapshotBegin, snapshotEnd)}
        ${runner.slice(leadingBegin, leadingEnd)} return leadingPositions; })()`, context);
      expect(positions).toEqual(observe(h0, values).value.transforms);
      expect(reads).toEqual(values.flatMap((_, index) => [`style:${index}`, `matrix:${index}`]));
    }
  });

  it('rejects unexpected observer failures through the positive equivalence oracle', () => {
    const values = [0, 1, 2];
    const sources = [h0, observerSnapshotH1.toString()];
    const healthy = sources.map(source => observe(source, values));
    expectPositiveEquivalence(healthy[0], healthy[1], values);
    for (const failingArms of [[0], [1], [0, 1]]) {
      const observations = [...healthy];
      for (const arm of failingArms) {
        observations[arm] = observe(sources[arm], values, 'matrix:1');
        expect(observations[arm].thrown).toBe(observations[arm].error);
      }
      expect(() => expectPositiveEquivalence(observations[0], observations[1], values))
        .toThrowError(expect.objectContaining({ name: 'AssertionError' }));
    }
  });

  it('roundtrips signed-zero coordinates through actual artifact and journal carriers', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'observer-carrier-'));
    try {
      const values = [0, -0, -0, 0];
      const originalObservation = observe(h0, values);
      const reducedObservation = observe(observerSnapshotH1.toString(), values);
      expectPositiveEquivalence(originalObservation, reducedObservation, values);
      const original = originalObservation.value, reduced = reducedObservation.value;
      const rawFile = path.join(directory, 'raw.json');
      writeServerArtifact(rawFile, { original, reduced });
      const raw = parseServerJsonBytes(readFileSync(rawFile));
      const journalDirectory = path.join(directory, 'journal');
      createServerJournal(journalDirectory)('observer-control', { original, reduced });
      const records = parseServerJournalBytes(readFileSync(path.join(journalDirectory, 'journal.ndjson')));
      expect(records[0].value).toEqual(raw);
      for (const arm of [raw.original, raw.reduced, records[0].value.original, records[0].value.reduced]) {
        const values = arm.transforms.runs.flatMap(([count, value]: [number, number]) => Array(count).fill(value));
        expect(values.map((value: number, index: number) => Object.is(value, [0, -0, -0, 0][index]))).toEqual([true, true, true, true]);
      }
      const { digest, ...payload } = records[0];
      expect(digest).toBe(serverProfileDigest(payload));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['connected:1', 'animations:1', 'style:1', 'matrix:1'])('stops at the same failing read %s', fault => {
    const original = observe(h0, [1, 2, 3], fault), reduced = observe(observerSnapshotH1.toString(), [1, 2, 3], fault);
    expect(original.thrown).toBe(original.error);
    expect(reduced.thrown).toBe(reduced.error);
    expect(reduced.reads).toEqual(original.reads);
  });
});
