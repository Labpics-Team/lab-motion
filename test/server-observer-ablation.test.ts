import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OBSERVER_ABLATION, observerSnapshotH1 } from '../bench/profile/server-observer-ablation.mjs';
import { observerAblationMeasure } from '../bench/profile/server-profile-diagnostic.mjs';
import { createServerJournal, runServerProfileCalibration } from '../bench/profile/server-profile-runner.mjs';
import { SERVER_PROFILE, serverProfileDigest } from '../bench/profile/server-profile-registration.mjs';
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
      expect(call[6].snapshotSource).toBe(call[5].participant === 'right' ? observerSnapshotH1.toString() : undefined);
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
    expect(validateServerJournal(artifact, chain(events))).toHaveProperty('journalFinalDigest');
    const wrongArm = structuredClone(events);
    wrongArm[2].value.participant = wrongArm[2].value.participant === 'left' ? 'right' : 'left';
    expect(() => validateServerJournal(artifact, chain(wrongArm))).toThrow();
    expect(() => validateServerJournal(artifact, chain(events.filter((event, index) => index !== 2)))).toThrow();
    const lateResource = [...events];
    const blockIndex = lateResource.findLastIndex(event => event.type === 'resources-block');
    const [block] = lateResource.splice(blockIndex, 1);
    lateResource.splice(lateResource.length - 1, 0, block);
    expect(() => validateServerJournal(artifact, chain(lateResource))).toThrow();
  });
  it.each([[], [0], [2, 2, 2], [1, 2, 2, 1], [0, -0, -0, 0], [NaN, NaN, Infinity, -Infinity]].map(values => [values] as const))
  ('preserves every coordinate and DOM read order for %j', values => {
    expect(compactBegin).toBeGreaterThan(0); expect(compactEnd).toBeGreaterThan(compactBegin);
    expect(h0Begin).toBeGreaterThan(0); expect(h0End).toBeGreaterThan(h0Begin);
    const original = observe(h0, values), reduced = observe(observerSnapshotH1.toString(), values);
    expect(reduced.value).toEqual(original.value);
    expect(reduced.reads).toEqual(original.reads);
  });

  it('roundtrips signed-zero coordinates through actual artifact and journal carriers', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'observer-carrier-'));
    try {
      const original = observe(h0, [0, -0, -0, 0]).value;
      const reduced = observe(observerSnapshotH1.toString(), [0, -0, -0, 0]).value;
      expect(reduced).toEqual(original);
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
