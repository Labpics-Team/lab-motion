import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { chromium } from '@playwright/test';
import { buildAdapter, packConsumer } from '../bench/profile/server-profile-runner.mjs';
import { loadServerParticipant } from '../bench/profile/server-profile-consumer.mjs';
import { SERVER_PROFILE } from '../bench/profile/server-profile-registration.mjs';
import { createMotionValueDefaultBenchmark } from '../scripts/bench-support.mjs';

let work = '', baseline = '', candidate = '';
const root = resolve('.');
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'server-packed-consumers-'));
  baseline = join(work, 'baseline'); candidate = join(work, 'candidate');
  for (const [directory, sha] of [[baseline, SERVER_PROFILE.baselineRevision], [candidate, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()]]) {
    execFileSync('git', ['worktree', 'add', '--detach', directory, sha!], { cwd: root, stdio: 'pipe' });
    execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: directory, stdio: 'pipe', timeout: 180_000 });
    rmSync(join(directory!, 'dist'), { recursive: true, force: true });
    execFileSync('pnpm', ['build'], { cwd: directory, stdio: 'pipe', timeout: 180_000 });
  }
}, 800_000);
afterAll(() => {
  for (const directory of [baseline, candidate]) if (directory) execFileSync('git', ['worktree', 'remove', '--force', directory], { cwd: root, stdio: 'pipe' });
  if (work) rmSync(work, { recursive: true, force: true });
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
        const els = Array.from({ length: 3 }, () => document.body.appendChild(document.createElement('div')));
        const start = () => stagger ? A.startStagger(els, 300, 128, 8) : A.start(els, 300, 128);
        const owner = start();
        // Подписка до действия; rAF наблюдает реальный endpoint, deadline лишь ограничивает отказ.
        const endpoint = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('packed endpoint deadline')), 5000);
          const observe = () => { if (els.every(el => Math.abs(x(el) - 300) < .1)) { clearTimeout(timer); resolve(); } else requestAnimationFrame(observe); };
          requestAnimationFrame(observe);
        });
        await endpoint; owner.cancel();
        els.forEach(el => { el.style.transform = 'translateX(0px)'; });
        const active = start();
        if (typeof active.finished === 'function') active.finished().catch(() => {});
        const onset = await new Promise<number[]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('packed onset deadline')), 5000);
          const observe = () => { const values = els.map(x); if (values.some(value => value > 0 && value < 300)) { clearTimeout(timer); resolve(values); } else requestAnimationFrame(observe); };
          requestAnimationFrame(observe);
        });
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
