import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string };
const PACKAGE_COMMAND_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;
const WINDOWS_SHELL = process.platform === 'win32';

function runInstalledPackageProbe(): string {
  const work = mkdtempSync(join(tmpdir(), 'resource-actual-package-'));
  try {
    execFileSync('pnpm', ['build'], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: WINDOWS_SHELL,
      timeout: PACKAGE_COMMAND_TIMEOUT_MS,
    });
    execFileSync('pnpm', ['pack', '--pack-destination', work], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: WINDOWS_SHELL,
      timeout: PACKAGE_COMMAND_TIMEOUT_MS,
    });
    const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
    if (tarball === undefined) throw new Error('pnpm pack не создал tarball');

    const app = join(work, 'consumer');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), JSON.stringify({
      name: 'resource-retention-consumer',
      private: true,
      type: 'module',
    }));
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(work, tarball)],
      {
        cwd: app,
        stdio: 'pipe',
        shell: WINDOWS_SHELL,
        timeout: PACKAGE_COMMAND_TIMEOUT_MS,
      },
    );

    const installedRoot = join(app, 'node_modules', ...PACKAGE.name.split('/'));
    const paths = {
      frameEsm: join(installedRoot, 'dist/frame/index.js'),
      frameCjs: join(installedRoot, 'dist/frame/index.cjs'),
      compositorEsm: join(installedRoot, 'dist/compositor/index.js'),
      compositorCjs: join(installedRoot, 'dist/compositor/index.cjs'),
    };
    for (const [name, path] of Object.entries(paths)) {
      if (!existsSync(path)) throw new Error(`установленный tarball не содержит ${name}: ${path}`);
    }

    const probe = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const frameEsm = await import(pathToFileURL(${JSON.stringify(paths.frameEsm)}).href);
const frameCjs = createRequire(import.meta.url)(${JSON.stringify(paths.frameCjs)});
const compositorEsm = await import(pathToFileURL(${JSON.stringify(paths.compositorEsm)}).href);
const compositorCjs = createRequire(import.meta.url)(${JSON.stringify(paths.compositorCjs)});
const gc = globalThis.gc;
assert.equal(typeof gc, 'function', '--expose-gc missing');

const retainedOwners = [];

const frameCase = (mod, label, terminal) => {
  let payload = { id: label };
  const ref = new WeakRef(payload);
  const hold = (value) => () => { void value.id; };
  let callback = hold(payload);
  const loop = mod.createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(callback);
  if (terminal) off();
  payload = undefined;
  callback = undefined;
  retainedOwners.push(loop, off);
  return ref;
};

const compositorCase = (mod, label, terminal) => {
  let target = {
    marker: label,
    animate: () => ({ cancel() {} }),
  };
  const ref = new WeakRef(target);
  const captured = target;
  const controller = new mod.CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (value) => captured.marker + ':' + value,
    apply: () => { void captured.marker; },
    now: () => 1,
    requestFrame: () => 1,
    setTimer: () => () => {},
  });
  controller.start();
  if (terminal) controller.destroy();
  retainedOwners.push(controller);
  target = undefined;
  return ref;
};

const dropped = [
  frameCase(frameEsm, 'frame-esm-dropped', true),
  frameCase(frameCjs, 'frame-cjs-dropped', true),
  compositorCase(compositorEsm, 'compositor-esm-dropped', true),
  compositorCase(compositorCjs, 'compositor-cjs-dropped', true),
];
const live = [
  frameCase(frameEsm, 'frame-esm-live', false),
  frameCase(frameCjs, 'frame-cjs-live', false),
  compositorCase(compositorEsm, 'compositor-esm-live', false),
  compositorCase(compositorCjs, 'compositor-cjs-live', false),
];
let deliberate = { id: 'deliberate-retention' };
const deliberateRef = new WeakRef(deliberate);
retainedOwners.push(deliberate);
deliberate = undefined;

globalThis.__resourceOwners = retainedOwners;
for (let i = 0; i < 60; i++) {
  await setImmediate();
  gc();
}
for (const ref of dropped) {
  assert.equal(ref.deref(), undefined, 'terminal owner удерживает объект установленного package');
}
for (const ref of live) {
  assert.notEqual(ref.deref(), undefined, 'live-owner control собран слишком рано');
}
assert.notEqual(deliberateRef.deref(), undefined, 'deliberate-retention control не различает strong owner');
console.log('resource-installed-package-retention: PASS');
`;

    const probePath = join(app, 'resource-retention.mjs');
    writeFileSync(probePath, probe);
    return execFileSync(process.execPath, ['--expose-gc', probePath], {
      cwd: app,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

it('установленный tarball освобождает terminal owners в ESM и CJS', () => {
  expect(runInstalledPackageProbe()).toContain('resource-installed-package-retention: PASS');
}, 120_000);
