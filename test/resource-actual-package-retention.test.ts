import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
const TSUP_CLI = join(ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js');
const RESOURCE_RUNTIME_EXPORTS = ['./frame', './compositor', './compositor/follow'] as const;

function copyTrackedSource(target: string): void {
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: PACKAGE_COMMAND_TIMEOUT_MS,
  }).split('\0').filter(Boolean);
  for (const relative of tracked) {
    const destination = join(target, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ROOT, relative), destination);
  }
  symlinkSync(
    join(ROOT, 'node_modules'),
    join(target, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function runInstalledPackageProbe(): string {
  const work = mkdtempSync(join(tmpdir(), 'resource-actual-package-'));
  try {
    const source = join(work, 'source');
    mkdirSync(source);
    copyTrackedSource(source);
    // Собираем проверяемые owner-entry и сверяем их байты с полной production-сборкой.
    const packagePath = join(source, 'package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    manifest.exports = Object.fromEntries(RESOURCE_RUNTIME_EXPORTS.map((key) => {
      const value = manifest.exports[key];
      if (value === undefined) throw new Error(`resource proof: missing public export ${key}`);
      return [key, value];
    }));
    writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n');
    execFileSync(process.execPath, [TSUP_CLI], {
      cwd: source,
      stdio: 'pipe',
      timeout: PACKAGE_COMMAND_TIMEOUT_MS,
    });
    for (const relative of [
      'frame/index.js',
      'frame/index.cjs',
      'compositor/index.js',
      'compositor/index.cjs',
      'compositor/follow/index.js',
      'compositor/follow/index.cjs',
    ]) {
      expect(readFileSync(join(source, 'dist', relative))).toEqual(
        readFileSync(join(ROOT, 'dist', relative)),
      );
    }
    execFileSync('pnpm', ['pack', '--pack-destination', work], {
      cwd: source,
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

    const frameSpecifier = `${PACKAGE.name}/frame`;
    const compositorSpecifier = `${PACKAGE.name}/compositor`;
    const followSpecifier = `${PACKAGE.name}/compositor/follow`;
    const probe = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const frameEsm = await import(${JSON.stringify(frameSpecifier)});
const frameCjs = require(${JSON.stringify(frameSpecifier)});
const compositorEsm = await import(${JSON.stringify(compositorSpecifier)});
const compositorCjs = require(${JSON.stringify(compositorSpecifier)});
const followEsm = await import(${JSON.stringify(followSpecifier)});
const followCjs = require(${JSON.stringify(followSpecifier)});
const gc = globalThis.gc;
assert.equal(typeof gc, 'function', '--expose-gc missing');

const retainedOwners = [];

const boundedCacheCase = (mod, label) => {
  const cache = mod.createSpringLinearCache(2);
  assert.equal(cache.capacity, 2, label + ': installed cache capacity drifted');
  cache.compile({ mass: 1, stiffness: 170, damping: 26 });
  cache.compile({ mass: 1, stiffness: 180, damping: 8 });
  cache.compile({ mass: 1, stiffness: 120, damping: 30 });
  assert.equal(cache.size, 2, label + ': installed cache exceeded frozen capacity');
  cache.clear();
  assert.equal(cache.size, 0, label + ': installed cache clear retained entries');
};

boundedCacheCase(compositorEsm, 'compositor-esm');
boundedCacheCase(compositorCjs, 'compositor-cjs');

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
  let animateCalls = 0;
  let cancelCalls = 0;
  let target = {
    marker: label,
    animate: () => {
      animateCalls++;
      return { cancel() { cancelCalls++; } };
    },
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
  assert.equal(animateCalls, 1, label + ': one controller start must own exactly one native effect');
  if (terminal) {
    controller.destroy();
    assert.equal(cancelCalls, 1, label + ': terminal owner must release exactly one native effect');
  } else {
    assert.equal(cancelCalls, 0, label + ': live owner released native effect too early');
  }
  retainedOwners.push(controller);
  target = undefined;
  return ref;
};

const followCase = (mod, label, terminal, pickup, springOwnsTarget = false) => {
  let animateCalls = 0;
  let cancelCalls = 0;
  let effectRef;
  let target = {
    marker: label,
    animate() {
      animateCalls++;
      const effect = { currentTime: 16, target: this, cancel() { cancelCalls++; } };
      effectRef = new WeakRef(effect);
      return effect;
    },
  };
  const targetRef = new WeakRef(target);
  const captured = target;
  const controller = mod.createCompositorFollow({
    spring: { mass: 1, stiffness: 170, damping: 26, ...(springOwnsTarget ? { owner: captured } : {}) },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (value) => captured.marker + ':' + value,
    apply: () => { void captured.marker; },
    now: () => 1,
    requestFrame: () => 1,
  });
  controller.beginFollow(1);
  controller.follow(0.2, 1.02);
  controller.settle(1, 1.02);
  assert.equal(animateCalls, 1, label + ': settle должен создать один native effect');
  assert.equal(cancelCalls, 0, label + ': settle преждевременно освободил native effect');
  if (pickup) controller.beginFollow(1.03);
  assert.equal(cancelCalls, pickup ? 1 : 0, label + ': pickup должен освободить native donor');
  if (terminal) controller.destroy();
  assert.equal(cancelCalls, terminal || pickup ? 1 : 0, label + ': terminal owner должен освободить native effect ровно один раз');
  retainedOwners.push(controller);
  target = undefined;
  return { target: targetRef, effect: effectRef };
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
for (const [mod, format] of [[followEsm, 'esm'], [followCjs, 'cjs']]) {
  for (const pickup of [true, false]) {
    const label = 'follow-' + format + (pickup ? '-pickup' : '-settled');
    const terminal = followCase(mod, label + '-dropped', true, pickup);
    dropped.push(terminal.target, terminal.effect);
    const active = followCase(mod, label + '-live', false, pickup);
    live.push(active.target);
    // Pickup освобождает прежний effect даже у сохранённого живого input-owner.
    (pickup ? dropped : live).push(active.effect);
  }
}
const motionValueCase = (mod, label, springOwnsTarget) => {
  let target = { marker: label };
  const ref = new WeakRef(target);
  const value = mod.handoffToLive({
    spring: { mass: 1, stiffness: 170, damping: 26, ...(springOwnsTarget ? { owner: target } : {}) },
    value: 0,
    velocity: 0,
    requestFrame: () => 1,
  });
  value.destroy();
  retainedOwners.push(value);
  target = undefined;
  return { label, ref };
};

const motionValueTargets = [];
const motionValueNeighbors = [];
for (const [mod, format] of [[compositorEsm, 'esm'], [compositorCjs, 'cjs']]) {
  motionValueTargets.push(motionValueCase(mod, 'motion-value-' + format + '-spring-owner-dropped', true));
  motionValueNeighbors.push(motionValueCase(mod, 'motion-value-' + format + '-plain-spring-dropped', false));
}

const motionValueCallbackCase = (mod, label, kind, terminal) => {
  let target = { marker: label };
  const ref = new WeakRef(target);
  const captureFrame = (owner) => () => { void owner.marker; return 1; };
  const captureListener = (owner) => () => { void owner.marker; };
  const value = mod.handoffToLive({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    value: 0,
    velocity: 0,
    requestFrame: kind === 'requestFrame' ? captureFrame(target) : () => 1,
  });
  if (kind === 'pre-listener') retainedOwners.push(value.onChange(captureListener(target)));
  if (terminal) value.destroy();
  if (kind === 'listener') retainedOwners.push(value.onChange(captureListener(target)));
  retainedOwners.push(value);
  target = undefined;
  return { label, ref };
};
const motionValueCallbackTargets = [];
const motionValueCallbackLive = [];
for (const [mod, format] of [[compositorEsm, 'esm'], [compositorCjs, 'cjs']]) {
  for (const kind of ['requestFrame', 'listener', 'pre-listener']) {
    motionValueCallbackTargets.push(motionValueCallbackCase(mod, 'motion-value-' + format + '-' + kind + '-dropped', kind, true));
    motionValueCallbackLive.push(motionValueCallbackCase(mod, 'motion-value-' + format + '-' + kind + '-live', kind, false));
  }
  motionValueCallbackTargets.push(motionValueCallbackCase(mod, 'motion-value-' + format + '-plain-callback-dropped', 'plain', true));
}

const springTargets = [];
for (const [mod, format] of [[followEsm, 'esm'], [followCjs, 'cjs']]) {
  const label = 'follow-' + format + '-spring-owner-dropped';
  const terminal = followCase(mod, label, true, true, true);
  springTargets.push({ label, ref: terminal.target });
  dropped.push(terminal.effect);
}
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
const retainedSpringTargets = springTargets
  .filter(({ ref }) => ref.deref() !== undefined)
  .map(({ label }) => label);
assert.deepEqual(retainedSpringTargets, [], 'terminal owner удерживает component через spring metadata');
for (const { ref } of motionValueNeighbors) {
  assert.equal(ref.deref(), undefined, 'MotionValue без spring metadata удерживает marker');
}
const retainedMotionValueTargets = motionValueTargets
  .filter(({ ref }) => ref.deref() !== undefined)
  .map(({ label }) => label);
assert.deepEqual(retainedMotionValueTargets, [], 'terminal MotionValue удерживает component через spring metadata');
for (const { label, ref } of motionValueCallbackLive) {
  assert.notEqual(ref.deref(), undefined, label + ': live callback owner собран слишком рано');
}
const retainedCallbackTargets = motionValueCallbackTargets
  .filter(({ ref }) => ref.deref() !== undefined)
  .map(({ label }) => label);
assert.deepEqual(retainedCallbackTargets, [], 'terminal MotionValue удерживает callback owner');
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

it('установленный tarball освобождает ресурсы завершённых владельцев в ESM и CJS', () => {
  expect(runInstalledPackageProbe()).toContain('resource-installed-package-retention: PASS');
}, 120_000);
