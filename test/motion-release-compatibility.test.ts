import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import type { FrameLoop } from '../src/frame/index.js';
import { Runtime, type RuntimeHost } from '../src/motion/runtime.js';
import type { MotionOptions, Playback } from '../src/motion/types.js';

// Опубликованная линия совместимости. Новый выпуск обязан сохранять её вызовы.
const RELEASE = 'v0.5.0';

function observe(Engine: typeof Runtime, seed: number) {
  let time = 0;
  const updates = new Set<() => void>(), renders = new Set<() => void>();
  const frame: FrameLoop = {
    read: () => () => {},
    update: cb => { updates.add(cb); return () => { updates.delete(cb); }; },
    render: cb => { renders.add(cb); return () => { renders.delete(cb); }; },
    cancelAll() { updates.clear(); renders.clear(); },
  };
  const styles = new Map<string, string>();
  const element = { style: {
    getPropertyValue: (key: string) => styles.get(key) ?? '',
    setProperty: (key: string, value: string) => { styles.set(key, value); },
  } } as unknown as HTMLElement;
  const host: RuntimeHost = { frame, now: () => time, reduced: () => false,
    styles: () => element.style, supports: () => false };
  const runtime = new Engine(host), controls: Playback[] = [];
  const observations: unknown[] = [];
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const options: MotionOptions = seed % 2 ? { duration: 400, ease: 'linear' } : { spring: { mass: 1, stiffness: 170, damping: 26 } };
  const run = (action: () => unknown) => {
    try { action(); } catch (error) { observations.push([ (error as Error).name, (error as Error).message ]); }
    observations.push({ styles: [...styles], states: controls.map(c => [c.state, c.duration]), subscriptions: updates.size + renders.size });
  };
  run(() => controls.push(runtime.animate(element, { x: 100, y: 40, opacity: [0.2, 1] }, options)));
  for (let i = 0; i < 12; i++) {
    const current = controls.at(-1)!;
    const action = Math.floor(random() * 5);
    run(() => {
      if (action === 0) current.seek(Math.floor(random() * 300));
      else if (action === 1) current.pause();
      else if (action === 2) current.play();
      else if (action === 3) controls.push(runtime.animate(element, { x: Math.floor(random() * 300) - 150 }, options));
      else {
        time += 20;
        for (const callback of [...updates]) callback();
        for (const callback of [...renders]) callback();
      }
    });
  }
  run(() => controls.push(runtime.sequence([
    [element, { x: [0, 50, 10] }, { duration: 200, ease: 'linear' }],
    [element, { width: ['10px', '20px'] }, { at: 100, duration: 200, ease: 'linear' }],
  ])));
  run(() => controls.at(-1)!.seek(150));
  run(() => controls.at(-1)!.finish());
  run(() => runtime.animate(element, { opacity: NaN }));
  run(() => { for (const control of controls) control.stop(); });
  return observations;
}

it('сохраняет опубликованные импорты и поведение прерываемых переходов', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'motion-release-contract-'));
  try {
    const archive = join(directory, 'baseline.tar');
    execFileSync('git', ['archive', '--output', archive, RELEASE, 'src']);
    execFileSync('tar', ['-xf', archive, '-C', directory]);
    const module = join(directory, 'baseline.mjs');
    await build({ entryPoints: [join(directory, 'src/motion/runtime.ts')], outfile: module,
      bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
    const baseline = await import(pathToFileURL(module).href) as { Runtime: typeof Runtime };
    for (let seed = 1; seed <= 128; seed++) expect(observe(Runtime, seed), `seed=`).toEqual(observe(baseline.Runtime, seed));
    const published = JSON.parse(execFileSync('git', ['show', RELEASE + ':package.json'], { encoding: 'utf8' }));
    const current = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    for (const key of ['exports', 'main', 'module', 'types', 'typesVersions', 'engines', 'peerDependencies'])
      expect(current[key], key).toEqual(published[key]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
