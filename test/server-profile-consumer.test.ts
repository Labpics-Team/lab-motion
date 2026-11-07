import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { chromium } from '@playwright/test';
import { buildAdapter, packConsumer, serverParticipantPreparation } from '../bench/profile/server-profile-runner.mjs';
import { prepareBenchmarkCheckout } from '../bench/compare/provenance.mjs';
import { loadServerParticipant } from '../bench/profile/server-profile-consumer.mjs';
import { SERVER_PROFILE, serverProfileStringify } from '../bench/profile/server-profile-registration.mjs';
import { serverBrowserClockBounds } from '../bench/profile/server-profile-contract.mjs';
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

it('classification fault exports both acquired outcomes before deferred failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-classification-'));
  try {
    const source = readFileSync(resolve('test/server-profile-checkpoint.qualification.ts'), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('  const reasons: string[] = [];', source.indexOf('async function checkpointEndpointControl'));
    const end = source.indexOf('\n}', source.indexOf('  return evidence;', begin));
    const owner = readFileSync(resolve('bench/profile/server-profile-runner.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const recordBegin = owner.indexOf('function preserveRawNumbers('), recordEnd = owner.indexOf('function readOptional(', recordBegin);
    const records = runInNewContext('(() => { ' + owner.slice(recordBegin, recordEnd) + ' return { errorRecord, preserveRawNumbers }; })()');
    const evidence = { outcomes: {
      normal: { status: 'resolved', payloads: [{ phase: 'normal-acquired' }], sample: { raw: null } },
      held: { status: 'rejected', payloads: [{ phase: 'held-acquired' }], error: { name: 'Error', message: 'retained' } },
    }, cleanupErrors: [], reasons: [], falseAdmission: false, verdict: 'INCOMPLETE' };
    const envelopes: string[] = [];
    const compiled = esbuild.transformSync('(() => { ' + source.slice(begin, end) + ' })()', { loader: 'ts', target: 'esnext' }).code;
    const exportDirectories: string[] = [];
    const exportControl = (currentEvidence: typeof evidence) => runInNewContext(compiled, {
      evidence: currentEvidence, records, SERVER_PROFILE, count: 3200,
      serverBrowserClockBounds, serverProfileStringify, resolve: () => directory, join, mkdirSync,
      mkdtempSync: (prefix: string) => {
        const created = mkdtempSync(prefix); exportDirectories.push(created); return created;
      }, writeFileSync, readFileSync,
      console: { log: (line: string) => envelopes.push(line) } });
    const result = exportControl(evidence);
    expect(result.verdict).toBe('INCOMPLETE');
    expect(result.classificationError.name).toBe('TypeError');
    expect(result.falseAdmission).toBe(false);
    expect(envelopes).toHaveLength(1);
    const envelope = JSON.parse(envelopes[0]);
    expect(envelope.resourceEvidence).toBe(1);
    expect(envelope.file).toBe('checkpoint-endpoint-control.json');
    expect(exportDirectories).toHaveLength(1);
    const firstFile = join(exportDirectories[0]!, envelope.file);
    expect(envelope.content).toBe(readFileSync(firstFile, 'utf8'));
    const exported = JSON.parse(envelope.content);
    expect(exported.outcomes).toEqual(evidence.outcomes);
    expect(exported.classificationError.name).toBe('TypeError');
    expect(exported.verdict).toBe('INCOMPLETE');
    const secondEvidence = structuredClone(evidence);
    secondEvidence.outcomes.held.error.message = 'second retained';
    const secondResult = exportControl(secondEvidence);
    expect(secondResult.verdict).toBe('INCOMPLETE');
    expect(exportDirectories).toHaveLength(2);
    expect(exportDirectories[1]).not.toBe(exportDirectories[0]);
    expect(envelopes).toHaveLength(2);
    const secondEnvelope = JSON.parse(envelopes[1]);
    const secondFile = join(exportDirectories[1]!, secondEnvelope.file);
    expect(secondEnvelope.content).toBe(readFileSync(secondFile, 'utf8'));
    expect(JSON.parse(secondEnvelope.content).outcomes.held.error.message).toBe('second retained');
    expect(readFileSync(firstFile, 'utf8')).toBe(envelope.content);
    expect(secondEnvelope.content).not.toBe(envelope.content);
    for (const file of [firstFile, secondFile]) {
      expect(() => writeFileSync(file, 'overwrite', { flag: 'wx' })).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    }
    expect(readFileSync(firstFile, 'utf8')).toBe(envelope.content);
    expect(readFileSync(secondFile, 'utf8')).toBe(secondEnvelope.content);
    const assertionsBegin = source.lastIndexOf('\n  if (checkpointDiagnostic) {') + 1;
    const assertionsEnd = source.indexOf('\n  }', assertionsBegin) + 4;
    expect(result.reasons.length).toBeGreaterThan(0);
    let deferredError: unknown;
    try { runInNewContext(source.slice(assertionsBegin, assertionsEnd), { checkpointDiagnostic: result, expect }); }
    catch (error) { deferredError = error; }
    expect(deferredError).toHaveProperty('name', 'AssertionError');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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
}, 120_000);
